/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ChatRequest } from './types';

/** Characters of the file sent before and after the cursor; the rest is left out. */
const MAX_PREFIX_CHARS = 8_000;
const MAX_SUFFIX_CHARS = 3_000;
/** Lines a multi-line suggestion may have. */
const MAX_LINES = 16;
const CURSOR = '<CURSOR>';

/** Where the cursor is: the file around it, split at the cursor. */
export interface CompletionTarget {
	/** The file's path, relative to the workspace when it is inside one. */
	path: string;
	languageId: string;
	/** All text before the cursor. */
	prefix: string;
	/** All text after the cursor. */
	suffix: string;
	/** How the file indents, to fit suggestions that indent differently. */
	indent?: Indentation;
}

export interface Indentation {
	insertSpaces: boolean;
	tabSize: number;
}

function linePrefixOf(prefix: string): string {
	return prefix.slice(prefix.lastIndexOf('\n') + 1);
}

function lineSuffixOf(suffix: string): string {
	const end = suffix.indexOf('\n');
	return (end < 0 ? suffix : suffix.slice(0, end)).replace(/\r$/, '');
}

/**
 * Whether a suggestion makes sense here. Only when the rest of the line is
 * empty or closing punctuation, as in `foo(|)`: in the middle of code the
 * suggestion would push the code after it along.
 */
export function shouldComplete(target: CompletionTarget): boolean {
	return !/[\w$]/.test(lineSuffixOf(target.suffix));
}

/**
 * Whether to suggest more than the rest of the line: on an empty line, or
 * after something that opens a block.
 */
export function wantsMultiline(target: CompletionTarget): boolean {
	const line = linePrefixOf(target.prefix);
	return !line.trim() || /([{([:]|=>|\bthen|\bdo|"""|''')\s*$/.test(line);
}

/** Files that often hold secrets, which are never sent for suggestions. */
export function isSensitiveFile(path: string): boolean {
	const name = path.replace(/\\/g, '/').split('/').pop()?.toLowerCase() ?? '';
	return /^\.env(\..*)?$/.test(name)
		|| /\.(pem|key|p12|pfx|keystore|jks)$/.test(name)
		|| /^(\.npmrc|\.netrc|\.pgpass|\.git-credentials|credentials|id_rsa|id_ed25519|id_ecdsa|id_dsa)$/.test(name);
}

function keepEnd(text: string, maxChars: number): { text: string; omitted: boolean } {
	if (text.length <= maxChars) {
		return { text, omitted: false };
	}
	// Starts at a line, so the model does not see half a line.
	const cut = text.length - maxChars;
	const lineStart = text.indexOf('\n', cut);
	return { text: lineStart < 0 ? text.slice(cut) : text.slice(lineStart + 1), omitted: true };
}

function keepStart(text: string, maxChars: number): { text: string; omitted: boolean } {
	if (text.length <= maxChars) {
		return { text, omitted: false };
	}
	const lineEnd = text.lastIndexOf('\n', maxChars);
	return { text: lineEnd < 0 ? text.slice(0, maxChars) : text.slice(0, lineEnd), omitted: true };
}

/** Builds the request that asks a chat model for the text to insert at the cursor. */
export function completionRequest(target: CompletionTarget): ChatRequest {
	const multiline = wantsMultiline(target);
	const before = keepEnd(target.prefix.replace(/\r\n/g, '\n'), MAX_PREFIX_CHARS);
	const after = keepStart(target.suffix.replace(/\r\n/g, '\n'), MAX_SUFFIX_CHARS);
	const file = [
		`File: ${target.path} (${target.languageId})`,
		'',
		'<file>',
		...(before.omitted ? ['[earlier lines left out]'] : []),
		`${before.text}${CURSOR}${after.text}`,
		...(after.omitted ? ['[later lines left out]'] : []),
		'</file>',
	].join('\n');
	return {
		system: [
			'You are the autocomplete of a code editor. The user\'s file is below, with the marker <CURSOR> where the cursor is.',
			'Predict the text the user is most likely to type next at the cursor, and reply with only that text inside <completion></completion> tags.',
			'Rules:',
			'- Reply with the inserted text only: no explanation, no code fences, and never the code that is already before or after the cursor.',
			'- Continue from the exact character at the cursor. If the cursor is in the middle of a word or line, start with the rest of it.',
			'- Match the file\'s language, indentation, quotes, naming and style.',
			multiline
				? '- Complete the current statement or block, and stop where the user would likely pause. Write at most 12 lines.'
				: '- Complete only the current line.',
			'- If nothing useful can be suggested, reply with <completion></completion>.',
		].join('\n'),
		messages: [{ role: 'user', content: [{ type: 'text', text: file }] }],
		tools: [],
		maxTokens: multiline ? 300 : 80,
		effort: 'low',
		stop: ['</completion>'],
	};
}

/** Reads the inserted text out of the model's reply: inside the tags, else without code fences. */
export function parseCompletion(reply: string): string {
	let text = reply.replace(/\r\n/g, '\n');
	const open = text.indexOf('<completion>');
	if (open >= 0) {
		text = text.slice(open + '<completion>'.length);
		const close = text.indexOf('</completion>');
		if (close >= 0) {
			text = text.slice(0, close);
		}
	} else {
		const fenced = /```[\w+-]*\n([\s\S]*?)(\n?```|$)/.exec(text);
		if (fenced) {
			text = fenced[1];
		}
	}
	return text.split(CURSOR).join('');
}

/**
 * Fits the model's text to the cursor: drops what repeats the line before
 * the cursor or the code after it, and keeps single-line suggestions to one
 * line. Returns '' when nothing is left to suggest.
 */
export function cleanCompletion(text: string, target: CompletionTarget): string {
	const linePrefix = linePrefixOf(target.prefix);
	const lineSuffix = lineSuffixOf(target.suffix).trim();
	if (target.indent) {
		text = fitIndentation(text, linePrefix, target.indent);
	}
	// Models sometimes start with the line that is already there.
	const lead = linePrefix.trimStart();
	if (lead.length >= 2 && text.trimStart().startsWith(lead)) {
		text = text.trimStart().slice(lead.length);
	}
	let lines = text.split('\n');
	if (!wantsMultiline(target)) {
		lines = lines.slice(0, 1);
	}
	lines = lines.slice(0, MAX_LINES).map((line, i) => i === 0 ? line : line.trimEnd());
	while (lines.length > 1 && !lines[lines.length - 1].trim()) {
		lines.pop();
	}
	// Lines the model wrote again although they follow the cursor already.
	const following = target.suffix.replace(/\r\n/g, '\n').split('\n').slice(1).map(l => l.trim()).filter(Boolean).slice(0, 8);
	for (let count = Math.min(lines.length, following.length); count > 0; count--) {
		const tail = lines.slice(lines.length - count).map(l => l.trim());
		if (tail.every((line, i) => line === following[i])) {
			lines = lines.slice(0, lines.length - count);
			while (lines.length > 1 && !lines[lines.length - 1].trim()) {
				lines.pop();
			}
			break;
		}
	}
	if (!lines.length) {
		return '';
	}
	let result = lines.join('\n');
	// The closing punctuation after the cursor stays where it is, as in `foo(|)`.
	if (lineSuffix && result.trimEnd().endsWith(lineSuffix)) {
		result = result.trimEnd().slice(0, -lineSuffix.length);
	} else if (lineSuffix && lines[0].trimEnd().endsWith(lineSuffix)) {
		result = lines[0].trimEnd().slice(0, -lineSuffix.length);
	}
	if (!result.trim()) {
		return '';
	}
	// Single-line suggestions keep no trailing spaces; the user types those.
	return lines.length === 1 ? result.trimEnd() : result;
}

function indentWidth(whitespace: string, tabSize: number): number {
	let width = 0;
	for (const char of whitespace) {
		width = char === '\t' ? width + tabSize - (width % tabSize) : width + 1;
	}
	return width;
}

function makeIndent(width: number, indent: Indentation): string {
	return indent.insertSpaces ? ' '.repeat(width) : '\t'.repeat(Math.floor(width / indent.tabSize)) + ' '.repeat(width % indent.tabSize);
}

/**
 * Writes the suggestion's indentation the way the file indents, with tabs
 * or spaces. On a line that is only indentation so far, the first line
 * loses the indentation the cursor already has; otherwise accepting with
 * Tab would indent instead.
 */
export function fitIndentation(text: string, linePrefix: string, indent: Indentation): string {
	const lines = text.split('\n').map(line => {
		const lead = /^[ \t]*/.exec(line)?.[0] ?? '';
		return { width: indentWidth(lead, indent.tabSize), body: line.slice(lead.length) };
	});
	if (!linePrefix.trim()) {
		const first = lines[0];
		first.width = Math.max(0, first.width - indentWidth(linePrefix, indent.tabSize));
		return lines.map((line, i) => (i === 0 && !line.width ? '' : line.body ? makeIndent(line.width, indent) : '') + line.body).join('\n');
	}
	// After code on the line, the first line goes on as is.
	return lines.map((line, i) => i === 0 ? text.split('\n')[0] : (line.body ? makeIndent(line.width, indent) : '') + line.body).join('\n');
}

/**
 * Whether the suggestion should also replace the rest of the line, such as
 * the `)` the editor closed automatically: when it writes those characters
 * again, in order, and ends with them.
 */
export function replacesLineSuffix(text: string, target: CompletionTarget): boolean {
	const rest = lineSuffixOf(target.suffix).trim();
	if (!rest) {
		return false;
	}
	const lastLine = text.slice(text.lastIndexOf('\n') + 1).replace(/[\s;,]+$/, '');
	if (!lastLine.endsWith(rest[rest.length - 1])) {
		return false;
	}
	let found = 0;
	for (const char of text) {
		if (found < rest.length && char === rest[found]) {
			found++;
		}
	}
	return found === rest.length;
}

/** Text kept from the end of the prefix to recognise it again. */
const CACHE_TAIL = 2_000;
const CACHE_SIZE = 30;

interface CacheEntry {
	document: string;
	/** Length of the whole prefix, and its end. */
	prefixLength: number;
	tail: string;
	lineSuffix: string;
	text: string;
}

/**
 * Suggestions already received, so typing the start of a suggestion or
 * coming back to the same place shows the rest without asking again.
 */
export class CompletionCache {
	private entries: CacheEntry[] = [];

	add(document: string, target: CompletionTarget, text: string): void {
		this.entries = this.entries.filter(e => !(e.document === document && e.prefixLength === target.prefix.length && e.tail === target.prefix.slice(-CACHE_TAIL)));
		this.entries.push({
			document,
			prefixLength: target.prefix.length,
			tail: target.prefix.slice(-CACHE_TAIL),
			lineSuffix: lineSuffixOf(target.suffix),
			text,
		});
		if (this.entries.length > CACHE_SIZE) {
			this.entries.shift();
		}
	}

	/** The rest of a known suggestion that the text typed since still matches; '' when it said nothing here. */
	find(document: string, target: CompletionTarget): string | undefined {
		const lineSuffix = lineSuffixOf(target.suffix);
		for (let i = this.entries.length - 1; i >= 0; i--) {
			const entry = this.entries[i];
			if (entry.document !== document || entry.lineSuffix !== lineSuffix || target.prefix.length < entry.prefixLength) {
				continue;
			}
			if (target.prefix.slice(entry.prefixLength - entry.tail.length, entry.prefixLength) !== entry.tail) {
				continue;
			}
			const typed = target.prefix.slice(entry.prefixLength);
			if (!typed) {
				return entry.text;
			}
			if (entry.text.startsWith(typed) && entry.text.length > typed.length) {
				return entry.text.slice(typed.length);
			}
		}
		return undefined;
	}

	clear(): void {
		this.entries = [];
	}
}
