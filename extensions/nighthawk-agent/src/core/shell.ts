/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn, type ChildProcess } from 'node:child_process';
import { access } from 'node:fs/promises';
import * as path from 'node:path';

export interface Shell {
	/** bash, zsh, powershell or cmd: told to the model so it writes the right syntax. */
	name: string;
	path: string;
	args(command: string): string[];
}

export function shellFromPath(file: string): Shell {
	const name = path.basename(file).toLowerCase().replace(/\.exe$/, '');
	if (name === 'powershell' || name === 'pwsh') {
		return { name: 'powershell', path: file, args: command => ['-NoProfile', '-NonInteractive', '-Command', command] };
	}
	if (name === 'cmd') {
		return { name: 'cmd', path: file, args: command => ['/d', '/s', '/c', command] };
	}
	return { name, path: file, args: command => ['-c', command] };
}

/**
 * Picks the shell for commands: the configured one, else bash (Git Bash on
 * Windows, so the model's usual commands work), else PowerShell.
 */
async function fileExists(file: string): Promise<boolean> {
	try {
		await access(file);
		return true;
	} catch {
		return false;
	}
}

export async function findShell(configured: string | undefined, platform = process.platform, env = process.env, exists = fileExists): Promise<Shell> {
	if (configured) {
		return shellFromPath(configured);
	}
	if (platform === 'win32') {
		const candidates = [
			path.join(env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'bin', 'bash.exe'),
			path.join(env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Git', 'bin', 'bash.exe'),
			path.join(env.LOCALAPPDATA ?? '', 'Programs', 'Git', 'bin', 'bash.exe'),
		];
		for (const candidate of candidates) {
			if (await exists(candidate)) {
				return shellFromPath(candidate);
			}
		}
		return shellFromPath('powershell.exe');
	}
	const login = env.SHELL;
	if (login && /\/(bash|zsh)$/.test(login) && await exists(login)) {
		return shellFromPath(login);
	}
	return shellFromPath(await exists('/bin/bash') ? '/bin/bash' : '/bin/sh');
}

export interface CommandResult {
	output: string;
	exitCode: number | null;
	timedOut: boolean;
	aborted: boolean;
}

export interface RunningCommand {
	readonly process: ChildProcess;
	readonly done: Promise<CommandResult>;
	kill(): void;
}

/** Environment that keeps commands from waiting on a pager or a prompt. */
function commandEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
	return {
		...process.env,
		GIT_PAGER: 'cat',
		PAGER: 'cat',
		GIT_TERMINAL_PROMPT: '0',
		NIGHTHAWK_AGENT: '1',
		...extra,
	};
}

export function killTree(child: ChildProcess): void {
	if (child.pid === undefined || child.exitCode !== null) {
		return;
	}
	if (process.platform === 'win32') {
		spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => child.kill());
	} else {
		try {
			process.kill(-child.pid, 'SIGTERM');
		} catch {
			child.kill('SIGTERM');
		}
	}
}

export interface StartOptions {
	cwd: string;
	timeoutMs?: number;
	signal?: AbortSignal;
	onOutput?: (chunk: string) => void;
	env?: Record<string, string>;
	/** Text written to stdin; stdin is closed otherwise so prompts fail fast. */
	input?: string;
}

export function startCommand(shell: Shell, command: string, options: StartOptions): RunningCommand {
	const child = spawn(shell.path, shell.args(command), {
		cwd: options.cwd,
		env: commandEnv(options.env),
		stdio: ['pipe', 'pipe', 'pipe'],
		detached: process.platform !== 'win32',
		windowsHide: true,
	});
	child.stdin?.on('error', () => { /* the command may not read stdin */ });
	child.stdin?.end(options.input ?? '');
	let output = '';
	let timedOut = false;
	let aborted = false;
	const onData = (data: Buffer) => {
		const text = data.toString('utf8');
		output += text;
		options.onOutput?.(text);
	};
	child.stdout?.on('data', onData);
	child.stderr?.on('data', onData);
	const timer = options.timeoutMs ? setTimeout(() => {
		timedOut = true;
		killTree(child);
	}, options.timeoutMs) : undefined;
	const onAbort = () => {
		aborted = true;
		killTree(child);
	};
	options.signal?.addEventListener('abort', onAbort, { once: true });
	const done = new Promise<CommandResult>(resolve => {
		const finish = (exitCode: number | null) => {
			if (timer) {
				clearTimeout(timer);
			}
			options.signal?.removeEventListener('abort', onAbort);
			resolve({ output, exitCode, timedOut, aborted });
		};
		child.on('error', err => {
			output += `\n${err.message}`;
			finish(null);
		});
		child.on('close', code => finish(code));
	});
	return { process: child, done, kill: () => killTree(child) };
}

/** Keeps the start and end of long output, which is where errors usually are. */
export function truncateOutput(text: string, max = 30_000): string {
	if (text.length <= max) {
		return text;
	}
	const head = Math.floor(max * 0.3);
	const tail = max - head;
	const omitted = text.length - head - tail;
	return `${text.slice(0, head)}\n\n... [${omitted} characters omitted] ...\n\n${text.slice(-tail)}`;
}
