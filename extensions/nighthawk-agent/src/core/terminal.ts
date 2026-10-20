/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ChatRequest } from './types';

/** Output kept from a command, from its end, since errors are usually printed last. */
const MAX_OUTPUT_CHARS = 12_000;

/** Where a command is asked for or ran: what the model needs to pick the right syntax. */
export interface TerminalContext {
	/** For example "linux", "darwin" or "win32". */
	platform: string;
	/** The shell's name, for example "bash", "zsh" or "pwsh". */
	shell: string;
	cwd?: string;
	/** Commands run before, oldest first. */
	recentCommands: string[];
}

/** A command the model suggests for a request. */
export interface SuggestedCommand {
	command: string;
	explanation: string;
	/** True when the model, or the check here, thinks the command deletes, overwrites or publishes something. */
	risky: boolean;
}

/** A command that failed in the terminal. */
export interface CommandFailure {
	commandLine: string;
	exitCode?: number;
	cwd?: string;
	output: string;
	shell?: string;
}

function describeContext(context: TerminalContext): string {
	const os = context.platform === 'win32' ? 'Windows' : context.platform === 'darwin' ? 'macOS' : context.platform === 'linux' ? 'Linux' : context.platform;
	return [
		`Operating system: ${os}`,
		`Shell: ${context.shell}`,
		context.cwd ? `Current folder: ${context.cwd}` : '',
		context.recentCommands.length ? `Recent commands, oldest first:\n${context.recentCommands.slice(-10).map(c => `- ${c}`).join('\n')}` : '',
	].filter(Boolean).join('\n');
}

/** Builds the request that turns a plain-English request into one shell command. */
export function commandRequest(ask: string, context: TerminalContext): ChatRequest {
	return {
		system: [
			'You turn requests written in plain English into one shell command for the user\'s terminal.',
			'Write the command for the shell and operating system below, using tools that are normally installed there.',
			'Prefer one line; chain steps with the shell\'s own operators when more than one step is needed.',
			'Reply with JSON only, no code fences: {"command": "...", "explanation": "...", "risky": false}',
			'"explanation" is one or two short sentences on what the command does and what any important flags mean.',
			'"risky" is true when the command deletes or overwrites files, rewrites git history, force-pushes, changes system settings, or downloads and runs code.',
			'If the request cannot be done with a command, set "command" to "" and say why in "explanation".',
			'',
			describeContext(context),
		].join('\n'),
		messages: [{ role: 'user', content: [{ type: 'text', text: ask }] }],
		tools: [],
		maxTokens: 600,
	};
}

/**
 * Reads the model's reply to {@link commandRequest}. Models do not always
 * answer in JSON, so a fenced block or a bare line is taken as the command.
 */
export function parseCommandReply(text: string): SuggestedCommand | undefined {
	const trimmed = text.trim();
	const json = /\{[\s\S]*\}/.exec(trimmed)?.[0];
	if (json) {
		try {
			const value = JSON.parse(json) as Partial<Record<keyof SuggestedCommand, unknown>>;
			if (typeof value.command === 'string') {
				const command = value.command.trim();
				return {
					command,
					explanation: typeof value.explanation === 'string' ? value.explanation.trim() : '',
					risky: value.risky === true || isRiskyCommand(command),
				};
			}
		} catch {
			// Not JSON after all; read it as text below.
		}
	}
	const fenced = /```[\w-]*\n(?<body>[\s\S]*?)\n?```/.exec(trimmed);
	const command = (fenced?.groups?.body ?? trimmed.split('\n')[0]).trim().replace(/^\$\s+/, '');
	if (!command) {
		return undefined;
	}
	const explanation = fenced ? trimmed.replace(fenced[0], '').trim() : trimmed.split('\n').slice(1).join('\n').trim();
	return { command, explanation, risky: isRiskyCommand(command) };
}

const RISKY_PATTERNS = [
	/\brm\s+(-\w*[rf]\w*\s+)*-\w*[rf]/,
	/\bsudo\b/,
	/\bdd\s+.*\bof=/,
	/\bmkfs(\.\w+)?\b/,
	/\b(shutdown|reboot|halt)\b/,
	/\bchmod\s+(-R\s+)?777\b/,
	/\bchown\s+-R\b/,
	/\bgit\s+push\b.*(--force\b|-f\b|--force-with-lease\b|--delete\b|\s:\S)/,
	/\bgit\s+reset\s+--hard\b/,
	/\bgit\s+clean\s+-\w*[fdx]/,
	/\bgit\s+checkout\s+(--\s+)?\.(\s|$)/,
	/\bgit\s+branch\s+-D\b/,
	/\b(curl|wget|iwr|Invoke-WebRequest)\b[^|]*\|\s*(sudo\s+)?(ba|z|da)?sh\b/i,
	/\b(iex|Invoke-Expression)\b/i,
	/\bRemove-Item\b.*-Recurse\b/i,
	/\b(rd|rmdir)\s+\/s\b/i,
	/\bdel\s+\/[sfq]\b/i,
	/\bformat\s+[a-z]:/i,
	/\b(drop|truncate)\s+(table|database|schema)\b/i,
	/\bdocker\s+(system\s+prune|rm\s+-f|volume\s+rm)\b/,
	/\bkubectl\s+delete\b/,
	/\bnpm\s+publish\b/,
	/>\s*\/dev\/sd[a-z]/,
	/:\(\)\s*\{\s*:\|:&\s*\};:/,
];

/** True for commands that delete, overwrite or publish things, so they are never run without a second look. */
export function isRiskyCommand(command: string): boolean {
	return RISKY_PATTERNS.some(pattern => pattern.test(command));
}

/** Removes colors and other terminal control sequences from command output. */
export function stripAnsi(text: string): string {
	return text
		.replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
		.replace(/\x1b[@-Z\\-_]/g, '')
		.replace(/\r\n/g, '\n')
		// A carriage return redraws the line, as progress bars do: keep what was drawn last.
		.split('\n').map(line => line.slice(line.lastIndexOf('\r') + 1)).join('\n');
}

/** The end of a command's output, cleaned of control sequences, at most `maxChars` long. */
export function trimOutput(output: string, maxChars = MAX_OUTPUT_CHARS): string {
	const clean = stripAnsi(output).replace(/\n{3,}/g, '\n\n').trim();
	if (clean.length <= maxChars) {
		return clean;
	}
	const tail = clean.slice(clean.length - maxChars);
	return `... (earlier output left out)\n${tail.slice(tail.indexOf('\n') + 1)}`;
}

/** The prompt that asks the agent to explain why a command failed and how to fix it. */
export function explainFailurePrompt(failure: CommandFailure): string {
	const output = trimOutput(failure.output);
	return [
		`This command failed in my terminal${failure.exitCode !== undefined ? ` with exit code ${failure.exitCode}` : ''}${failure.cwd ? `, run in \`${failure.cwd}\`` : ''}${failure.shell ? ` (${failure.shell})` : ''}:`,
		'',
		'```',
		failure.commandLine,
		'```',
		'',
		output ? 'Its output:\n\n```\n' + output + '\n```' : 'It printed nothing.',
		'',
		'Explain in plain words what went wrong and why. Look at the project files when that helps find the cause.',
		'Then give the command or change that fixes it. Do not run commands that change anything or edit files until I say so.',
	].join('\n');
}
