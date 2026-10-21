/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { diffLines } from './diff';
import type { ChatRequest, Message } from './types';

/** Characters of the file sent around the selection; the rest is left out. */
const MAX_BEFORE_CHARS = 40_000;
const MAX_AFTER_CHARS = 20_000;

/** The code being edited and the file around it. */
export interface EditTarget {
	/** The file's path, relative to the workspace when it is inside one. */
	path: string;
	languageId: string;
	/** The file's lines above the selection. */
	before: string[];
	/** The selected lines; empty when writing new code at the cursor. */
	selected: string[];
	/** The file's lines below the selection. */
	after: string[];
	/** Errors and warnings inside the selection, as "line N: message". */
	problems?: string[];
}

/** An earlier round of the same edit: what was asked and the code the model wrote. */
export interface EditRound {
	instruction: string;
	code: string;
}

function keepEnd(lines: string[], maxChars: number): { lines: string[]; omitted: number } {
	let size = 0;
	let index = lines.length;
	while (index > 0 && size + lines[index - 1].length + 1 <= maxChars) {
		size += lines[--index].length + 1;
	}
	return { lines: lines.slice(index), omitted: index };
}

function keepStart(lines: string[], maxChars: number): { lines: string[]; omitted: number } {
	let size = 0;
	let index = 0;
	while (index < lines.length && size + lines[index].length + 1 <= maxChars) {
		size += lines[index++].length + 1;
	}
	return { lines: lines.slice(0, index), omitted: lines.length - index };
}

/** The file with the selection marked, trimmed to a size the model can read. */
function describeFile(target: EditTarget): string {
	const before = keepEnd(target.before, MAX_BEFORE_CHARS);
	const after = keepStart(target.after, MAX_AFTER_CHARS);
	const insert = target.selected.length === 0;
	const parts = [`File: ${target.path} (${target.languageId})`, '', '<file>'];
	if (before.omitted) {
		parts.push(`[${before.omitted} lines above left out]`);
	}
	parts.push(...before.lines);
	if (insert) {
		parts.push('<cursor/>');
	} else {
		parts.push('<selection>', ...target.selected, '</selection>');
	}
	parts.push(...after.lines);
	if (after.omitted) {
		parts.push(`[${after.omitted} lines below left out]`);
	}
	parts.push('</file>');
	if (target.problems?.length) {
		parts.push('', insert ? 'Problems reported near the cursor:' : 'Problems reported inside the selection:', ...target.problems.map(p => `- ${p}`));
	}
	return parts.join('\n');
}

/**
 * Builds the request for an inline edit: rewrite the selected lines, or
 * write new code at the cursor, as the instruction says. Earlier rounds
 * of the same edit come first, so a follow-up can refine the last answer.
 */
export function inlineEditRequest(target: EditTarget, instruction: string, earlier: EditRound[] = [], maxTokens = 8192): ChatRequest {
	const insert = target.selected.length === 0;
	const system = [
		'You are an expert programmer editing code inside the user\'s editor.',
		insert
			? 'Write the code to insert at the <cursor/> marker, as the user asks.'
			: 'Rewrite the code between <selection> and </selection>, as the user asks.',
		insert
			? 'Reply with only the code to insert: no explanation, no Markdown code fences, no markers.'
			: 'Reply with only the code that replaces the whole selection, including the lines that stay the same: no explanation, no Markdown code fences, no markers.',
		'Match the file\'s language, indentation, naming and style, and indent the code for where it goes in the file.',
		insert
			? 'Do not repeat code that is already in the file.'
			: 'Change only what is inside the selection. If the request needs changes elsewhere, make the part that fits inside the selection.',
		'If you need to explain something, put it in a short code comment.',
	].join('\n');
	const messages: Message[] = [];
	const first = earlier[0]?.instruction ?? instruction;
	messages.push({ role: 'user', content: [{ type: 'text', text: `${describeFile(target)}\n\nInstruction: ${first}` }] });
	earlier.forEach((round, index) => {
		messages.push({ role: 'assistant', content: [{ type: 'text', text: round.code }] });
		const next = earlier[index + 1]?.instruction ?? instruction;
		messages.push({ role: 'user', content: [{ type: 'text', text: `Change your code: ${next}\nReply with the whole ${insert ? 'code to insert' : 'replacement for the selection'} again.` }] });
	});
	return { system, messages, tools: [], maxTokens };
}

const FENCE = /^\s*(```|~~~)/;
const MARKER = /^\s*<\/?(selection|cursor\/?|file)>\s*$/;

/**
 * Reads a model's code reply as it streams. It drops the Markdown fence
 * and markers models add despite being told not to, and hands out
 * complete lines as soon as they arrive.
 */
export class CodeStream {
	private buffer = '';
	private readonly lines: string[] = [];
	private started = false;
	private fenced = false;
	private closed = false;

	/** Adds streamed text; returns the lines it completed. */
	push(text: string): string[] {
		this.buffer += text;
		const added: string[] = [];
		let newline: number;
		while ((newline = this.buffer.indexOf('\n')) >= 0) {
			const line = this.buffer.slice(0, newline).replace(/\r$/, '');
			this.buffer = this.buffer.slice(newline + 1);
			if (this.take(line)) {
				added.push(line);
			}
		}
		return added;
	}

	/** Ends the stream; returns the last line if it was not followed by a newline. */
	end(): string[] {
		const rest = this.buffer.replace(/\r$/, '');
		this.buffer = '';
		return rest && this.take(rest) ? [rest] : [];
	}

	/** All code lines read so far. */
	get code(): string[] {
		return this.lines;
	}

	private take(line: string): boolean {
		if (this.closed) {
			return false;
		}
		if (!this.started) {
			// Text before the code ("Here is the updated code:") or an opening fence.
			if (!line.trim()) {
				return false;
			}
			this.started = true;
			if (FENCE.test(line)) {
				this.fenced = true;
				return false;
			}
		}
		if (FENCE.test(line)) {
			// A closing fence, or one without an opening fence: the code is over.
			this.closed = true;
			return false;
		}
		if (MARKER.test(line)) {
			return false;
		}
		this.lines.push(line);
		return true;
	}

	/** True when the reply opened a fence; text after it is then ignored. */
	get wasFenced(): boolean {
		return this.fenced;
	}
}

function indentOf(line: string): string {
	return /^[ \t]*/.exec(line)![0];
}

function commonIndent(lines: string[]): string | undefined {
	let common: string | undefined;
	for (const line of lines) {
		if (!line.trim()) {
			continue;
		}
		const indent = indentOf(line);
		if (common === undefined || indent.length < common.length) {
			common = indent;
		}
	}
	return common;
}

/**
 * Fits the model's code into the file: keeps the blank lines that framed
 * the selection, and indents code the model wrote flush left to where the
 * selection was indented.
 */
export function fitCode(code: string[], original: string[], cursorIndent = ''): string[] {
	let start = 0;
	let end = code.length;
	while (start < end && !code[start].trim()) {
		start++;
	}
	while (end > start && !code[end - 1].trim()) {
		end--;
	}
	let body = code.slice(start, end);
	const wanted = original.length ? commonIndent(original) ?? '' : cursorIndent;
	const have = commonIndent(body) ?? '';
	if (wanted && !have) {
		body = body.map(line => line.trim() ? wanted + line : line);
	}
	let leading = 0;
	while (leading < original.length && !original[leading].trim()) {
		leading++;
	}
	let trailing = 0;
	while (trailing < original.length - leading && !original[original.length - 1 - trailing].trim()) {
		trailing++;
	}
	return [...original.slice(0, leading), ...body, ...original.slice(original.length - trailing)];
}

/** One change between the original lines and the new ones, with line numbers inside the edited block. */
export interface EditHunk {
	/** First line of the new code this change covers, counted from 0 in the edited block. */
	start: number;
	/** Lines of new code from `start`. */
	added: number;
	/** The original lines this change replaces. */
	removed: string[];
}

/** The changes from the original lines to the new ones, without context lines. */
export function editHunks(original: string[], updated: string[]): EditHunk[] {
	const diff = diffLines(original.map(l => `${l}\n`).join(''), updated.map(l => `${l}\n`).join(''), 0);
	return diff.hunks.map(hunk => {
		const added = hunk.lines.filter(l => l.kind === '+');
		const removed = hunk.lines.filter(l => l.kind === '-').map(l => l.text);
		// With no context lines, newStart is where the change sits in the new code, also when it only removes lines.
		const start = hunk.newStart - 1;
		return { start: Math.max(0, start), added: added.length, removed };
	});
}

/** How many lines an edit adds and removes in all. */
export function editStats(hunks: EditHunk[]): { added: number; removed: number } {
	return {
		added: hunks.reduce((sum, h) => sum + h.added, 0),
		removed: hunks.reduce((sum, h) => sum + h.removed.length, 0),
	};
}

/** Messages between the inline edit box and the extension. */
export type InlineEditPhase = 'prompt' | 'generating' | 'review' | 'error';

export type InlineEditHostMessage = {
	type: 'state';
	phase: InlineEditPhase;
	/** The model that writes the edit, for example "claude-sonnet-5-5". */
	model?: string;
	/** True when writing new code at the cursor rather than changing a selection. */
	insert: boolean;
	/** The instruction being worked on, shown above the follow-up box. */
	instruction?: string;
	lines?: number;
	added?: number;
	removed?: number;
	changes?: number;
	error?: string;
	/** Earlier instructions, newest first, for the Up arrow. */
	history?: string[];
	l10n?: Record<string, string>;
	/** Keyboard shortcuts as the user's platform writes them. */
	keys?: { accept: string; reject: string };
} | { type: 'focus' };

export type InlineEditPageMessage =
	| { type: 'ready' }
	| { type: 'submit'; text: string }
	| { type: 'cancel' }
	| { type: 'close' }
	| { type: 'accept' }
	| { type: 'reject' }
	| { type: 'pickModel' }
	| { type: 'focusEditor' };
