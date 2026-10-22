/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Structural search and replace (as in JetBrains IDEs, comby and ast-grep):
// patterns match code by its tokens and brackets rather than its text, so
// spacing, line breaks and comments do not matter. `$NAME` stands for one
// expression or argument, `$$$NAME` for any number of them, and a name used
// twice must match the same code both times:
//
//   console.log($MSG)            matches  console.log( `user ${id}` )
//   foo($A, $$$REST)             matches  foo(1, 2, bar(3))
//   if ($X) { return $X; }       matches  if (ok) {return ok;}

type TokenKind = 'word' | 'string' | 'punct' | 'open' | 'close';

interface Token {
	kind: TokenKind;
	text: string;
	start: number;
	end: number;
}

type PatternPart =
	| { kind: 'token'; token: Token }
	| { kind: 'hole'; name: string; many: boolean };

export interface Pattern {
	parts: PatternPart[];
	/** The longest literal word, for skipping files that cannot match. */
	anchor: string;
}

export interface StructuralMatch {
	start: number;
	end: number;
	text: string;
	/** What each `$NAME` matched, as it appears in the code. */
	bindings: Record<string, string>;
}

const OPEN = '([{';
const CLOSE = ')]}';
const HOLE = /^\$(?<many>\$\$)?(?<name>[A-Z_][A-Z0-9_]*)?$/;

/** Line comment markers by file extension; block comments are C style except where noted. */
function commentStyle(file: string): { line: string[]; block: [string, string][] } {
	const ext = file.slice(file.lastIndexOf('.') + 1).toLowerCase();
	if (['py', 'rb', 'sh', 'bash', 'zsh', 'yml', 'yaml', 'toml', 'r', 'pl', 'ps1', 'cmake', 'dockerfile', 'makefile'].includes(ext)) {
		return { line: ['#'], block: ext === 'ps1' ? [['<#', '#>']] : [] };
	}
	if (['sql', 'lua', 'hs'].includes(ext)) {
		return { line: ['--'], block: ext === 'lua' ? [['--[[', ']]']] : ext === 'hs' ? [['{-', '-}']] : [['/*', '*/']] };
	}
	if (['html', 'htm', 'xml', 'svg', 'vue', 'svelte'].includes(ext)) {
		return { line: ['//'], block: [['<!--', '-->'], ['/*', '*/']] };
	}
	if (['css', 'scss', 'less'].includes(ext)) {
		return { line: ext === 'css' ? [] : ['//'], block: [['/*', '*/']] };
	}
	return { line: ['//'], block: [['/*', '*/']] };
}

/** Splits code into words, strings and punctuation, skipping spaces and comments. */
export function tokenize(text: string, file = 'x.ts', pattern = false): Token[] {
	const style = commentStyle(file);
	const tokens: Token[] = [];
	let i = 0;
	while (i < text.length) {
		const c = text[i];
		if (/\s/.test(c)) {
			i++;
			continue;
		}
		const block = style.block.find(([open]) => text.startsWith(open, i));
		if (block) {
			const end = text.indexOf(block[1], i + block[0].length);
			i = end < 0 ? text.length : end + block[1].length;
			continue;
		}
		if (style.line.some(marker => text.startsWith(marker, i)) && !(pattern && c === '$')) {
			const end = text.indexOf('\n', i);
			i = end < 0 ? text.length : end;
			continue;
		}
		const start = i;
		if (c === '"' || c === '\'' || c === '`') {
			i++;
			while (i < text.length && text[i] !== c) {
				i += text[i] === '\\' ? 2 : 1;
				if (c !== '`' && text[i] === '\n') {
					break;
				}
			}
			i = Math.min(text.length, i + 1);
			tokens.push({ kind: 'string', text: text.slice(start, i), start, end: i });
			continue;
		}
		if (/[\p{L}\p{N}_$@#]/u.test(c)) {
			while (i < text.length && /[\p{L}\p{N}_$@#]/u.test(text[i])) {
				i++;
			}
			// 1.5 and 0x1F stay one number.
			if (/^\d/.test(text.slice(start, i)) && text[i] === '.' && /\d/.test(text[i + 1] ?? '')) {
				i++;
				while (i < text.length && /[\p{L}\p{N}_]/u.test(text[i])) {
					i++;
				}
			}
			tokens.push({ kind: 'word', text: text.slice(start, i), start, end: i });
			continue;
		}
		i++;
		tokens.push({ kind: OPEN.includes(c) ? 'open' : CLOSE.includes(c) ? 'close' : 'punct', text: c, start, end: i });
	}
	return tokens;
}

/** Reads a pattern; throws when its brackets do not pair up. */
export function parsePattern(source: string, file = 'x.ts'): Pattern {
	const parts: PatternPart[] = [];
	const stack: string[] = [];
	let anchor = '';
	for (const token of tokenize(source, file, true)) {
		const hole = token.kind === 'word' ? HOLE.exec(token.text) : null;
		if (hole?.groups) {
			// `$_` and `$$$` match anything without binding a name.
			const name = hole.groups.name === '_' ? '' : hole.groups.name ?? '';
			parts.push({ kind: 'hole', name, many: !!hole.groups.many });
			continue;
		}
		if (token.kind === 'open') {
			stack.push(CLOSE[OPEN.indexOf(token.text)]);
		} else if (token.kind === 'close' && stack.pop() !== token.text) {
			throw new Error(`The pattern has an unmatched "${token.text}".`);
		}
		if ((token.kind === 'word' || token.kind === 'string') && token.text.length > anchor.length) {
			anchor = token.text;
		}
		parts.push({ kind: 'token', token });
	}
	if (stack.length) {
		throw new Error(`The pattern is missing a "${stack.at(-1)}".`);
	}
	if (!parts.length) {
		throw new Error('The pattern is empty.');
	}
	return { parts, anchor };
}

/** Where each bracket's partner is, so a hole can skip over a whole bracketed group. */
function partners(tokens: Token[]): Int32Array {
	const result = new Int32Array(tokens.length).fill(-1);
	const stack: number[] = [];
	tokens.forEach((token, index) => {
		if (token.kind === 'open') {
			stack.push(index);
		} else if (token.kind === 'close') {
			// Unbalanced code, such as a stray bracket in a regex, just stays unpaired.
			const open = stack.length && CLOSE.indexOf(token.text) === OPEN.indexOf(tokens[stack.at(-1)!].text) ? stack.pop() : undefined;
			if (open !== undefined) {
				result[open] = index;
				result[index] = open;
			}
		}
	});
	return result;
}

/**
 * The code a hole matched. A comment right after its last token stays with
 * it, up to the next token, so a replacement does not drop it; so does a
 * line break before its first token, so arguments on their own lines stay there.
 */
function holeText(text: string, tokens: Token[], from: number, to: number): string {
	const end = tokens[to - 1].end;
	const next = tokens[to]?.start ?? text.length;
	const previous = from > 0 ? tokens[from - 1].end : 0;
	const before = text.slice(previous, tokens[from].start);
	const start = /^\s*\n\s*$/.test(before) ? previous : tokens[from].start;
	return text.slice(start, /\S/.test(text.slice(end, next)) ? next : end);
}

const normalized = (tokens: Token[], from: number, to: number) => tokens.slice(from, to).map(t => t.text).join(' ');

/**
 * Finds the pattern in code. Matches do not overlap; each starts as early
 * as it can and holes take as little as they can.
 */
export function findMatches(pattern: Pattern, text: string, file = 'x.ts', limit = 1000): StructuralMatch[] {
	if (pattern.anchor && !text.includes(pattern.anchor.replace(/^['"`]|['"`]$/g, ''))) {
		return [];
	}
	const tokens = tokenize(text, file);
	const pairs = partners(tokens);
	const matches: StructuralMatch[] = [];
	let steps = 0;

	type Bound = ReadonlyMap<string, [number, number]>;
	// Matches parts[p..] from token t: the index after the match and what the holes took, or undefined.
	const match = (p: number, t: number, bound: Bound): { end: number; bound: Bound } | undefined => {
		if (++steps > 2_000_000) {
			return undefined;
		}
		if (p === pattern.parts.length) {
			return { end: t, bound };
		}
		const part = pattern.parts[p];
		if (part.kind === 'token') {
			return tokens[t]?.text === part.token.text ? match(p + 1, t + 1, bound) : undefined;
		}
		const previous = part.name ? bound.get(part.name) : undefined;
		if (previous) {
			const length = previous[1] - previous[0];
			return normalized(tokens, previous[0], previous[1]) === normalized(tokens, t, t + length) ? match(p + 1, t + length, bound) : undefined;
		}
		const take = (end: number) => match(p + 1, end, part.name ? new Map(bound).set(part.name, [t, end]) : bound);
		// The shortest stretch first, a token or a whole bracketed group at a time. A hole never
		// leaves its brackets; `$X` also stops at "," and ";", while `$$$X` may span them.
		if (part.many) {
			const empty = take(t);
			if (empty) {
				return empty;
			}
		}
		for (let end = t; end < tokens.length;) {
			const token = tokens[end];
			if (token.kind === 'close' || (!part.many && (token.text === ',' || token.text === ';'))) {
				return undefined;
			}
			end = token.kind === 'open' && pairs[end] > end ? pairs[end] + 1 : end + 1;
			const result = take(end);
			if (result) {
				return result;
			}
		}
		return undefined;
	};

	for (let t = 0; t < tokens.length && matches.length < limit;) {
		const found = match(0, t, new Map());
		if (found && found.end > t) {
			const start = tokens[t].start;
			const stop = tokens[found.end - 1].end;
			const bindings: Record<string, string> = {};
			for (const [name, [from, to]] of found.bound) {
				bindings[name] = to > from ? holeText(text, tokens, from, to) : '';
			}
			matches.push({ start, end: stop, text: text.slice(start, stop), bindings });
			t = found.end;
		} else {
			t++;
		}
	}
	return matches;
}

/** The replacement for a match, with each `$NAME` and `$$$NAME` filled in. */
export function replacementFor(template: string, match: StructuralMatch): string {
	return template.replace(/\$(\$\$)?([A-Z_][A-Z0-9_]*)/g, (whole, _many: string | undefined, name: string) => match.bindings[name] ?? whole);
}

/** The code with every match replaced. */
export function replaceAll(text: string, matches: StructuralMatch[], template: string): string {
	let out = '';
	let at = 0;
	for (const match of matches) {
		out += text.slice(at, match.start) + replacementFor(template, match);
		at = match.end;
	}
	return out + text.slice(at);
}
