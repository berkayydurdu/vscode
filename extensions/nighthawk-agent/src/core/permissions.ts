/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path';
import { globToRegExp } from './glob';
import type { Tool } from './tools';
import { isInWorkspace, type Workspace } from './workspace';

/**
 * - default: reads run freely; edits, commands and web requests ask first.
 * - acceptEdits: file edits inside the workspace also run freely.
 * - plan: read only; the agent researches and proposes a plan.
 * - bypassPermissions: everything runs without asking.
 */
export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions';

export const PERMISSION_MODES: PermissionMode[] = ['default', 'acceptEdits', 'plan', 'bypassPermissions'];

export type Decision =
	| { behavior: 'allow' }
	| { behavior: 'deny'; reason: string }
	| { behavior: 'ask' };

export interface Rule {
	tool: string;
	spec?: string;
}

/** Parses rules written like Claude Code's: `Bash(npm test:*)`, `Edit(src/**)`, `WebFetch(domain:github.com)`, `mcp__github`. */
export function parseRule(text: string): Rule | undefined {
	const match = /^\s*([\w*.-]+)\s*(?:\((.*)\))?\s*$/s.exec(text);
	if (!match) {
		return undefined;
	}
	return { tool: match[1], spec: match[2]?.trim() || undefined };
}

function toolMatches(rule: Rule, name: string): boolean {
	if (rule.tool === name || rule.tool === '*') {
		return true;
	}
	if (rule.tool.endsWith('*')) {
		return name.startsWith(rule.tool.slice(0, -1));
	}
	// `mcp__server` covers every tool of that server.
	return rule.tool.startsWith('mcp__') && name.startsWith(`${rule.tool}__`);
}

const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write']);

/** True when chaining or redirection could make a matching prefix do something else. */
function hasShellOperators(command: string): boolean {
	return /[;&|><`\n]|\$\(/.test(command);
}

export function ruleMatches(rule: Rule, tool: Tool, input: Record<string, unknown>, workspace: Workspace): boolean {
	const name = tool.spec.name;
	// `Edit` rules cover every file-changing tool, as in Claude Code.
	if (!(toolMatches(rule, name) || (rule.tool === 'Edit' && EDIT_TOOLS.has(name)))) {
		return false;
	}
	if (!rule.spec) {
		return true;
	}
	if (name === 'Bash') {
		const command = String(input.command ?? '').trim();
		if (rule.spec.endsWith(':*')) {
			const prefix = rule.spec.slice(0, -2).trim();
			return (command === prefix || command.startsWith(`${prefix} `)) && !hasShellOperators(command);
		}
		return command === rule.spec;
	}
	if (name === 'WebFetch' && rule.spec.startsWith('domain:')) {
		try {
			const host = new URL(String(input.url)).hostname;
			const domain = rule.spec.slice('domain:'.length);
			return host === domain || host.endsWith(`.${domain}`);
		} catch {
			return false;
		}
	}
	const paths = tool.paths?.(input, workspace) ?? [];
	if (paths.length) {
		const re = globToRegExp(rule.spec.replace(/^\.\//, ''), process.platform === 'win32');
		return paths.every(p => {
			const root = workspace.roots.find(r => isInWorkspace({ ...workspace, roots: [r] }, p)) ?? workspace.roots[0] ?? '';
			const rel = path.isAbsolute(rule.spec!) ? p : path.relative(root, p);
			return re.test(rel.split(path.sep).join('/'));
		});
	}
	return false;
}

/** Commands that only read, so they run without asking. */
const SAFE_COMMAND = /^(ls|pwd|whoami|date|which|echo|cat|head|tail|wc|file|stat|tree|du|df|uname|env|printenv|rg|grep|git (status|diff|log|show|branch|rev-parse|remote|blame|ls-files|describe|tag)|(node|npm|npx|python3?|pip3?|go|cargo|rustc|java|dotnet|ruby|deno|bun|tsc) (--version|-v|-V|version)|npm (ls|list|outdated|view))(\s|$)/;

/**
 * True when every part of a command only reads. Parts may be joined with
 * `&&`, `||`, `;` or `|`; redirects, substitutions and background jobs ask.
 */
export function isSafeCommand(command: string): boolean {
	const parts = command.trim().split(/\s*(?:&&|\|\||;|\|)\s*/);
	return parts.every(part => SAFE_COMMAND.test(part) && !hasShellOperators(part) && !/\s-(exec|delete|fprint)\b/.test(part));
}

export interface PermissionInput {
	tool: Tool;
	input: Record<string, unknown>;
	mode: PermissionMode;
	allow: Rule[];
	deny: Rule[];
	workspace: Workspace;
}

export function decide({ tool, input, mode, allow, deny, workspace }: PermissionInput): Decision {
	const name = tool.spec.name;
	if (deny.some(rule => ruleMatches(rule, tool, input, workspace))) {
		return { behavior: 'deny', reason: `A permission rule blocks ${name} here.` };
	}
	let paths: string[] = [];
	try {
		paths = tool.paths?.(input, workspace) ?? [];
	} catch {
		// Bad input; the tool reports it when it runs.
	}
	const outside = paths.some(p => !isInWorkspace(workspace, p));
	if (mode === 'plan' && (tool.kind === 'edit' || tool.kind === 'execute') && !(name === 'Bash' && isSafeCommand(String(input.command ?? '')))) {
		return { behavior: 'deny', reason: 'Plan mode is read only. Finish researching, then present your plan with ExitPlanMode.' };
	}
	if (allow.some(rule => ruleMatches(rule, tool, input, workspace) && !(EDIT_TOOLS.has(name) && outside && !rule.spec))) {
		return { behavior: 'allow' };
	}
	if (mode === 'bypassPermissions') {
		return { behavior: 'allow' };
	}
	switch (tool.kind) {
		case 'read':
			return outside ? { behavior: 'ask' } : { behavior: 'allow' };
		case 'interact':
		case 'other':
			return { behavior: 'allow' };
		case 'edit':
			return mode === 'acceptEdits' && !outside ? { behavior: 'allow' } : { behavior: 'ask' };
		case 'execute':
			return name === 'Bash' && isSafeCommand(String(input.command ?? '')) ? { behavior: 'allow' } : { behavior: 'ask' };
		default:
			return { behavior: 'ask' };
	}
}

/** The rule "always allow" adds for a call, and how to describe it. */
export function suggestRule(tool: Tool, input: Record<string, unknown>): { rule: string; label: string } {
	const name = tool.spec.name;
	if (name === 'Bash') {
		const command = String(input.command ?? '').trim();
		const words = command.split(/\s+/);
		const prefix = words.length > 1 && /^[a-z][\w:-]*$/i.test(words[1]) ? words.slice(0, 2).join(' ') : words[0];
		if (hasShellOperators(command) || !prefix) {
			return { rule: `Bash(${command})`, label: 'this exact command' };
		}
		return { rule: `Bash(${prefix}:*)`, label: `${prefix} commands` };
	}
	if (EDIT_TOOLS.has(name)) {
		return { rule: 'Edit', label: 'file edits in this workspace' };
	}
	if (name === 'WebFetch') {
		try {
			const host = new URL(String(input.url)).hostname;
			return { rule: `WebFetch(domain:${host})`, label: `requests to ${host}` };
		} catch {
			// Fall through.
		}
	}
	return { rule: name, label: name };
}
