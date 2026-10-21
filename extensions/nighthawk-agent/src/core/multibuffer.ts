/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Multibuffers (as in Zed): excerpts from many files in one editable
// document. Every excerpt sits under a header line naming its file and
// lines; saving writes each changed excerpt back into its file. As it is one
// document, multiple cursors, find and replace work across all the files.

/** A location to show, with the lines around it. */
export interface Location {
	file: string;
	/** 0-based first and last line of the match. */
	start: number;
	end: number;
}

export interface Excerpt {
	file: string;
	/** Shown in the header, usually the path relative to the workspace. */
	label: string;
	/** 0-based line in the file where the excerpt begins. */
	start: number;
	/** The excerpt's lines as they were in the file when it was read. */
	lines: string[];
}

export interface Rendered {
	text: string;
	/** 0-based line of each excerpt's header in the text. */
	headers: number[];
}

/** A replacement of whole lines in one file. */
export interface LineEdit {
	file: string;
	start: number;
	/** How many of the file's lines it replaces. */
	count: number;
	lines: string[];
}

export interface WritePlan {
	edits: LineEdit[];
	/** Excerpts that changed in their file since they were read, by label. */
	conflicts: string[];
	/** The excerpts as they will be once the edits are written. */
	excerpts: Excerpt[];
}

const RULE = '────';
const HEADER = /^──── (?<label>.+) · (?<lines>lines? \d+(?:-\d+)?) ─*$/;

/** The header line above an excerpt. */
export function header(excerpt: Excerpt): string {
	const first = excerpt.start + 1;
	const last = excerpt.start + excerpt.lines.length;
	const lines = last > first ? `lines ${first}-${last}` : `line ${first}`;
	return `${RULE} ${excerpt.label} · ${lines} ${RULE}`;
}

export function isHeader(line: string): boolean {
	return HEADER.test(line);
}

/**
 * Turns locations into excerpts with `context` lines around each, merging
 * locations in the same file whose excerpts would touch. Files keep the
 * order they first appear in; excerpts within a file go top to bottom.
 */
export function excerptsFor(locations: Location[], readLines: (file: string) => string[] | undefined, label: (file: string) => string, context = 2): Excerpt[] {
	const byFile = new Map<string, Location[]>();
	for (const location of locations) {
		const list = byFile.get(location.file) ?? [];
		list.push(location);
		byFile.set(location.file, list);
	}
	const excerpts: Excerpt[] = [];
	for (const [file, list] of byFile) {
		const lines = readLines(file);
		if (!lines) {
			continue;
		}
		const ranges = list
			.map(l => [Math.max(0, l.start - context), Math.min(lines.length - 1, l.end + context)] as [number, number])
			.filter(([start, end]) => start <= end)
			.sort((a, b) => a[0] - b[0]);
		const merged: [number, number][] = [];
		for (const range of ranges) {
			const last = merged.at(-1);
			// A gap of one line costs no more than the header that would replace it.
			if (last && range[0] <= last[1] + 2) {
				last[1] = Math.max(last[1], range[1]);
			} else {
				merged.push([...range]);
			}
		}
		for (const [start, end] of merged) {
			excerpts.push({ file, label: label(file), start, lines: lines.slice(start, end + 1) });
		}
	}
	return excerpts;
}

export function render(excerpts: Excerpt[]): Rendered {
	const out: string[] = [];
	const headers: number[] = [];
	for (const excerpt of excerpts) {
		headers.push(out.length);
		out.push(header(excerpt), ...excerpt.lines);
	}
	// It ends with a newline, which parse() drops, so a blank last line survives.
	return { text: out.length ? `${out.join('\n')}\n` : '', headers };
}

/** The 0-based line in its file of a line in the rendered text, or undefined on a header. */
export function sourceLine(excerpts: Excerpt[], line: number): { excerpt: Excerpt; line: number } | undefined {
	let at = 0;
	for (const excerpt of excerpts) {
		if (line === at) {
			return { excerpt, line: excerpt.start };
		}
		if (line <= at + excerpt.lines.length) {
			return { excerpt, line: excerpt.start + line - at - 1 };
		}
		at += excerpt.lines.length + 1;
	}
	return undefined;
}

/**
 * Splits an edited buffer back into excerpts. Throws when the headers were
 * changed, as there is then no telling which text belongs to which file.
 */
export function parse(text: string, excerpts: Excerpt[]): string[][] {
	const lines = text.split(/\r?\n/);
	// The final newline render() adds is not a line of the last excerpt.
	if (lines.length > 1 && lines.at(-1) === '') {
		lines.pop();
	}
	const starts = lines.flatMap((line, index) => isHeader(line) ? [index] : []);
	if (starts.length !== excerpts.length || (excerpts.length && starts[0] !== 0)) {
		throw new Error('The header lines were changed or removed. Undo that, or reopen the multibuffer.');
	}
	return starts.map((start, i) => lines.slice(start + 1, starts[i + 1] ?? lines.length));
}

/**
 * What saving the edited excerpts writes: for each changed excerpt, its old
 * lines replaced with the new ones, unless the file changed under it.
 * `current` gives a file's lines as they are now.
 */
export function planWrite(excerpts: Excerpt[], edited: string[][], current: (file: string) => string[] | undefined): WritePlan {
	const edits: LineEdit[] = [];
	const conflicts: string[] = [];
	const shift = new Map<string, number>();
	const next: Excerpt[] = [];
	excerpts.forEach((excerpt, i) => {
		const lines = edited[i];
		const delta = shift.get(excerpt.file) ?? 0;
		const changed = lines.length !== excerpt.lines.length || lines.some((line, j) => line !== excerpt.lines[j]);
		if (!changed) {
			next.push({ ...excerpt, start: excerpt.start + delta });
			return;
		}
		const now = current(excerpt.file);
		const same = now && excerpt.lines.every((line, j) => now[excerpt.start + j] === line);
		if (!same) {
			conflicts.push(excerpt.label);
			next.push({ ...excerpt, start: excerpt.start + delta });
			return;
		}
		edits.push({ file: excerpt.file, start: excerpt.start, count: excerpt.lines.length, lines });
		next.push({ ...excerpt, start: excerpt.start + delta, lines });
		shift.set(excerpt.file, delta + lines.length - excerpt.lines.length);
	});
	return { edits, conflicts, excerpts: next };
}
