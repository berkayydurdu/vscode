/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { diffLines } from './diff';
import type { ChatRequest } from './types';

/** Typing that pauses this long ends one edit; the next keystroke starts another. */
export const EDIT_PAUSE_MS = 1_500;
/** Edits older than this are no longer recent. */
const RECENT_MS = 5 * 60_000;
/** Edits kept per file. */
const MAX_EDITS = 6;
/** Files larger than this are not tracked. */
const MAX_TRACKED_CHARS = 500_000;
/** Characters of recent edits sent with a request. */
const MAX_EDIT_CHARS = 3_000;
/** Lines of the file shown before and after the cursor. */
const WINDOW_LINES = 80;
/** Lines a suggested edit may replace. */
const MAX_EDIT_LINES = 12;
const CURSOR = '<CURSOR>';

interface Snapshot {
	text: string;
	at: number;
}

interface Tracked {
	/** The file at each pause in typing, oldest first. */
	snapshots: Snapshot[];
	/** The file now. */
	current: string;
	changedAt: number;
}

/**
 * What the user changed lately in each file: the file is remembered each
 * time typing pauses, and the changes between those copies are the edits.
 */
export class EditHistory {
	private readonly files = new Map<string, Tracked>();

	/** Starts tracking a file, as it is when opened. */
	open(file: string, text: string, now = Date.now()): void {
		if (text.length > MAX_TRACKED_CHARS) {
			this.files.delete(file);
			return;
		}
		if (!this.files.has(file)) {
			this.files.set(file, { snapshots: [{ text, at: now }], current: text, changedAt: now });
		}
	}

	/** Records the file's text after a change. */
	change(file: string, text: string, now = Date.now()): void {
		const tracked = this.files.get(file);
		if (!tracked) {
			this.open(file, text, now);
			return;
		}
		if (text.length > MAX_TRACKED_CHARS) {
			this.files.delete(file);
			return;
		}
		// After a pause, the text before this change closes the previous edit.
		const last = tracked.snapshots[tracked.snapshots.length - 1];
		if (now - tracked.changedAt >= EDIT_PAUSE_MS && last.text !== tracked.current) {
			tracked.snapshots.push({ text: tracked.current, at: tracked.changedAt });
			if (tracked.snapshots.length > MAX_EDITS + 1) {
				tracked.snapshots.shift();
			}
		}
		tracked.current = text;
		tracked.changedAt = now;
	}

	close(file: string): void {
		this.files.delete(file);
	}

	/** The file's recent edits, oldest first, as diff snippets; empty when nothing changed lately. */
	recent(file: string, now = Date.now()): string[] {
		const tracked = this.files.get(file);
		if (!tracked || now - tracked.changedAt > RECENT_MS) {
			return [];
		}
		const texts = [...tracked.snapshots.filter(s => now - s.at <= RECENT_MS || s === tracked.snapshots[tracked.snapshots.length - 1]).map(s => s.text), tracked.current];
		const edits: string[] = [];
		for (let i = 1; i < texts.length; i++) {
			if (texts[i - 1] !== texts[i]) {
				edits.push(...editSnippets(texts[i - 1], texts[i]));
			}
		}
		// The newest edits matter most: drop the oldest beyond the budget.
		let total = 0;
		let keep = edits.length;
		while (keep > 0 && total + edits[keep - 1].length <= MAX_EDIT_CHARS) {
			total += edits[keep - 1].length;
			keep--;
		}
		return edits.slice(keep);
	}
}

/** Each changed place between two versions of a file, as `@@ line N` and -/+ lines with a line of context. */
export function editSnippets(before: string, after: string): string[] {
	return diffLines(before, after, 1).hunks.map(hunk => [
		`@@ line ${hunk.newStart}`,
		...hunk.lines.map(line => `${line.kind}${line.text}`),
	].join('\n'));
}

export interface NextEditTarget {
	path: string;
	languageId: string;
	/** The whole file, with `\n` line ends. */
	text: string;
	/** Offset of the cursor in `text`. */
	cursor: number;
	/** Recent edits, oldest first, from {@link EditHistory.recent}. */
	edits: string[];
}

/** Builds the request that asks a model where the user will edit next, and how. */
export function nextEditRequest(target: NextEditTarget): ChatRequest {
	const lines = target.text.slice(0, target.cursor).split('\n');
	const cursorLine = lines.length - 1;
	const all = target.text.split('\n');
	const from = Math.max(0, cursorLine - WINDOW_LINES);
	const to = Math.min(all.length, cursorLine + WINDOW_LINES + 1);
	const window = all.slice(from, to);
	const column = lines[lines.length - 1].length;
	window[cursorLine - from] = window[cursorLine - from].slice(0, column) + CURSOR + window[cursorLine - from].slice(column);
	const prompt = [
		`File: ${target.path} (${target.languageId})`,
		'',
		'The user\'s recent edits in this file, oldest first:',
		...target.edits.map(edit => `<edit>\n${edit}\n</edit>`),
		'',
		'<file>',
		...(from > 0 ? ['[earlier lines left out]'] : []),
		...window,
		...(to < all.length ? ['[later lines left out]'] : []),
		'</file>',
	].join('\n');
	return {
		system: [
			'You are the next edit prediction of a code editor. From the user\'s recent edits and the file, predict the next edit they will make. <CURSOR> marks the cursor.',
			'Good predictions continue what the edits started: the same rename, new parameter, changed call, type or style at the next place that still needs it, or the code a new declaration now requires.',
			'Reply with exactly one edit in this form, and nothing else:',
			'<old>lines copied exactly from the file, including indentation</old>',
			'<new>what those lines should become</new>',
			'Rules:',
			`- <old> must be text that appears in the file now, without the <CURSOR> marker, at most ${MAX_EDIT_LINES} lines. Copy enough of it to be unique.`,
			'- Never undo or repeat an edit the user just made, and never change code the edits give no reason to change.',
			'- If there is no clear next edit, reply with <none/>.',
		].join('\n'),
		messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
		tools: [],
		maxTokens: 600,
		effort: 'low',
	};
}

export interface NextEdit {
	/** Offsets in the file of the text to replace. */
	start: number;
	end: number;
	text: string;
}

function tagged(reply: string, tag: string): string | undefined {
	const match = new RegExp(`<${tag}>\\n?([\\s\\S]*?)\\n?</${tag}>`).exec(reply);
	return match ? match[1] : undefined;
}

/**
 * Reads the model's edit and finds where it goes in the file: the copy of
 * `<old>` nearest the cursor, trimmed to the lines that change. Undefined
 * when there is no edit, it is not in the file, or it undoes a recent edit.
 */
export function parseNextEdit(reply: string, target: NextEditTarget): NextEdit | undefined {
	const normalized = reply.replace(/\r\n/g, '\n');
	if (/<none\s*\/?>/.test(normalized) && !normalized.includes('<old>')) {
		return undefined;
	}
	const old = tagged(normalized, 'old')?.split(CURSOR).join('');
	const replacement = tagged(normalized, 'new')?.split(CURSOR).join('');
	if (old === undefined || replacement === undefined || old === replacement || old.trim().length < 2 || old.split('\n').length > MAX_EDIT_LINES) {
		return undefined;
	}
	const start = nearestOccurrence(target.text, old, target.cursor);
	if (start < 0) {
		return undefined;
	}
	const edit = trimEdit(target.text, { start, end: start + old.length, text: replacement });
	if (!edit || undoesRecentEdit(target.text.slice(edit.start, edit.end), edit.text, target.edits)) {
		return undefined;
	}
	return edit;
}

function nearestOccurrence(text: string, search: string, cursor: number): number {
	let best = -1;
	for (let at = text.indexOf(search); at >= 0; at = text.indexOf(search, at + 1)) {
		const distance = at > cursor ? at - cursor : Math.max(0, cursor - (at + search.length));
		const bestDistance = best < 0 ? Infinity : best > cursor ? best - cursor : Math.max(0, cursor - (best + search.length));
		if (distance < bestDistance) {
			best = at;
		}
	}
	return best;
}

/** Leaves out the whole lines at the start and end that the edit keeps as they are. */
function trimEdit(text: string, edit: NextEdit): NextEdit | undefined {
	let { start, end } = edit;
	let replacement = edit.text;
	for (;;) {
		const oldBreak = text.indexOf('\n', start);
		const newBreak = replacement.indexOf('\n');
		if (oldBreak < 0 || oldBreak >= end || newBreak < 0 || text.slice(start, oldBreak) !== replacement.slice(0, newBreak)) {
			break;
		}
		start = oldBreak + 1;
		replacement = replacement.slice(newBreak + 1);
	}
	for (;;) {
		const oldBreak = text.lastIndexOf('\n', end - 1);
		const newBreak = replacement.lastIndexOf('\n');
		if (oldBreak < start || newBreak < 0 || text.slice(oldBreak + 1, end) !== replacement.slice(newBreak + 1)) {
			break;
		}
		end = oldBreak;
		replacement = replacement.slice(0, newBreak);
	}
	return text.slice(start, end) === replacement ? undefined : { start, end, text: replacement };
}

/** Whether changing `before` to `after` would turn a recent edit's new lines back into its old ones. */
function undoesRecentEdit(before: string, after: string, edits: string[]): boolean {
	const squash = (text: string) => text.replace(/\s+/g, ' ').trim();
	const from = squash(before);
	const to = squash(after);
	return edits.some(edit => {
		const lines = edit.split('\n').slice(1);
		const removed = squash(lines.filter(l => l.startsWith('-')).map(l => l.slice(1)).join('\n'));
		const added = squash(lines.filter(l => l.startsWith('+')).map(l => l.slice(1)).join('\n'));
		return !!from && added.includes(from) && removed.includes(to);
	});
}

/** A short key for an edit, to recognise one the user turned down. */
export function nextEditKey(path: string, before: string, after: string): string {
	return `${path}\u0000${before}\u0000${after}`;
}
