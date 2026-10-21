/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { excerptsFor, parse, planWrite, render, sourceLine } from '../src/core/multibuffer.ts';

const files: Record<string, string[]> = {
	'/w/a.ts': ['import x from "x";', '', 'export function greet(name: string) {', '\treturn `Hi ${name}`;', '}', '', 'greet("a");', 'greet("b");', ''],
	'/w/b.ts': ['import { greet } from "./a";', 'greet("c");'],
};
const read = (file: string) => files[file];
const label = (file: string) => file.slice(3);

describe('multibuffers', () => {
	it('merges nearby matches into excerpts and renders them under headers', () => {
		const excerpts = excerptsFor([
			{ file: '/w/a.ts', start: 2, end: 2 },
			{ file: '/w/b.ts', start: 1, end: 1 },
			{ file: '/w/a.ts', start: 6, end: 6 },
			{ file: '/w/missing.ts', start: 0, end: 0 },
		], read, label, 1);
		const rendered = render(excerpts);
		assert.deepEqual([excerpts.map(e => [e.label, e.start, e.lines.length]), rendered.headers, rendered.text.split('\n')], [
			[['a.ts', 1, 7], ['b.ts', 0, 2]],
			[0, 8],
			[
				'──── a.ts · lines 2-8 ────',
				'',
				'export function greet(name: string) {',
				'\treturn `Hi ${name}`;',
				'}',
				'',
				'greet("a");',
				'greet("b");',
				'──── b.ts · lines 1-2 ────',
				'import { greet } from "./a";',
				'greet("c");',
				'',
			],
		]);
		assert.deepEqual([sourceLine(excerpts, 0)?.line, sourceLine(excerpts, 2)?.line, sourceLine(excerpts, 10)?.excerpt.label, sourceLine(excerpts, 10)?.line, sourceLine(excerpts, 11)], [1, 2, 'b.ts', 1, undefined]);
	});

	it('writes edited excerpts back, keeping later excerpts of a file in place', () => {
		const excerpts = excerptsFor([{ file: '/w/a.ts', start: 2, end: 2 }, { file: '/w/a.ts', start: 7, end: 7 }, { file: '/w/b.ts', start: 1, end: 1 }], read, label, 0);
		const text = render(excerpts).text
			.replace('export function greet(name: string) {', 'export function greet(name: string) {\n\t// Says hi.')
			.replace('greet("b");', 'greet("B");');
		const plan = planWrite(excerpts, parse(text, excerpts), read);
		assert.deepEqual([plan.edits, plan.conflicts, plan.excerpts.map(e => [e.label, e.start, e.lines])], [
			[
				{ file: '/w/a.ts', start: 2, count: 1, lines: ['export function greet(name: string) {', '\t// Says hi.'] },
				{ file: '/w/a.ts', start: 7, count: 1, lines: ['greet("B");'] },
			],
			[],
			[['a.ts', 2, ['export function greet(name: string) {', '\t// Says hi.']], ['a.ts', 8, ['greet("B");']], ['b.ts', 1, ['greet("c");']]],
		]);
	});

	it('refuses to write over a file that changed, or when headers were removed', () => {
		const excerpts = excerptsFor([{ file: '/w/b.ts', start: 1, end: 1 }], read, label, 0);
		const edited = parse(render(excerpts).text.replace('"c"', '"d"'), excerpts);
		assert.deepEqual(planWrite(excerpts, edited, () => ['import { greet } from "./a";', 'greet("changed");']).conflicts, ['b.ts']);
		assert.throws(() => parse('greet("c");\n', excerpts), /header lines/);
	});
});
