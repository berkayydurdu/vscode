/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { DiffLine, Hunk, LineDiff } from './protocol';

export type { DiffLine, Hunk, LineDiff };

const MAX_CELLS = 4_000_000;

function splitLines(text: string): string[] {
	if (!text) {
		return [];
	}
	const lines = text.replace(/\r\n/g, '\n').split('\n');
	if (lines.at(-1) === '') {
		lines.pop();
	}
	return lines;
}

/** A line diff with `context` unchanged lines around each change. */
export function diffLines(before: string, after: string, context = 3): LineDiff {
	const a = splitLines(before);
	const b = splitLines(after);
	let start = 0;
	while (start < a.length && start < b.length && a[start] === b[start]) {
		start++;
	}
	let endA = a.length;
	let endB = b.length;
	while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
		endA--;
		endB--;
	}
	const midA = a.slice(start, endA);
	const midB = b.slice(start, endB);
	// Edit script over the changed middle: LCS when small enough, else replace it all.
	const ops: (' ' | '+' | '-')[] = [];
	if (midA.length * midB.length <= MAX_CELLS) {
		const n = midA.length;
		const m = midB.length;
		const table = new Uint32Array((n + 1) * (m + 1));
		for (let i = n - 1; i >= 0; i--) {
			for (let j = m - 1; j >= 0; j--) {
				table[i * (m + 1) + j] = midA[i] === midB[j]
					? table[(i + 1) * (m + 1) + j + 1] + 1
					: Math.max(table[(i + 1) * (m + 1) + j], table[i * (m + 1) + j + 1]);
			}
		}
		let i = 0;
		let j = 0;
		while (i < n || j < m) {
			if (i < n && j < m && midA[i] === midB[j]) {
				ops.push(' ');
				i++;
				j++;
			} else if (i < n && (j >= m || table[(i + 1) * (m + 1) + j] >= table[i * (m + 1) + j + 1])) {
				ops.push('-');
				i++;
			} else {
				ops.push('+');
				j++;
			}
		}
	} else {
		midA.forEach(() => ops.push('-'));
		midB.forEach(() => ops.push('+'));
	}
	// Walk the whole file, then group changes into hunks.
	const all: DiffLine[] = [];
	for (let k = 0; k < start; k++) {
		all.push({ kind: ' ', text: a[k], line: k + 1 });
	}
	let i = start;
	let j = start;
	let added = 0;
	let removed = 0;
	for (const op of ops) {
		if (op === ' ') {
			all.push({ kind: ' ', text: a[i], line: i + 1 });
			i++;
			j++;
		} else if (op === '-') {
			all.push({ kind: '-', text: a[i], line: i + 1 });
			i++;
			removed++;
		} else {
			all.push({ kind: '+', text: b[j], line: j + 1 });
			j++;
			added++;
		}
	}
	for (let k = endA; k < a.length; k++) {
		all.push({ kind: ' ', text: a[k], line: k + 1 });
	}
	const hunks: Hunk[] = [];
	let current: Hunk | undefined;
	let lastChange = -Infinity;
	let oldLine = 1;
	let newLine = 1;
	all.forEach((entry, index) => {
		if (entry.kind !== ' ') {
			if (!current || index - lastChange > context * 2 + 1) {
				if (current) {
					current.lines.push(...all.slice(lastChange + 1, lastChange + 1 + context));
				}
				const from = Math.max(index - context, 0);
				const lead = all.slice(from, index);
				const leadOld = lead.filter(l => l.kind !== '+').length;
				const leadNew = lead.filter(l => l.kind !== '-').length;
				current = { oldStart: oldLine - leadOld, newStart: newLine - leadNew, lines: [...lead] };
				hunks.push(current);
			} else {
				current.lines.push(...all.slice(lastChange + 1, index));
			}
			current.lines.push(entry);
			lastChange = index;
		}
		if (entry.kind !== '+') {
			oldLine++;
		}
		if (entry.kind !== '-') {
			newLine++;
		}
	});
	if (current) {
		current.lines.push(...all.slice(lastChange + 1, lastChange + 1 + context));
	}
	return { added, removed, hunks };
}
