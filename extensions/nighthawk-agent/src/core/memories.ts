/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Agent memories: short facts the agent saves while working, such as the
// user's preferences or how a project builds, and reads in every later
// conversation. Project memories stay with one workspace; user memories
// go everywhere.

import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

export type MemoryScope = 'project' | 'user';

export interface Memory {
	id: string;
	text: string;
	scope: MemoryScope;
	created: number;
	updated: number;
	/** The conversation that saved it. */
	source?: string;
}

/** Memories kept per scope; the oldest go first beyond this. */
export const MAX_MEMORIES = 100;
/** Characters a memory may have. */
export const MAX_MEMORY_CHARS = 500;

function newId(): string {
	return randomBytes(3).toString('hex');
}

/** Looks like a key, token or password, which is never saved. */
export function looksSecret(text: string): boolean {
	return /\b(sk-[\w-]{16,}|ghp_\w{20,}|github_pat_\w{20,}|xox[abp]-[\w-]{10,}|AKIA[0-9A-Z]{16}|AIza[\w-]{30,})/.test(text)
		|| /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)
		|| /\b(password|passwd|secret|api[_ -]?key|token)\s*[:=]\s*\S{6,}/i.test(text);
}

export function parseMemories(text: string, scope: MemoryScope): Memory[] {
	try {
		const value: unknown = JSON.parse(text);
		if (!Array.isArray(value)) {
			return [];
		}
		return value.flatMap((entry: Partial<Memory>) => typeof entry?.id === 'string' && typeof entry.text === 'string'
			? [{ id: entry.id, text: entry.text, scope, created: Number(entry.created) || 0, updated: Number(entry.updated) || Number(entry.created) || 0, source: typeof entry.source === 'string' ? entry.source : undefined }]
			: []);
	} catch {
		return [];
	}
}

/** One JSON file of memories. Writes go to a temporary file first, so a crash never leaves half a file. */
export class MemoryFile {
	readonly file: string;
	readonly scope: MemoryScope;
	private cache: Memory[] | undefined;
	private writing: Promise<void> = Promise.resolve();

	constructor(file: string, scope: MemoryScope) {
		this.file = file;
		this.scope = scope;
	}

	async list(): Promise<Memory[]> {
		if (!this.cache) {
			try {
				this.cache = parseMemories(await readFile(this.file, 'utf8'), this.scope);
			} catch {
				this.cache = [];
			}
		}
		return [...this.cache];
	}

	/** Forgets what was read, for when another window changed the file. */
	reload(): void {
		this.cache = undefined;
	}

	private async save(memories: Memory[]): Promise<void> {
		this.cache = memories;
		const write = async () => {
			await mkdir(path.dirname(this.file), { recursive: true });
			const temp = `${this.file}.${newId()}.tmp`;
			await writeFile(temp, `${JSON.stringify(memories.map(m => ({ id: m.id, text: m.text, created: m.created, updated: m.updated, source: m.source })), null, '\t')}\n`);
			await rename(temp, this.file);
		};
		this.writing = this.writing.then(write, write);
		await this.writing;
	}

	async add(text: string, source?: string, now = Date.now()): Promise<Memory> {
		const memories = await this.list();
		const memory: Memory = { id: newId(), text: cleanMemory(text), scope: this.scope, created: now, updated: now, source };
		// The same fact again only refreshes it.
		const same = memories.find(m => m.text.toLowerCase() === memory.text.toLowerCase());
		if (same) {
			same.updated = now;
			await this.save(memories);
			return same;
		}
		memories.push(memory);
		await this.save(memories.slice(-MAX_MEMORIES));
		return memory;
	}

	async update(id: string, text: string, now = Date.now()): Promise<Memory | undefined> {
		const memories = await this.list();
		const memory = memories.find(m => m.id === id);
		if (!memory) {
			return undefined;
		}
		memory.text = cleanMemory(text);
		memory.updated = now;
		await this.save(memories);
		return memory;
	}

	async remove(id: string): Promise<boolean> {
		const memories = await this.list();
		const kept = memories.filter(m => m.id !== id);
		if (kept.length === memories.length) {
			return false;
		}
		await this.save(kept);
		return true;
	}

	async clear(): Promise<void> {
		await this.save([]);
	}
}

/** One line, trimmed and cut to the size limit. */
export function cleanMemory(text: string): string {
	const line = text.replace(/\s+/g, ' ').trim();
	return line.length > MAX_MEMORY_CHARS ? `${line.slice(0, MAX_MEMORY_CHARS - 3)}...` : line;
}

/** The system prompt section that gives the agent its memories and says when to save new ones. */
export function memoriesPrompt(memories: Memory[]): string {
	const list = (scope: MemoryScope) => memories.filter(m => m.scope === scope).map(m => `- [${m.id}] ${m.text}`);
	const project = list('project');
	const user = list('user');
	return [
		'# Memories',
		'Facts saved in earlier conversations with the Memory tool. Use them, but trust what you see in the code and what the user says now when they disagree.',
		...(user.length ? ['', 'About the user (all projects):', ...user] : []),
		...(project.length ? ['', 'About this project:', ...project] : []),
		...(!user.length && !project.length ? ['', '(none yet)'] : []),
		'',
		'Save a memory when the user states a preference about how you should work, corrects you in a way that applies beyond this task, or you learn a project fact that is hard to find again (how to build or test, a gotcha, where something lives) and a later conversation would need. One short sentence each. Never save secrets, things AGENTS.md already says, or details that only matter for the current task. Update or delete a memory that turns out wrong or outdated, by its id.',
	].join('\n');
}
