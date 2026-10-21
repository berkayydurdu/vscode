/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The agent's built-in tools. Names and inputs follow Claude Code's, so
// skills and prompts written for it work here, and models know them well.

import { execFile } from 'node:child_process';
import * as path from 'node:path';
import { diffLines } from './diff';
import { globToRegExp, SKIPPED_DIRS } from './glob';
import { formatResults, type SearchOptions, type SearchResult } from './indexing';
import { looksSecret, type MemoryScope } from './memories';
import { startCommand, truncateOutput, type RunningCommand, type Shell } from './shell';
import type { Question, Todo, ToolDisplay } from './protocol';
import type { ToolSpec } from './types';
import { displayPath, isInWorkspace, pathKey, resolvePath, type Workspace } from './workspace';

/** How a tool call is gated: reads run freely, the rest may need approval. */
export type ToolKind = 'read' | 'edit' | 'execute' | 'network' | 'interact' | 'other';

export interface ToolResult {
	content: string;
	isError?: boolean;
	images?: { mediaType: string; data: string }[];
	/** What the transcript shows, when different from what the model sees. */
	display?: ToolDisplay;
	/** A few words for the card header, like "120 lines" or "exit 1". */
	summary?: string;
}

export interface BackgroundShell {
	id: string;
	command: string;
	running: RunningCommand;
	output: string;
	readOffset: number;
	exitCode?: number | null;
	finished: boolean;
}

/** State that lives as long as a conversation. */
export class SessionState {
	/** Content hash of each file as the agent last read or wrote it. */
	readonly readFiles = new Map<string, string>();
	todos: Todo[] = [];
	readonly shells = new Map<string, BackgroundShell>();
	private nextShell = 1;

	newShellId(): string {
		return `shell_${this.nextShell++}`;
	}

	dispose(): void {
		for (const shell of this.shells.values()) {
			shell.running.kill();
		}
		this.shells.clear();
	}
}

export interface SkillInfo {
	name: string;
	description: string;
	file: string;
}

export interface ToolContext {
	workspace: Workspace;
	state: SessionState;
	signal: AbortSignal;
	/** The id of the call being run. */
	callId?: string;
	shell: Shell;
	/** ripgrep, when available, for fast searches that honor .gitignore. */
	ripgrep?: string;
	/** Streams partial output to the transcript. */
	progress(text: string): void;
	/** Called before a file changes, so the turn can be undone. */
	beforeEdit(file: string, previous: string | undefined): void;
	onTodos(todos: Todo[]): void;
	/** Host services for the tools that talk to the user or start sub-agents. */
	runSubagent?(type: string, description: string, prompt: string, callId: string | undefined, signal: AbortSignal): Promise<string>;
	ask?(questions: Question[]): Promise<string>;
	approvePlan?(plan: string): Promise<boolean>;
	skills?(): SkillInfo[];
	readSkill?(name: string): Promise<{ body: string; dir: string } | undefined>;
	/** Searches the codebase index; absent when indexing is off. */
	searchCodebase?(query: string, options: SearchOptions, signal: AbortSignal): Promise<CodebaseSearchResult>;
	/** Saves, changes or deletes a memory and says what happened; absent when memories are off. */
	memory?(change: MemoryChange): Promise<string>;
}

export type MemoryChange =
	| { action: 'save'; text: string; scope: MemoryScope }
	| { action: 'update'; id: string; text: string }
	| { action: 'delete'; id: string };

export interface CodebaseSearchResult {
	results: SearchResult[];
	byMeaning: boolean;
	/** Said to the model along with the results, such as "the index is still being built". */
	note?: string;
}

export interface Tool {
	spec: ToolSpec;
	kind: ToolKind;
	/** Safe to run alongside other calls from the same turn. */
	parallel?: boolean;
	/** A short line for the transcript, e.g. "Read src/app.ts". */
	title(input: Record<string, unknown>, workspace: Workspace): string;
	/** Absolute paths the call touches, for permission checks. */
	paths?(input: Record<string, unknown>, workspace: Workspace): string[];
	/** The change a call would make, shown while asking for approval. */
	preview?(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolDisplay | undefined>;
	run(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

export type { Question, Todo, ToolDisplay };

export class ToolError extends Error { }

function str(input: Record<string, unknown>, key: string, required = true): string {
	const value = input[key];
	if (typeof value === 'string') {
		return value;
	}
	if (value === undefined || value === null) {
		if (required) {
			throw new ToolError(`Missing required parameter "${key}".`);
		}
		return '';
	}
	return String(value);
}

function num(input: Record<string, unknown>, key: string): number | undefined {
	const value = input[key];
	if (value === undefined || value === null || value === '') {
		return undefined;
	}
	const n = Number(value);
	if (!Number.isFinite(n)) {
		throw new ToolError(`Parameter "${key}" must be a number.`);
	}
	return n;
}

function hash(text: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return `${text.length}:${(h >>> 0).toString(16)}`;
}

function shortPath(ws: Workspace, input: Record<string, unknown>, key = 'file_path'): string {
	const value = input[key];
	return typeof value === 'string' && value ? displayPath(ws, resolvePath(ws, value)) : '';
}

const IMAGE_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
const MAX_LINES = 2000;
const MAX_LINE_LENGTH = 2000;

// --- Read

const readTool: Tool = {
	kind: 'read',
	parallel: true,
	spec: {
		name: 'Read',
		description: [
			'Reads a file from the local file system. Paths may be absolute or relative to the working directory.',
			`By default reads up to ${MAX_LINES} lines from the start; use offset and limit for long files.`,
			'Output uses cat -n format: line numbers start at 1, then a tab, then the line. Never include the line number prefix in edits.',
			'Reads images (PNG, JPG, GIF, WebP) so you can see them. Use LS for directories.',
			'Read several files at once when you will likely need them.',
		].join('\n'),
		inputSchema: {
			type: 'object',
			properties: {
				file_path: { type: 'string', description: 'The file to read.' },
				offset: { type: 'number', description: 'The line number to start from (1-based). Only for long files.' },
				limit: { type: 'number', description: 'How many lines to read. Only for long files.' },
			},
			required: ['file_path'],
			additionalProperties: false,
		},
	},
	title: (input, ws) => `Read ${shortPath(ws, input)}`,
	paths: (input, ws) => [resolvePath(ws, str(input, 'file_path'))],
	async run(input, ctx) {
		const file = resolvePath(ctx.workspace, str(input, 'file_path'));
		const stat = await ctx.workspace.stat(file);
		if (!stat) {
			throw new ToolError(`File does not exist: ${file}`);
		}
		if (stat.isDirectory) {
			throw new ToolError(`${file} is a directory. Use LS to list it.`);
		}
		const imageType = IMAGE_TYPES[path.extname(file).toLowerCase()];
		if (imageType) {
			if (stat.size > 5 * 1024 * 1024) {
				throw new ToolError('The image is larger than 5 MB.');
			}
			const bytes = await ctx.workspace.readBytes(file);
			return { content: `Image ${file} (${stat.size} bytes).`, images: [{ mediaType: imageType, data: Buffer.from(bytes).toString('base64') }], summary: 'image' };
		}
		const text = await ctx.workspace.readText(file);
		if (text.includes('\u0000')) {
			throw new ToolError('This looks like a binary file, which cannot be read as text.');
		}
		ctx.state.readFiles.set(pathKey(file), hash(text));
		if (!text) {
			return { content: '<system-reminder>The file exists but is empty.</system-reminder>', summary: 'empty' };
		}
		const lines = text.split(/\r?\n/);
		const offset = Math.max(1, Math.floor(num(input, 'offset') ?? 1));
		const limit = Math.max(1, Math.floor(num(input, 'limit') ?? MAX_LINES));
		const slice = lines.slice(offset - 1, offset - 1 + limit);
		const width = String(offset + slice.length).length;
		const body = slice.map((line, i) => {
			const shown = line.length > MAX_LINE_LENGTH ? `${line.slice(0, MAX_LINE_LENGTH)}... [line truncated]` : line;
			return `${String(offset + i).padStart(Math.max(width, 6))}\t${shown}`;
		}).join('\n');
		const more = offset - 1 + slice.length < lines.length
			? `\n\n(File has ${lines.length} lines; showed ${offset}-${offset + slice.length - 1}. Use offset to read more.)`
			: '';
		return { content: body + more, summary: `${slice.length} lines` };
	},
};

// --- Write and Edit

async function checkFresh(ctx: ToolContext, file: string, verb: string): Promise<string | undefined> {
	const stat = await ctx.workspace.stat(file);
	if (!stat) {
		return undefined;
	}
	if (stat.isDirectory) {
		throw new ToolError(`${file} is a directory.`);
	}
	const current = await ctx.workspace.readText(file);
	const seen = ctx.state.readFiles.get(pathKey(file));
	if (seen === undefined) {
		throw new ToolError(`Read ${file} before you ${verb} it.`);
	}
	if (seen !== hash(current)) {
		throw new ToolError(`${file} changed since you last read it (the user or a tool may have edited it). Read it again, then retry.`);
	}
	return current;
}

interface EditPlan {
	before: string | undefined;
	after: string;
}

function planEdit(current: string | undefined, input: Record<string, unknown>, file: string): EditPlan {
	let oldString = str(input, 'old_string', false);
	let newString = str(input, 'new_string', false);
	const replaceAll = input.replace_all === true || input.replace_all === 'true';
	if (current === undefined) {
		if (oldString) {
			throw new ToolError(`File does not exist: ${file}`);
		}
		return { before: undefined, after: newString };
	}
	if (!oldString) {
		throw new ToolError('old_string is empty. Use Write to replace a whole file.');
	}
	if (oldString === newString) {
		throw new ToolError('old_string and new_string are the same; there is nothing to change.');
	}
	// Match the file's line endings when the model wrote plain \n.
	if (current.includes('\r\n') && !oldString.includes('\r\n')) {
		oldString = oldString.replace(/\n/g, '\r\n');
		newString = newString.replace(/\r?\n/g, '\r\n');
	}
	const count = current.split(oldString).length - 1;
	if (count === 0) {
		throw new ToolError(`old_string was not found in ${file}. Make sure it matches the file exactly, including whitespace and indentation, without line number prefixes.`);
	}
	if (count > 1 && !replaceAll) {
		throw new ToolError(`old_string appears ${count} times in ${file}. Include more surrounding lines so it is unique, or set replace_all to change every occurrence.`);
	}
	const after = replaceAll ? current.split(oldString).join(newString) : current.replace(oldString, () => newString);
	return { before: current, after };
}

async function applyEdit(ctx: ToolContext, file: string, plan: EditPlan): Promise<ToolResult> {
	ctx.beforeEdit(file, plan.before);
	await ctx.workspace.writeText(file, plan.after);
	ctx.state.readFiles.set(pathKey(file), hash(plan.after));
	const display = diffDisplay(ctx, file, plan.before, plan.after);
	const { diff } = display;
	return {
		content: plan.before === undefined ? `Created ${file}.` : `Updated ${file} (+${diff.added} -${diff.removed}).`,
		display,
		summary: `+${diff.added} -${diff.removed}`,
	};
}

function diffDisplay(ctx: ToolContext, file: string, before: string | undefined, after: string): Extract<ToolDisplay, { kind: 'diff' }> {
	return { kind: 'diff', path: displayPath(ctx.workspace, file), diff: diffLines(before ?? '', after), created: before === undefined, before: before ?? '', after };
}

const editTool: Tool = {
	kind: 'edit',
	spec: {
		name: 'Edit',
		description: [
			'Replaces exact text in a file. Read the file first in this conversation.',
			'old_string must match the file exactly (whitespace and indentation included, without the Read line-number prefix) and be unique unless replace_all is set.',
			'Keep old_string short but unique: usually the lines being changed plus a line or two around them.',
			'To create a new file, use Write (or Edit with an empty old_string on a path that does not exist).',
		].join('\n'),
		inputSchema: {
			type: 'object',
			properties: {
				file_path: { type: 'string', description: 'The file to change.' },
				old_string: { type: 'string', description: 'The exact text to replace.' },
				new_string: { type: 'string', description: 'The text to put in its place.' },
				replace_all: { type: 'boolean', description: 'Replace every occurrence of old_string. Defaults to false.' },
			},
			required: ['file_path', 'old_string', 'new_string'],
			additionalProperties: false,
		},
	},
	title: (input, ws) => `Edit ${shortPath(ws, input)}`,
	paths: (input, ws) => [resolvePath(ws, str(input, 'file_path'))],
	async preview(input, ctx) {
		const file = resolvePath(ctx.workspace, str(input, 'file_path'));
		const plan = planEdit(await checkFresh(ctx, file, 'edit'), input, file);
		return diffDisplay(ctx, file, plan.before, plan.after);
	},
	async run(input, ctx) {
		const file = resolvePath(ctx.workspace, str(input, 'file_path'));
		const plan = planEdit(await checkFresh(ctx, file, 'edit'), input, file);
		return applyEdit(ctx, file, plan);
	},
};

const multiEditTool: Tool = {
	kind: 'edit',
	spec: {
		name: 'MultiEdit',
		description: 'Makes several Edit-style replacements in one file, in order, all or nothing. Each edit applies to the result of the previous one. Read the file first.',
		inputSchema: {
			type: 'object',
			properties: {
				file_path: { type: 'string' },
				edits: {
					type: 'array',
					items: {
						type: 'object',
						properties: {
							old_string: { type: 'string' },
							new_string: { type: 'string' },
							replace_all: { type: 'boolean' },
						},
						required: ['old_string', 'new_string'],
					},
				},
			},
			required: ['file_path', 'edits'],
			additionalProperties: false,
		},
	},
	title: (input, ws) => `Edit ${shortPath(ws, input)}`,
	paths: (input, ws) => [resolvePath(ws, str(input, 'file_path'))],
	async preview(input, ctx) {
		const file = resolvePath(ctx.workspace, str(input, 'file_path'));
		const plan = planMulti(await checkFresh(ctx, file, 'edit'), input, file);
		return diffDisplay(ctx, file, plan.before, plan.after);
	},
	async run(input, ctx) {
		const file = resolvePath(ctx.workspace, str(input, 'file_path'));
		return applyEdit(ctx, file, planMulti(await checkFresh(ctx, file, 'edit'), input, file));
	},
};

function planMulti(current: string | undefined, input: Record<string, unknown>, file: string): EditPlan {
	const edits = input.edits;
	if (!Array.isArray(edits) || !edits.length) {
		throw new ToolError('edits must be a non-empty array.');
	}
	let text = current;
	edits.forEach((edit, index) => {
		try {
			text = planEdit(text, edit as Record<string, unknown>, file).after;
		} catch (err) {
			throw new ToolError(`Edit ${index + 1}: ${err.message}`);
		}
	});
	return { before: current, after: text ?? '' };
}

const writeTool: Tool = {
	kind: 'edit',
	spec: {
		name: 'Write',
		description: 'Writes a whole file, creating folders as needed and replacing any existing file. To change part of an existing file, prefer Edit. An existing file must be read first.',
		inputSchema: {
			type: 'object',
			properties: {
				file_path: { type: 'string', description: 'The file to write.' },
				content: { type: 'string', description: 'The complete new content.' },
			},
			required: ['file_path', 'content'],
			additionalProperties: false,
		},
	},
	title: (input, ws) => `Write ${shortPath(ws, input)}`,
	paths: (input, ws) => [resolvePath(ws, str(input, 'file_path'))],
	async preview(input, ctx) {
		const file = resolvePath(ctx.workspace, str(input, 'file_path'));
		const before = await checkFresh(ctx, file, 'overwrite');
		return diffDisplay(ctx, file, before, str(input, 'content', false));
	},
	async run(input, ctx) {
		const file = resolvePath(ctx.workspace, str(input, 'file_path'));
		const before = await checkFresh(ctx, file, 'overwrite');
		return applyEdit(ctx, file, { before, after: str(input, 'content', false) });
	},
};

// --- LS, Glob and Grep

const lsTool: Tool = {
	kind: 'read',
	parallel: true,
	spec: {
		name: 'LS',
		description: 'Lists a directory. Folders end with "/". Prefer Glob or Grep to find files across a project.',
		inputSchema: {
			type: 'object',
			properties: {
				path: { type: 'string', description: 'The directory. Defaults to the working directory.' },
			},
			additionalProperties: false,
		},
	},
	title: (input, ws) => {
		const shown = shortPath(ws, input, 'path');
		return shown && shown !== '.' ? `List ${shown}` : 'List workspace';
	},
	paths: (input, ws) => [resolvePath(ws, str(input, 'path', false) || '.')],
	async run(input, ctx) {
		const dir = resolvePath(ctx.workspace, str(input, 'path', false) || '.');
		const entries = await ctx.workspace.readDir(dir).catch(() => {
			throw new ToolError(`Not a readable directory: ${dir}`);
		});
		entries.sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name));
		const shown = entries.slice(0, 1000).map(e => e.isDirectory ? `${e.name}/` : e.name);
		const more = entries.length > shown.length ? `\n... and ${entries.length - shown.length} more` : '';
		return { content: `${dir}\n${shown.map(s => `  ${s}`).join('\n')}${more}`, summary: `${entries.length} entries` };
	},
};

function runRipgrep(rg: string, args: string[], cwd: string, signal: AbortSignal): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(rg, args, { cwd, maxBuffer: 20 * 1024 * 1024, signal, windowsHide: true }, (err, stdout, stderr) => {
			// Exit code 1 means no matches.
			if (err && (err as { code?: unknown }).code !== 1) {
				reject(new ToolError(stderr.trim() || err.message));
			} else {
				resolve(stdout);
			}
		});
	});
}

/** Walks files without ripgrep, skipping heavy folders. */
async function* walk(ws: Workspace, dir: string, signal: AbortSignal, budget = { left: 50_000 }): AsyncGenerator<string> {
	let entries: { name: string; isDirectory: boolean }[];
	try {
		entries = await ws.readDir(dir);
	} catch {
		return;
	}
	for (const entry of entries) {
		if (signal.aborted || budget.left-- <= 0) {
			return;
		}
		const full = path.join(dir, entry.name);
		if (entry.isDirectory) {
			if (!SKIPPED_DIRS.has(entry.name)) {
				yield* walk(ws, full, signal, budget);
			}
		} else {
			yield full;
		}
	}
}

function toSlash(p: string): string {
	return p.split(path.sep).join('/');
}

const globTool: Tool = {
	kind: 'read',
	parallel: true,
	spec: {
		name: 'Glob',
		description: 'Finds files by glob pattern, like "**/*.ts" or "src/**/test_*.py", honoring .gitignore. Returns paths, most recently changed first.',
		inputSchema: {
			type: 'object',
			properties: {
				pattern: { type: 'string', description: 'The glob to match.' },
				path: { type: 'string', description: 'The folder to search. Defaults to the working directory.' },
			},
			required: ['pattern'],
			additionalProperties: false,
		},
	},
	title: input => `Find ${str(input, 'pattern', false)}`,
	paths: (input, ws) => [resolvePath(ws, str(input, 'path', false) || '.')],
	async run(input, ctx) {
		const pattern = str(input, 'pattern').replace(/^\.\//, '');
		const base = resolvePath(ctx.workspace, str(input, 'path', false) || '.');
		let files: string[] = [];
		if (ctx.ripgrep) {
			const out = await runRipgrep(ctx.ripgrep, ['--files', '--hidden', '--glob', '!.git', '--glob', pattern], base, ctx.signal);
			files = out.split(/\r?\n/).filter(Boolean).map(f => path.resolve(base, f));
		} else {
			const re = globToRegExp(pattern, process.platform === 'win32');
			for await (const file of walk(ctx.workspace, base, ctx.signal)) {
				if (re.test(toSlash(path.relative(base, file)))) {
					files.push(file);
				}
			}
		}
		const withTimes = await Promise.all(files.slice(0, 2000).map(async f => ({ f, t: (await ctx.workspace.stat(f))?.mtime ?? 0 })));
		withTimes.sort((a, b) => b.t - a.t);
		const shown = withTimes.slice(0, 200).map(x => x.f);
		if (!shown.length) {
			return { content: 'No files found.', summary: '0 files' };
		}
		const more = files.length > shown.length ? `\n(${files.length - shown.length} more not shown; narrow the pattern.)` : '';
		return { content: shown.join('\n') + more, display: { kind: 'files', files: shown.map(f => displayPath(ctx.workspace, f)) }, summary: `${files.length} files` };
	},
};

const grepTool: Tool = {
	kind: 'read',
	parallel: true,
	spec: {
		name: 'Grep',
		description: [
			'Searches file contents with a regular expression (ripgrep syntax), honoring .gitignore.',
			'output_mode: "files_with_matches" (default) lists files, "content" shows matching lines, "count" counts per file.',
			'Filter with glob (e.g. "*.ts", "**/*.{js,jsx}") or type (e.g. "py", "rust"). Escape literal braces, e.g. "interface\\{\\}".',
		].join('\n'),
		inputSchema: {
			type: 'object',
			properties: {
				pattern: { type: 'string', description: 'The regular expression.' },
				path: { type: 'string', description: 'File or folder to search. Defaults to the working directory.' },
				glob: { type: 'string', description: 'Only search files matching this glob.' },
				type: { type: 'string', description: 'Only search this file type (ripgrep --type).' },
				output_mode: { type: 'string', enum: ['content', 'files_with_matches', 'count'] },
				'-i': { type: 'boolean', description: 'Ignore case.' },
				'-n': { type: 'boolean', description: 'Show line numbers (content mode). Defaults to true.' },
				'-A': { type: 'number', description: 'Lines after each match (content mode).' },
				'-B': { type: 'number', description: 'Lines before each match (content mode).' },
				'-C': { type: 'number', description: 'Lines around each match (content mode).' },
				multiline: { type: 'boolean', description: 'Let patterns span lines.' },
				head_limit: { type: 'number', description: 'Only return the first N lines or files.' },
			},
			required: ['pattern'],
			additionalProperties: false,
		},
	},
	title: input => `Search ${JSON.stringify(str(input, 'pattern', false))}${input.glob ? ` in ${input.glob}` : ''}`,
	paths: (input, ws) => [resolvePath(ws, str(input, 'path', false) || '.')],
	async run(input, ctx) {
		const pattern = str(input, 'pattern');
		const target = resolvePath(ctx.workspace, str(input, 'path', false) || '.');
		const mode = str(input, 'output_mode', false) || 'files_with_matches';
		const limit = num(input, 'head_limit') ?? (mode === 'content' ? 400 : 200);
		let lines: string[];
		if (ctx.ripgrep) {
			const args = ['--hidden', '--glob', '!.git', '--max-columns', '500', '--max-columns-preview', '--no-heading', '--color', 'never'];
			if (input['-i']) {
				args.push('-i');
			}
			if (input.multiline) {
				args.push('-U', '--multiline-dotall');
			}
			if (typeof input.glob === 'string' && input.glob) {
				args.push('--glob', input.glob);
			}
			if (typeof input.type === 'string' && input.type) {
				args.push('--type', input.type);
			}
			if (mode === 'files_with_matches') {
				args.push('-l');
			} else if (mode === 'count') {
				args.push('-c');
			} else {
				if (input['-n'] !== false) {
					args.push('-n');
				}
				for (const flag of ['-A', '-B', '-C']) {
					const value = num(input, flag);
					if (value !== undefined) {
						args.push(flag, String(value));
					}
				}
			}
			args.push('-e', pattern, '--', target);
			const out = await runRipgrep(ctx.ripgrep, args, ctx.workspace.roots[0] ?? target, ctx.signal);
			lines = out.split(/\r?\n/).filter(Boolean);
		} else {
			lines = await jsGrep(ctx, pattern, target, mode, input);
		}
		if (!lines.length) {
			return { content: 'No matches found.', summary: '0 matches' };
		}
		const shown = lines.slice(0, limit);
		const more = lines.length > shown.length ? `\n(${lines.length - shown.length} more lines not shown; narrow the search or raise head_limit.)` : '';
		const noun = mode === 'content' ? 'lines' : 'files';
		return { content: truncateOutput(shown.join('\n')) + more, summary: `${lines.length} ${noun}` };
	},
};

async function jsGrep(ctx: ToolContext, pattern: string, target: string, mode: string, input: Record<string, unknown>): Promise<string[]> {
	let re: RegExp;
	try {
		re = new RegExp(pattern, input['-i'] ? 'i' : '');
	} catch (err) {
		throw new ToolError(`Invalid regular expression: ${err.message}`);
	}
	const filter = typeof input.glob === 'string' && input.glob ? globToRegExp(input.glob.includes('/') ? input.glob : `**/${input.glob}`) : undefined;
	const stat = await ctx.workspace.stat(target);
	const files: string[] = [];
	if (stat && !stat.isDirectory) {
		files.push(target);
	} else {
		for await (const file of walk(ctx.workspace, target, ctx.signal)) {
			if (!filter || filter.test(toSlash(path.relative(target, file)))) {
				files.push(file);
			}
		}
	}
	const out: string[] = [];
	for (const file of files) {
		const size = (await ctx.workspace.stat(file))?.size ?? 0;
		if (size > 2 * 1024 * 1024) {
			continue;
		}
		let text: string;
		try {
			text = await ctx.workspace.readText(file);
		} catch {
			continue;
		}
		if (text.includes('\u0000')) {
			continue;
		}
		const matches = text.split(/\r?\n/).map((line, i) => ({ line, i })).filter(({ line }) => re.test(line));
		if (!matches.length) {
			continue;
		}
		if (mode === 'files_with_matches') {
			out.push(file);
		} else if (mode === 'count') {
			out.push(`${file}:${matches.length}`);
		} else {
			out.push(...matches.map(({ line, i }) => `${file}:${i + 1}:${line.slice(0, 500)}`));
		}
		if (out.length > 5000) {
			break;
		}
	}
	return out;
}

// --- CodebaseSearch

const codebaseSearchTool: Tool = {
	kind: 'read',
	parallel: true,
	spec: {
		name: 'CodebaseSearch',
		description: [
			'Finds the code most relevant to a question across the whole project, using the codebase index: by meaning when an embedding model is set up, and by words and identifiers always.',
			'Use it first when you do not know where something lives or what it is called ("where do we handle sign-in?", "how are API keys stored?"). Use Grep for exact text or a known name, and Read to see a result in full.',
			'Put likely identifiers and synonyms in keywords (e.g. ["login", "signIn", "authenticate", "session"]): matching names in the code ranks results much better.',
			'Returns code chunks with file paths and line numbers, most relevant first.',
		].join('\n'),
		inputSchema: {
			type: 'object',
			properties: {
				query: { type: 'string', description: 'What you are looking for, as a question or description.' },
				keywords: { type: 'array', items: { type: 'string' }, description: 'Likely identifiers, file names and synonyms to match.' },
				path: { type: 'string', description: 'Only search under this folder.' },
				limit: { type: 'number', description: 'How many results to return (default 10, at most 30).' },
			},
			required: ['query'],
			additionalProperties: false,
		},
	},
	title: input => `Search codebase for ${JSON.stringify(str(input, 'query', false))}`,
	paths: (input, ws) => [resolvePath(ws, str(input, 'path', false) || '.')],
	async run(input, ctx) {
		if (!ctx.searchCodebase) {
			throw new ToolError('The codebase index is turned off. Use Grep and Glob instead.');
		}
		const query = str(input, 'query');
		const keywords = Array.isArray(input.keywords) ? input.keywords.map(String).filter(Boolean).slice(0, 30) : typeof input.keywords === 'string' ? input.keywords.split(/[,\s]+/).filter(Boolean) : [];
		const under = str(input, 'path', false) ? resolvePath(ctx.workspace, str(input, 'path')) : undefined;
		const found = await ctx.searchCodebase(query, { keywords, under, limit: Math.min(num(input, 'limit') ?? 10, 30) }, ctx.signal);
		const note = found.note ? `${found.note}\n\n` : '';
		if (!found.results.length) {
			return { content: `${note}No matching code found. Try other keywords, or Grep for exact text.`, summary: '0 results' };
		}
		const how = found.byMeaning ? 'by meaning and words' : 'by words (no embedding model is set up)';
		return {
			content: `${note}${found.results.length} ${found.results.length === 1 ? 'result' : 'results'}, ranked ${how}:\n\n${formatResults(found.results, file => displayPath(ctx.workspace, file))}`,
			display: { kind: 'files', files: found.results.map(r => `${displayPath(ctx.workspace, r.file)}:${r.start}-${r.end}`) },
			summary: `${found.results.length} results`,
		};
	},
};

// --- Memory

const memoryTool: Tool = {
	kind: 'other',
	spec: {
		name: 'Memory',
		description: [
			'Saves a short fact to remember in later conversations, or updates or deletes one by the id shown in the Memories section of your instructions.',
			'Scope "user" is for the user\'s own preferences that apply in every project ("prefers pnpm", "wants short answers"); "project" for facts about this codebase ("tests run with npm run test:unit", "the API client is generated, never edit src/gen").',
			'One short sentence per memory. Never save secrets.',
		].join('\n'),
		inputSchema: {
			type: 'object',
			properties: {
				action: { type: 'string', enum: ['save', 'update', 'delete'], description: 'What to do (default save).' },
				text: { type: 'string', description: 'The fact, as one short sentence. Required to save or update.' },
				scope: { type: 'string', enum: ['project', 'user'], description: 'Who the fact is about, for save (default project).' },
				id: { type: 'string', description: 'The memory to update or delete.' },
			},
			additionalProperties: false,
		},
	},
	title: input => {
		const action = str(input, 'action', false) || 'save';
		return action === 'delete' ? `Forget memory ${str(input, 'id', false)}` : `${action === 'update' ? 'Update memory' : 'Remember'}: ${str(input, 'text', false)}`;
	},
	async run(input, ctx) {
		if (!ctx.memory) {
			throw new ToolError('Memories are turned off.');
		}
		const action = str(input, 'action', false) || 'save';
		const text = str(input, 'text', false).trim();
		if (action !== 'delete' && !text) {
			throw new ToolError('Give the fact to remember in "text".');
		}
		if (looksSecret(text)) {
			throw new ToolError('That looks like it contains a secret, which is never saved. Save the fact without it.');
		}
		let change: MemoryChange;
		if (action === 'save') {
			change = { action, text, scope: str(input, 'scope', false) === 'user' ? 'user' : 'project' };
		} else if (action === 'update' || action === 'delete') {
			const id = str(input, 'id').replace(/^\[|\]$/g, '');
			change = action === 'update' ? { action, id, text } : { action, id };
		} else {
			throw new ToolError('"action" must be save, update or delete.');
		}
		const result = await ctx.memory(change);
		return { content: result, display: { kind: 'text', text: result }, summary: action === 'delete' ? 'forgotten' : 'saved' };
	},
};

// --- Bash

const bashTool: Tool = {
	kind: 'execute',
	spec: {
		name: 'Bash',
		description: '',
		inputSchema: {
			type: 'object',
			properties: {
				command: { type: 'string', description: 'The command to run.' },
				description: { type: 'string', description: 'What the command does, in 5 to 10 words.' },
				timeout: { type: 'number', description: 'Timeout in milliseconds (default 120000, max 600000).' },
				run_in_background: { type: 'boolean', description: 'Run without waiting, for servers and watchers. Read its output with BashOutput and stop it with KillBash.' },
			},
			required: ['command'],
			additionalProperties: false,
		},
	},
	title: input => typeof input.description === 'string' && input.description ? input.description : `Run ${str(input, 'command', false)}`,
	async run(input, ctx) {
		const command = str(input, 'command');
		const cwd = ctx.workspace.roots[0] ?? process.cwd();
		if (input.run_in_background === true || input.run_in_background === 'true') {
			const id = ctx.state.newShellId();
			// Output arrives on later ticks, after `shell` exists.
			const running = startCommand(ctx.shell, command, { cwd, onOutput: chunk => { shell.output += chunk; } });
			const shell: BackgroundShell = { id, command, running, output: '', readOffset: 0, finished: false };
			shell.running.done.then(result => {
				shell.finished = true;
				shell.exitCode = result.exitCode;
			});
			ctx.state.shells.set(id, shell);
			return { content: `Started in the background with id ${id}. Use BashOutput to read its output and KillBash to stop it.`, summary: 'background' };
		}
		const timeout = Math.min(Math.max(num(input, 'timeout') ?? 120_000, 1000), 600_000);
		const running = startCommand(ctx.shell, command, { cwd, timeoutMs: timeout, signal: ctx.signal, onOutput: chunk => ctx.progress(chunk) });
		const result = await running.done;
		let output = truncateOutput(result.output.trimEnd());
		if (result.timedOut) {
			output += `\n\nThe command timed out after ${timeout / 1000}s and was stopped.`;
		} else if (result.aborted) {
			output += '\n\nThe user stopped the command.';
		}
		const content = `${output || '(no output)'}\n\nExit code: ${result.exitCode ?? 'none'}`;
		return {
			content,
			isError: result.exitCode !== 0,
			display: { kind: 'output', text: output, exitCode: result.exitCode },
			summary: result.timedOut ? 'timed out' : result.exitCode === 0 ? undefined : `exit ${result.exitCode ?? '?'}`,
		};
	},
};

export function bashDescription(shell: Shell, platform: string): string {
	const lines = [
		`Runs a command in ${shell.name} (${platform}) in the working directory and returns its output and exit code.`,
		'Each call starts a fresh shell: cd does not carry over, so use absolute paths or "cd dir && command".',
		'Stdin is closed, so commands cannot prompt; pass flags such as --yes. Pagers are disabled.',
		'Do not use it to read, search or edit files when Read, Grep, Glob, Edit or Write can do it.',
		'Quote paths that contain spaces. Chain dependent commands with &&.',
		'Long-running processes such as dev servers must use run_in_background.',
	];
	if (shell.name === 'powershell') {
		lines.push('This is PowerShell: use PowerShell syntax (for example $env:NAME, Get-ChildItem, ; to chain).');
	} else if (shell.name === 'cmd') {
		lines.push('This is cmd.exe: use cmd syntax.');
	}
	return lines.join('\n');
}

const bashOutputTool: Tool = {
	kind: 'read',
	spec: {
		name: 'BashOutput',
		description: 'Returns new output from a background command started with run_in_background, and whether it is still running.',
		inputSchema: {
			type: 'object',
			properties: { bash_id: { type: 'string', description: 'The id Bash returned.' } },
			required: ['bash_id'],
			additionalProperties: false,
		},
	},
	title: input => `Check ${str(input, 'bash_id', false)}`,
	async run(input, ctx) {
		const shell = ctx.state.shells.get(str(input, 'bash_id'));
		if (!shell) {
			throw new ToolError(`No background command with id ${input.bash_id}. Running: ${[...ctx.state.shells.keys()].join(', ') || 'none'}.`);
		}
		const fresh = shell.output.slice(shell.readOffset);
		shell.readOffset = shell.output.length;
		const status = shell.finished ? `finished with exit code ${shell.exitCode ?? 'none'}` : 'still running';
		return { content: `${truncateOutput(fresh) || '(no new output)'}\n\nStatus: ${status}`, summary: shell.finished ? 'finished' : 'running' };
	},
};

const killBashTool: Tool = {
	kind: 'execute',
	spec: {
		name: 'KillBash',
		description: 'Stops a background command.',
		inputSchema: {
			type: 'object',
			properties: { shell_id: { type: 'string', description: 'The id Bash returned.' } },
			required: ['shell_id'],
			additionalProperties: false,
		},
	},
	title: input => `Stop ${str(input, 'shell_id', false)}`,
	async run(input, ctx) {
		const id = str(input, 'shell_id');
		const shell = ctx.state.shells.get(id);
		if (!shell) {
			throw new ToolError(`No background command with id ${id}.`);
		}
		shell.running.kill();
		ctx.state.shells.delete(id);
		return { content: `Stopped ${id}.` };
	},
};

// --- Todos

const todoTool: Tool = {
	kind: 'interact',
	spec: {
		name: 'TodoWrite',
		description: [
			'Keeps a task list for the current work, shown to the user. Use it for tasks with three or more steps, or when the user gives several tasks.',
			'Send the whole list each time. Keep exactly one task in_progress while working; mark a task completed as soon as it is done, not in batches.',
			'content is the imperative ("Run the tests"); activeForm is the present continuous ("Running the tests").',
		].join('\n'),
		inputSchema: {
			type: 'object',
			properties: {
				todos: {
					type: 'array',
					items: {
						type: 'object',
						properties: {
							content: { type: 'string' },
							status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
							activeForm: { type: 'string' },
						},
						required: ['content', 'status'],
					},
				},
			},
			required: ['todos'],
			additionalProperties: false,
		},
	},
	title: () => 'Update tasks',
	async run(input, ctx) {
		if (!Array.isArray(input.todos)) {
			throw new ToolError('todos must be an array.');
		}
		const todos: Todo[] = input.todos.map(t => {
			const item = t as Record<string, unknown>;
			const status = item.status === 'in_progress' || item.status === 'completed' ? item.status : 'pending';
			return { content: String(item.content ?? ''), status, activeForm: typeof item.activeForm === 'string' ? item.activeForm : undefined };
		});
		ctx.state.todos = todos;
		ctx.onTodos(todos);
		const done = todos.filter(t => t.status === 'completed').length;
		return { content: 'Todos updated. Keep working on the current task.', summary: `${done}/${todos.length} done` };
	},
};

// --- WebFetch

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'', nbsp: ' ' };

/** Elements whose content is never readable text. */
const HIDDEN_ELEMENTS = new Set(['script', 'style', 'noscript', 'svg', 'head', 'template']);
const LINE_BREAK_CLOSERS = /^(p|div|h[1-6]|tr|li|pre|section|article|ul|ol|table|blockquote)$/;

function decodeEntities(text: string): string {
	return text.replace(/&(?<code>#x?[0-9a-f]+|\w+);/gi, (match, code: string) => {
		if (code.startsWith('#x') || code.startsWith('#X')) {
			return String.fromCodePoint(parseInt(code.slice(2), 16));
		}
		if (code.startsWith('#')) {
			return String.fromCodePoint(Number(code.slice(1)));
		}
		return ENTITIES[code.toLowerCase()] ?? match;
	});
}

/**
 * A readable text version of an HTML page, for the model to read. It scans
 * tags in a single pass instead of stripping them with regular expressions,
 * so nothing that looks like markup can survive in the output.
 */
export function htmlToText(html: string): string {
	const out: string[] = [];
	let hidden: string | undefined;
	let href: string | undefined;
	let index = 0;
	while (index < html.length) {
		const open = html.indexOf('<', index);
		if (!hidden) {
			out.push(decodeEntities(open < 0 ? html.slice(index) : html.slice(index, open)));
		}
		if (open < 0) {
			break;
		}
		if (html.startsWith('<!--', open)) {
			const end = html.indexOf('-->', open + 4);
			index = end < 0 ? html.length : end + 3;
			continue;
		}
		const close = html.indexOf('>', open);
		if (close < 0) {
			break;
		}
		index = close + 1;
		const tag = /^<\s*(?<closing>\/?)\s*(?<name>[a-zA-Z][\w-]*)(?<attributes>[^>]*)>$/.exec(html.slice(open, close + 1));
		if (!tag?.groups) {
			continue;
		}
		const closing = tag.groups.closing === '/';
		const name = tag.groups.name.toLowerCase();
		if (hidden) {
			if (closing && name === hidden) {
				hidden = undefined;
			}
			continue;
		}
		if (HIDDEN_ELEMENTS.has(name)) {
			if (!closing && !tag.groups.attributes.trim().endsWith('/')) {
				hidden = name;
			}
			continue;
		}
		if (name === 'a') {
			if (closing) {
				if (href) {
					out.push(` (${href})`);
				}
				href = undefined;
			} else {
				href = /\shref\s*=\s*"(?<url>[^"]*)"/i.exec(tag.groups.attributes)?.groups?.url;
			}
		} else if (!closing && /^h[1-6]$/.test(name)) {
			out.push(`\n\n${'#'.repeat(Number(name[1]))} `);
		} else if (!closing && name === 'li') {
			out.push('\n- ');
		} else if (name === 'br' || (closing && LINE_BREAK_CLOSERS.test(name))) {
			out.push('\n');
		}
	}
	return out.join('')
		.replace(/[ \t]+\n/g, '\n')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

const webFetchTool: Tool = {
	kind: 'network',
	parallel: true,
	spec: {
		name: 'WebFetch',
		description: 'Fetches a URL and returns its content as text (HTML is converted). Use it for documentation and pages the user links. Only fetch URLs from the conversation or that you are confident exist.',
		inputSchema: {
			type: 'object',
			properties: {
				url: { type: 'string', description: 'The http(s) URL.' },
				prompt: { type: 'string', description: 'What you are looking for on the page.' },
			},
			required: ['url'],
			additionalProperties: false,
		},
	},
	title: input => `Fetch ${str(input, 'url', false)}`,
	async run(input, ctx) {
		let url: URL;
		try {
			url = new URL(str(input, 'url'));
		} catch {
			throw new ToolError('Invalid URL.');
		}
		if (url.protocol !== 'http:' && url.protocol !== 'https:') {
			throw new ToolError('Only http and https URLs can be fetched.');
		}
		const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(30_000)]);
		const response = await fetch(url, { signal, headers: { 'user-agent': 'Nighthawk-Agent/1.0', accept: 'text/html,text/plain,application/json,*/*' } });
		const type = response.headers.get('content-type') ?? '';
		const raw = (await response.text()).slice(0, 5 * 1024 * 1024);
		const text = /html/.test(type) ? htmlToText(raw) : raw;
		const body = truncateOutput(text, 60_000);
		const header = `${response.status} ${response.statusText} ${response.url}${input.prompt ? `\nLooking for: ${input.prompt}` : ''}`;
		return { content: `${header}\n\n${body}`, isError: !response.ok, summary: `${response.status}` };
	},
};

// --- Tools that talk to the host

const taskTool: Tool = {
	kind: 'other',
	parallel: true,
	spec: {
		name: 'Task',
		description: '',
		inputSchema: {
			type: 'object',
			properties: {
				description: { type: 'string', description: 'A 3 to 5 word summary of the task.' },
				prompt: { type: 'string', description: 'The full task. The sub-agent starts with no context, so include everything it needs and what to report back.' },
				subagent_type: { type: 'string', description: 'Which agent to use.' },
			},
			required: ['description', 'prompt'],
			additionalProperties: false,
		},
	},
	title: input => `Agent: ${str(input, 'description', false)}`,
	async run(input, ctx) {
		if (!ctx.runSubagent) {
			throw new ToolError('Sub-agents are not available here.');
		}
		const report = await ctx.runSubagent(str(input, 'subagent_type', false) || 'general-purpose', str(input, 'description', false), str(input, 'prompt'), ctx.callId, ctx.signal);
		return { content: report || '(the sub-agent returned nothing)', display: { kind: 'text', text: report } };
	},
};

export function taskDescription(agents: { name: string; description: string }[]): string {
	return [
		'Starts a sub-agent with its own context to handle a self-contained task, and returns its final report.',
		'Use it for broad searches across a codebase, research, or independent pieces of work, so your own context stays focused.',
		'Several Task calls in one response run at the same time. The user does not see the sub-agent\'s report; summarize what matters.',
		'Available agents:',
		...agents.map(a => `- ${a.name}: ${a.description}`),
	].join('\n');
}

const skillTool: Tool = {
	kind: 'read',
	spec: {
		name: 'Skill',
		description: '',
		inputSchema: {
			type: 'object',
			properties: { skill: { type: 'string', description: 'The skill name.' } },
			required: ['skill'],
			additionalProperties: false,
		},
	},
	title: input => `Use skill ${str(input, 'skill', false)}`,
	async run(input, ctx) {
		const name = str(input, 'skill');
		const skill = await ctx.readSkill?.(name);
		if (!skill) {
			const known = ctx.skills?.().map(s => s.name).join(', ') || 'none';
			throw new ToolError(`No skill named "${name}". Available: ${known}.`);
		}
		return { content: `Skill "${name}" (files in ${skill.dir}):\n\n${skill.body}`, summary: 'loaded' };
	},
};

export function skillDescription(skills: SkillInfo[]): string {
	return [
		'Loads a skill: instructions and resources for a specific kind of task. When a task matches a skill\'s description, load it first and follow it.',
		'Available skills:',
		...skills.map(s => `- ${s.name}: ${s.description}`),
	].join('\n');
}

const askTool: Tool = {
	kind: 'interact',
	spec: {
		name: 'AskUserQuestion',
		description: 'Asks the user one to four multiple-choice questions when a decision is genuinely theirs (a preference, an ambiguous requirement). The user can always answer in their own words instead. Do not ask what you can find out yourself.',
		inputSchema: {
			type: 'object',
			properties: {
				questions: {
					type: 'array',
					items: {
						type: 'object',
						properties: {
							question: { type: 'string' },
							header: { type: 'string', description: 'A label of one or two words.' },
							options: {
								type: 'array',
								items: {
									type: 'object',
									properties: { label: { type: 'string' }, description: { type: 'string' } },
									required: ['label'],
								},
							},
							multiSelect: { type: 'boolean' },
						},
						required: ['question', 'options'],
					},
				},
			},
			required: ['questions'],
			additionalProperties: false,
		},
	},
	title: () => 'Question',
	async run(input, ctx) {
		if (!ctx.ask) {
			throw new ToolError('Questions are not available here; decide yourself and say what you chose.');
		}
		const questions = Array.isArray(input.questions) ? input.questions as Question[] : [];
		if (!questions.length) {
			throw new ToolError('questions must be a non-empty array.');
		}
		const answer = await ctx.ask(questions);
		return { content: `The user answered:\n${answer}` };
	},
};

const exitPlanTool: Tool = {
	kind: 'interact',
	spec: {
		name: 'ExitPlanMode',
		description: 'In plan mode, presents your implementation plan (Markdown) for the user to approve. Only call it when the plan is ready and you have no open questions. If approved, you can start editing.',
		inputSchema: {
			type: 'object',
			properties: { plan: { type: 'string', description: 'The plan, in concise Markdown.' } },
			required: ['plan'],
			additionalProperties: false,
		},
	},
	title: () => 'Plan',
	async run(input, ctx) {
		const approved = await ctx.approvePlan?.(str(input, 'plan'));
		return approved
			? { content: 'The user approved the plan. Start implementing it now, tracking progress with TodoWrite.' }
			: { content: 'The user did not approve the plan. Stay in plan mode and ask what they want changed.', isError: true };
	},
};

export const BUILTIN_TOOLS: Tool[] = [
	readTool, writeTool, editTool, multiEditTool, lsTool, globTool, grepTool, codebaseSearchTool,
	memoryTool, bashTool, bashOutputTool, killBashTool, todoTool, webFetchTool,
	taskTool, skillTool, askTool, exitPlanTool,
];

/** Tools a read-only sub-agent may use. */
export const READ_ONLY_TOOLS = new Set(['Read', 'LS', 'Glob', 'Grep', 'CodebaseSearch', 'WebFetch', 'BashOutput', 'Skill']);

export function isOutsideWorkspace(tool: Tool, input: Record<string, unknown>, workspace: Workspace): boolean {
	try {
		return (tool.paths?.(input, workspace) ?? []).some(p => !isInWorkspace(workspace, p));
	} catch {
		return false;
	}
}
