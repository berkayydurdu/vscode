/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Project instructions, skills, slash commands and custom agents, read from
// the same places Claude Code uses (plus .nighthawk/), so existing setups work.

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

/** Reads simple YAML frontmatter: `key: value` lines, lists in [a, b] or `- a` form. */
export function parseFrontmatter(text: string): { data: Record<string, string | string[]>; body: string } {
	const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/.exec(text);
	if (!match) {
		return { data: {}, body: text };
	}
	const data: Record<string, string | string[]> = {};
	let listKey: string | undefined;
	let blockKey: string | undefined;
	const block: string[] = [];
	const endBlock = () => {
		if (blockKey) {
			data[blockKey] = block.join(' ').trim();
			block.length = 0;
			blockKey = undefined;
		}
	};
	for (const line of match[1].split(/\r?\n/)) {
		if (blockKey && /^\s+\S/.test(line)) {
			block.push(line.trim());
			continue;
		}
		endBlock();
		const item = /^\s*-\s+(.*)$/.exec(line);
		if (item && listKey) {
			(data[listKey] as string[]).push(unquote(item[1]));
			continue;
		}
		const pair = /^([\w-]+)\s*:\s*(.*)$/.exec(line);
		if (!pair) {
			continue;
		}
		const [, key, raw] = pair;
		listKey = undefined;
		const value = raw.trim();
		if (!value) {
			data[key] = [];
			listKey = key;
		} else if (value === '>' || value === '|' || value === '>-' || value === '|-') {
			blockKey = key;
		} else if (value.startsWith('[') && value.endsWith(']')) {
			data[key] = value.slice(1, -1).split(',').map(s => unquote(s.trim())).filter(Boolean);
		} else {
			data[key] = unquote(value);
		}
	}
	endBlock();
	return { data, body: text.slice(match[0].length) };
}

function unquote(value: string): string {
	return /^(['"]).*\1$/.test(value) ? value.slice(1, -1) : value;
}

function asString(value: string | string[] | undefined): string {
	return Array.isArray(value) ? value.join(', ') : value ?? '';
}

async function readIfExists(file: string): Promise<string | undefined> {
	try {
		return await fs.readFile(file, 'utf8');
	} catch {
		return undefined;
	}
}

async function listDir(dir: string): Promise<{ name: string; isDirectory: boolean }[]> {
	try {
		return (await fs.readdir(dir, { withFileTypes: true })).map(e => ({ name: e.name, isDirectory: e.isDirectory() || e.isSymbolicLink() }));
	} catch {
		return [];
	}
}

export interface Locations {
	/** Workspace folders, in order. */
	roots: string[];
	/** The user's home folder. */
	home: string;
	/** Whether to read project files that can run code or steer the agent (untrusted workspaces: no). */
	trusted: boolean;
}

/** Folders that hold `skills/`, `commands/` and `agents/`, most specific first. */
function configDirs(loc: Locations): { dir: string; scope: 'project' | 'user' }[] {
	const dirs: { dir: string; scope: 'project' | 'user' }[] = [];
	if (loc.trusted) {
		for (const root of loc.roots) {
			dirs.push({ dir: path.join(root, '.nighthawk'), scope: 'project' }, { dir: path.join(root, '.claude'), scope: 'project' });
		}
	}
	dirs.push({ dir: path.join(loc.home, '.nighthawk'), scope: 'user' }, { dir: path.join(loc.home, '.claude'), scope: 'user' });
	return dirs;
}

export interface InstructionFile {
	file: string;
	text: string;
}

const INSTRUCTION_NAMES = ['AGENTS.md', 'NIGHTHAWK.md', 'CLAUDE.md'];

/** Project and user instructions, like CLAUDE.md for Claude Code. */
export async function loadInstructions(loc: Locations): Promise<InstructionFile[]> {
	const found: InstructionFile[] = [];
	const seen = new Set<string>();
	const add = async (file: string) => {
		const text = await readIfExists(file);
		if (text?.trim()) {
			const key = text.trim();
			// AGENTS.md and CLAUDE.md are often copies of each other.
			if (!seen.has(key)) {
				seen.add(key);
				found.push({ file, text: text.length > 40_000 ? `${text.slice(0, 40_000)}\n[truncated]` : text });
			}
		}
	};
	for (const dir of [path.join(loc.home, '.nighthawk'), path.join(loc.home, '.claude')]) {
		for (const name of INSTRUCTION_NAMES) {
			await add(path.join(dir, name));
		}
	}
	if (loc.trusted) {
		for (const root of loc.roots) {
			for (const name of INSTRUCTION_NAMES) {
				await add(path.join(root, name));
				await add(path.join(root, '.nighthawk', name));
				await add(path.join(root, '.claude', name));
			}
			await add(path.join(root, 'CLAUDE.local.md'));
		}
	}
	return found;
}

export interface Skill {
	name: string;
	description: string;
	file: string;
	dir: string;
	scope: 'project' | 'user';
}

/** Skills are folders with a SKILL.md whose frontmatter has a name and description. */
export async function loadSkills(loc: Locations): Promise<Skill[]> {
	const skills = new Map<string, Skill>();
	for (const { dir, scope } of configDirs(loc)) {
		for (const entry of await listDir(path.join(dir, 'skills'))) {
			if (!entry.isDirectory) {
				continue;
			}
			const skillDir = path.join(dir, 'skills', entry.name);
			const file = path.join(skillDir, 'SKILL.md');
			const text = await readIfExists(file);
			if (!text) {
				continue;
			}
			const { data } = parseFrontmatter(text);
			const name = asString(data.name) || entry.name;
			if (!skills.has(name)) {
				skills.set(name, { name, description: asString(data.description) || '(no description)', file, dir: skillDir, scope });
			}
		}
	}
	return [...skills.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function readSkillBody(skill: Skill): Promise<string> {
	const text = await fs.readFile(skill.file, 'utf8');
	return parseFrontmatter(text).body.trim();
}

export interface Command {
	name: string;
	description: string;
	argumentHint?: string;
	file: string;
	scope: 'project' | 'user';
}

/** Custom slash commands: Markdown prompts in commands/, namespaced by subfolder (`/frontend:review`). */
export async function loadCommands(loc: Locations): Promise<Command[]> {
	const commands = new Map<string, Command>();
	const visit = async (dir: string, prefix: string, scope: 'project' | 'user') => {
		for (const entry of await listDir(dir)) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory) {
				await visit(full, `${prefix}${entry.name}:`, scope);
			} else if (entry.name.endsWith('.md')) {
				const name = prefix + entry.name.slice(0, -3);
				if (commands.has(name)) {
					continue;
				}
				const text = await readIfExists(full) ?? '';
				const { data, body } = parseFrontmatter(text);
				const description = asString(data.description) || body.trim().split(/\r?\n/)[0].replace(/^#+\s*/, '').slice(0, 100);
				commands.set(name, { name, description, argumentHint: asString(data['argument-hint']) || undefined, file: full, scope });
			}
		}
	};
	for (const { dir, scope } of configDirs(loc)) {
		await visit(path.join(dir, 'commands'), '', scope);
	}
	return [...commands.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Fills a command's prompt: $ARGUMENTS, $1..$9. */
export async function expandCommand(command: Command, args: string): Promise<string> {
	const { body } = parseFrontmatter(await fs.readFile(command.file, 'utf8'));
	const positional = args.trim() ? args.trim().split(/\s+/) : [];
	let used = false;
	const text = body.replace(/\$ARGUMENTS|\$(\d)/g, (_match, index?: string) => {
		used = true;
		return index ? positional[Number(index) - 1] ?? '' : args.trim();
	});
	return used || !args.trim() ? text.trim() : `${text.trim()}\n\n${args.trim()}`;
}

export interface AgentDefinition {
	name: string;
	description: string;
	/** Tool names it may use; undefined means all. */
	tools?: string[];
	prompt: string;
	model?: string;
	scope: 'project' | 'user' | 'builtin';
}

export const BUILTIN_AGENTS: AgentDefinition[] = [
	{
		name: 'general-purpose',
		description: 'Researches complex questions, searches code and carries out multi-step tasks. Has every tool except Task.',
		prompt: 'You are a sub-agent. Complete the task you are given, using tools as needed, then reply with a concise report of what you found or did. Include file paths and line numbers that matter. Your final message is returned to the agent that started you.',
		scope: 'builtin',
	},
	{
		name: 'Explore',
		description: 'Fast, read-only codebase exploration: finds files, searches code and answers questions about how things work. Say how thorough to be.',
		tools: ['Read', 'LS', 'Glob', 'Grep', 'CodebaseSearch', 'Bash'],
		prompt: 'You are a read-only exploration sub-agent. Find what the task asks for using CodebaseSearch, Glob, Grep, Read and read-only commands, searching in parallel where you can. Never change files. Reply with a concise answer that cites file paths and line numbers.',
		scope: 'builtin',
	},
	{
		name: 'Plan',
		description: 'Designs an implementation plan for a task: reads the relevant code and returns step-by-step changes with the files involved. Read only.',
		tools: ['Read', 'LS', 'Glob', 'Grep', 'CodebaseSearch', 'Bash', 'WebFetch'],
		prompt: 'You are a software architect sub-agent. Read the relevant code, then return a concrete implementation plan: the steps, the files and functions to change, and the trade-offs. Never change files.',
		scope: 'builtin',
	},
];

/** Custom agents: Markdown files in agents/ with name, description and optional tools and model. */
export async function loadAgents(loc: Locations): Promise<AgentDefinition[]> {
	const agents = new Map<string, AgentDefinition>();
	for (const { dir, scope } of configDirs(loc)) {
		for (const entry of await listDir(path.join(dir, 'agents'))) {
			if (entry.isDirectory || !entry.name.endsWith('.md')) {
				continue;
			}
			const text = await readIfExists(path.join(dir, 'agents', entry.name));
			if (!text) {
				continue;
			}
			const { data, body } = parseFrontmatter(text);
			const name = asString(data.name) || entry.name.slice(0, -3);
			if (agents.has(name)) {
				continue;
			}
			const tools = Array.isArray(data.tools) ? data.tools : asString(data.tools).split(',').map(s => s.trim()).filter(Boolean);
			agents.set(name, {
				name,
				description: asString(data.description) || '(no description)',
				tools: tools.length ? tools : undefined,
				prompt: body.trim(),
				model: asString(data.model) || undefined,
				scope,
			});
		}
	}
	for (const builtin of BUILTIN_AGENTS) {
		if (!agents.has(builtin.name)) {
			agents.set(builtin.name, builtin);
		}
	}
	return [...agents.values()];
}

/** Hook settings from `.nighthawk/settings.json` and `.claude/settings.json` files. */
export async function loadSettingsFiles(loc: Locations): Promise<{ file: string; json: Record<string, unknown> }[]> {
	const files: string[] = [path.join(loc.home, '.nighthawk', 'settings.json'), path.join(loc.home, '.claude', 'settings.json')];
	if (loc.trusted) {
		for (const root of loc.roots) {
			files.push(
				path.join(root, '.nighthawk', 'settings.json'),
				path.join(root, '.claude', 'settings.json'),
				path.join(root, '.claude', 'settings.local.json'),
			);
		}
	}
	const result: { file: string; json: Record<string, unknown> }[] = [];
	for (const file of files) {
		const text = await readIfExists(file);
		if (!text) {
			continue;
		}
		try {
			const json = JSON.parse(text);
			if (json && typeof json === 'object') {
				result.push({ file, json });
			}
		} catch {
			// Ignore broken files.
		}
	}
	return result;
}
