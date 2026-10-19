/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Hooks: shell commands that run at points in the agent loop, configured the
// same way as Claude Code's (`"hooks": { "PreToolUse": [{ "matcher": "Edit|Write", "hooks": [{ "type": "command", "command": "..." }] }] }`).

import { startCommand, type Shell } from './shell';

export type HookEvent = 'PreToolUse' | 'PostToolUse' | 'UserPromptSubmit' | 'Stop' | 'SessionStart';

export const HOOK_EVENTS: HookEvent[] = ['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Stop', 'SessionStart'];

export interface HookMatcher {
	matcher?: string;
	hooks: { type: 'command'; command: string; timeout?: number }[];
}

export type HookConfig = Partial<Record<HookEvent, HookMatcher[]>>;

export interface HookOutcome {
	/** Why the action was blocked; fed back to the model. */
	block?: string;
	/** A PreToolUse hook allowed the call without asking. */
	allow?: boolean;
	/** Text added to the conversation (UserPromptSubmit, SessionStart, PostToolUse). */
	context?: string;
}

/** Merges configs from several places (user settings, project files). */
export function mergeHookConfigs(configs: unknown[]): HookConfig {
	const result: HookConfig = {};
	for (const config of configs) {
		if (!config || typeof config !== 'object') {
			continue;
		}
		for (const event of HOOK_EVENTS) {
			const list = (config as Record<string, unknown>)[event];
			if (Array.isArray(list)) {
				const valid = list.filter((m): m is HookMatcher => !!m && typeof m === 'object' && Array.isArray((m as HookMatcher).hooks));
				(result[event] ??= []).push(...valid);
			}
		}
	}
	return result;
}

function matches(matcher: string | undefined, name: string | undefined): boolean {
	if (!matcher || matcher === '*' || name === undefined) {
		return true;
	}
	try {
		return new RegExp(`^(?:${matcher})$`).test(name);
	} catch {
		return matcher === name;
	}
}

export class Hooks {
	private readonly config: HookConfig;
	private readonly shell: Shell;
	private readonly cwd: string;
	private readonly sessionId: string;

	constructor(config: HookConfig, shell: Shell, cwd: string, sessionId: string) {
		this.config = config;
		this.shell = shell;
		this.cwd = cwd;
		this.sessionId = sessionId;
	}

	has(event: HookEvent): boolean {
		return !!this.config[event]?.length;
	}

	async run(event: HookEvent, payload: Record<string, unknown>, toolName?: string, signal?: AbortSignal): Promise<HookOutcome> {
		const outcome: HookOutcome = {};
		const contexts: string[] = [];
		for (const matcher of this.config[event] ?? []) {
			if (!matches(matcher.matcher, toolName)) {
				continue;
			}
			for (const hook of matcher.hooks) {
				if (hook.type !== 'command' || !hook.command) {
					continue;
				}
				const input = JSON.stringify({ session_id: this.sessionId, hook_event_name: event, cwd: this.cwd, ...payload });
				const running = startCommand(this.shell, hook.command, {
					cwd: this.cwd,
					timeoutMs: (hook.timeout ?? 60) * 1000,
					signal,
					input,
					env: { NIGHTHAWK_PROJECT_DIR: this.cwd, CLAUDE_PROJECT_DIR: this.cwd },
				});
				const stderr: string[] = [];
				running.process.stderr?.on('data', (d: Buffer) => stderr.push(d.toString('utf8')));
				const stdout: string[] = [];
				running.process.stdout?.on('data', (d: Buffer) => stdout.push(d.toString('utf8')));
				const result = await running.done;
				const out = stdout.join('').trim();
				const err = stderr.join('').trim();
				if (result.exitCode === 2) {
					outcome.block = err || out || `A ${event} hook blocked this.`;
					return outcome;
				}
				if (result.exitCode !== 0) {
					continue;
				}
				let json: Record<string, any> | undefined;
				if (out.startsWith('{')) {
					try {
						json = JSON.parse(out);
					} catch {
						json = undefined;
					}
				}
				if (json) {
					const specific = json.hookSpecificOutput ?? {};
					const decision = specific.permissionDecision ?? json.decision;
					const reason = specific.permissionDecisionReason ?? json.reason;
					if (decision === 'deny' || decision === 'block') {
						outcome.block = reason || `A ${event} hook blocked this.`;
						return outcome;
					}
					if (decision === 'allow' || decision === 'approve') {
						outcome.allow = true;
					}
					if (typeof specific.additionalContext === 'string') {
						contexts.push(specific.additionalContext);
					}
				} else if (out && (event === 'UserPromptSubmit' || event === 'SessionStart')) {
					contexts.push(out);
				}
			}
		}
		if (contexts.length) {
			outcome.context = contexts.join('\n');
		}
		return outcome;
	}
}
