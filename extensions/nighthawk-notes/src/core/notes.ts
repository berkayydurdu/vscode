/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Pure note parsing helpers. This file must not import 'vscode' (or anything
// else) so it can be unit tested with plain Node.

export interface WikiLink {
	/** The note name or relative path the link points at, as written. */
	readonly target: string;
	readonly heading: string | undefined;
	readonly alias: string | undefined;
	/** Offsets of the whole `[[...]]` in the text. */
	readonly start: number;
	readonly end: number;
	/** Offsets of just the target part, used for go-to and link ranges. */
	readonly targetStart: number;
	readonly targetEnd: number;
	readonly line: number;
	readonly embed: boolean;
}

export interface Tag {
	/** Tag name without the leading `#`. */
	readonly name: string;
	readonly start: number;
	readonly end: number;
	readonly line: number;
}

export interface Heading {
	readonly text: string;
	readonly level: number;
	readonly line: number;
}

export interface ParsedNote {
	readonly links: WikiLink[];
	readonly tags: Tag[];
	readonly headings: Heading[];
	readonly aliases: string[];
}

const WIKILINK = /(!?)\[\[([^\[\]\n|#]*)(?:#([^\[\]\n|]*))?(?:\|([^\[\]\n]*))?\]\]/g;
const TAG = /(^|[\s(,;])#([\p{L}\p{N}_\-/]*[\p{L}_\-/][\p{L}\p{N}_\-/]*)/gu;
const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const FENCE = /^\s*(```|~~~)/;

/**
 * Finds wiki links, tags, headings and frontmatter aliases in a Markdown
 * note, skipping fenced code blocks, inline code and frontmatter.
 */
export function parseNote(text: string): ParsedNote {
	const links: WikiLink[] = [];
	const tags: Tag[] = [];
	const headings: Heading[] = [];
	const frontmatter = parseFrontmatter(text);

	let offset = 0;
	let inFence = false;
	const lines = text.split('\n');
	for (let line = 0; line < lines.length; line++) {
		const lineText = lines[line];
		const lineStart = offset;
		offset += lineText.length + 1;

		if (line < frontmatter.endLine) {
			continue;
		}
		if (FENCE.test(lineText)) {
			inFence = !inFence;
			continue;
		}
		if (inFence) {
			continue;
		}

		const masked = maskInlineCode(lineText);
		const heading = HEADING.exec(masked);
		if (heading) {
			headings.push({ level: heading[1].length, text: heading[2], line });
		}

		for (const match of masked.matchAll(WIKILINK)) {
			const target = match[2].trim();
			if (!target && match[3] === undefined) {
				continue;
			}
			const start = lineStart + match.index;
			const targetStart = start + match[1].length + 2 + (match[2].length - match[2].trimStart().length);
			links.push({
				target,
				heading: match[3]?.trim() || undefined,
				alias: match[4]?.trim() || undefined,
				start,
				end: start + match[0].length,
				targetStart,
				targetEnd: targetStart + target.length,
				line,
				embed: match[1] === '!',
			});
		}

		// A line starting with '# ' is a heading, not a tag, and the regex needs
		// at least one non digit so '#1' in "issue #1" is not a tag either.
		for (const match of masked.matchAll(TAG)) {
			const start = lineStart + match.index + match[1].length;
			if (isInsideLink(links, start)) {
				continue;
			}
			const name = match[2].replace(/\/+$/, '');
			tags.push({ name, start, end: start + name.length + 1, line });
		}
	}

	for (const tag of frontmatter.tags) {
		tags.push({ name: tag, start: 0, end: 0, line: 0 });
	}

	return { links, tags, headings, aliases: frontmatter.aliases };
}

function isInsideLink(links: WikiLink[], offset: number): boolean {
	for (let i = links.length - 1; i >= 0; i--) {
		if (offset >= links[i].start && offset < links[i].end) {
			return true;
		}
	}
	return false;
}

/** Replaces inline code spans with spaces so offsets stay the same. */
function maskInlineCode(line: string): string {
	return line.replace(/(`+)[^`]*?\1/g, m => ' '.repeat(m.length));
}

interface Frontmatter {
	readonly endLine: number;
	readonly tags: string[];
	readonly aliases: string[];
}

/**
 * Reads the few frontmatter keys notes care about (`tags`, `aliases`) from
 * a leading `---` block. Supports `key: [a, b]`, `key: a, b` and YAML lists.
 */
export function parseFrontmatter(text: string): Frontmatter {
	if (!text.startsWith('---')) {
		return { endLine: 0, tags: [], aliases: [] };
	}
	const lines = text.split('\n');
	if (lines[0].trim() !== '---') {
		return { endLine: 0, tags: [], aliases: [] };
	}
	const values: Record<string, string[]> = {};
	let current: string | undefined;
	for (let i = 1; i < lines.length; i++) {
		const line = lines[i];
		if (line.trim() === '---' || line.trim() === '...') {
			return { endLine: i + 1, tags: (values.tags ?? []).map(t => t.replace(/^#/, '')), aliases: values.aliases ?? values.alias ?? [] };
		}
		const item = /^\s*-\s+(.*)$/.exec(line);
		if (item && current) {
			values[current].push(unquote(item[1]));
			continue;
		}
		const pair = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
		if (pair) {
			current = pair[1].toLowerCase();
			const raw = pair[2].trim().replace(/^\[(.*)\]$/, '$1');
			values[current] = raw ? raw.split(',').map(unquote).filter(Boolean) : [];
		}
	}
	return { endLine: 0, tags: [], aliases: [] };
}

function unquote(value: string): string {
	return value.trim().replace(/^(['"])(.*)\1$/, '$2').trim();
}

/** `Projects/Launch plan.md` -> `Launch plan` */
export function noteNameFromPath(path: string): string {
	const base = path.split(/[\\/]/).pop() ?? path;
	return base.replace(/\.md$/i, '');
}

/** Key used to compare note names: case and `.md` insensitive, forward slashes. */
export function normalizeNoteKey(name: string): string {
	return name.trim().replace(/\\/g, '/').replace(/^\/+/, '').replace(/\.md$/i, '').toLowerCase();
}

export interface LinkCandidate {
	/** Path relative to the note collection root, with forward slashes. */
	readonly path: string;
	readonly aliases?: readonly string[];
}

/**
 * Resolves a link target like Obsidian does: an exact relative path wins,
 * then a file name match anywhere (shortest path first), then an alias.
 */
export function resolveLink<T extends LinkCandidate>(target: string, candidates: readonly T[]): T | undefined {
	const key = normalizeNoteKey(target);
	if (!key) {
		return undefined;
	}
	let byName: T | undefined;
	let byAlias: T | undefined;
	for (const candidate of candidates) {
		const pathKey = normalizeNoteKey(candidate.path);
		if (pathKey === key) {
			return candidate;
		}
		if (!key.includes('/') && normalizeNoteKey(noteNameFromPath(candidate.path)) === key) {
			if (!byName || candidate.path.length < byName.path.length) {
				byName = candidate;
			}
		} else if (key.includes('/') && pathKey.endsWith('/' + key)) {
			if (!byName || candidate.path.length < byName.path.length) {
				byName = candidate;
			}
		}
		if (!byAlias && candidate.aliases?.some(alias => normalizeNoteKey(alias) === key)) {
			byAlias = candidate;
		}
	}
	return byName ?? byAlias;
}

/**
 * Rewrites links to a renamed note, keeping headings and aliases.
 * Returns the new text, or undefined when nothing changed.
 */
export function rewriteLinks(text: string, links: readonly WikiLink[], isRenamedTarget: (target: string) => boolean, newTarget: string): string | undefined {
	let result = '';
	let last = 0;
	for (const link of links) {
		if (!isRenamedTarget(link.target)) {
			continue;
		}
		result += text.slice(last, link.targetStart) + newTarget;
		last = link.targetEnd;
	}
	return last === 0 ? undefined : result + text.slice(last);
}

/** Turns a title into a safe file name (without extension). */
export function sanitizeFileName(title: string): string {
	return title
		.replace(/[\\/:*?"<>|#^\[\]\u0000-\u001f]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, 120) || 'Untitled';
}

/** Formats a date with the tokens YYYY, MM, DD, HH and mm. */
export function formatDate(date: Date, format: string): string {
	const pad = (n: number) => String(n).padStart(2, '0');
	return format.replace(/YYYY|MM|DD|HH|mm/g, token => {
		switch (token) {
			case 'YYYY': return String(date.getFullYear());
			case 'MM': return pad(date.getMonth() + 1);
			case 'DD': return pad(date.getDate());
			case 'HH': return pad(date.getHours());
			default: return pad(date.getMinutes());
		}
	});
}

/** Fills `{{title}}`, `{{date}}`, `{{time}}` and `{{date:FORMAT}}` in a template. */
export function expandTemplate(template: string, title: string, now: Date): string {
	return template.replace(/\{\{\s*(title|date|time)(?::([^}]+))?\s*\}\}/g, (_, key: string, format: string | undefined) => {
		switch (key) {
			case 'title': return title;
			case 'time': return formatDate(now, format ?? 'HH:mm');
			default: return formatDate(now, format ?? 'YYYY-MM-DD');
		}
	});
}

export interface Block {
	readonly label: string;
	readonly detail: string;
	/** Snippet syntax, inserted in place of the typed `/command`. */
	readonly snippet: string;
}

/** Notion style blocks offered after typing `/` at the start of a line. */
export const BLOCKS: readonly Block[] = [
	{ label: 'h1', detail: 'Heading 1', snippet: '# ${1:Heading}' },
	{ label: 'h2', detail: 'Heading 2', snippet: '## ${1:Heading}' },
	{ label: 'h3', detail: 'Heading 3', snippet: '### ${1:Heading}' },
	{ label: 'todo', detail: 'To-do list', snippet: '- [ ] ${1:Task}' },
	{ label: 'bullet', detail: 'Bulleted list', snippet: '- ${1:Item}' },
	{ label: 'numbered', detail: 'Numbered list', snippet: '1. ${1:Item}' },
	{ label: 'quote', detail: 'Quote', snippet: '> ${1:Quote}' },
	{ label: 'callout', detail: 'Callout', snippet: '> [!${1|NOTE,TIP,IMPORTANT,WARNING,CAUTION|}]\n> ${2:Text}' },
	{ label: 'code', detail: 'Code block', snippet: '```${1:language}\n${2}\n```' },
	{ label: 'table', detail: 'Table', snippet: '| ${1:Column} | ${2:Column} |\n| --- | --- |\n| ${3} | ${4} |' },
	{ label: 'divider', detail: 'Divider', snippet: '---\n' },
	{ label: 'link', detail: 'Link to note', snippet: '[[${1}]]' },
	{ label: 'date', detail: 'Today\'s date', snippet: '${CURRENT_YEAR}-${CURRENT_MONTH}-${CURRENT_DATE}' },
	{ label: 'math', detail: 'Math block', snippet: '$$\n${1}\n$$' },
	{ label: 'mermaid', detail: 'Diagram', snippet: '```mermaid\nflowchart LR\n\t${1:A} --> ${2:B}\n```' },
];
