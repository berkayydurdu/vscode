/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { after, describe, it } from 'node:test';
import { findMatches, parsePattern, replaceAll } from '../src/core/structural.ts';
import { BUILTIN_TOOLS, SessionState } from '../src/core/tools.ts';
import { NodeWorkspace } from '../src/core/workspace.ts';

const code = [
	'console.log("start");',
	'console.log( `user ${id}`, /* who */ user );',
	'console.error(err);',
	'foo(1, 2, bar(3, 4));',
	'foo();',
	'if (ok) {return ok;}',
	'if (ok) { return other; }',
	'const s = "console.log(x)";',
	'function f(a, b) {',
	'\tconst c = a + b;',
	'\treturn c * 2;',
	'}',
].join('\n');

const find = (pattern: string, text = code, file = 'x.ts') => findMatches(parsePattern(pattern, file), text, file).map(m => [m.text, m.bindings]);

describe('structural search', () => {
	it('matches by tokens, ignoring spacing and comments, and binds holes', () => {
		assert.deepEqual(find('console.log($MSG)'), [
			['console.log("start")', { MSG: '"start"' }],
		]);
		assert.deepEqual(find('console.log($$$ARGS)'), [
			['console.log("start")', { ARGS: '"start"' }],
			['console.log( `user ${id}`, /* who */ user )', { ARGS: '`user ${id}`, /* who */ user' }],
		]);
		assert.deepEqual(find('foo($A, $$$REST)'), [['foo(1, 2, bar(3, 4))', { A: '1', REST: '2, bar(3, 4)' }]]);
		assert.deepEqual(find('foo($$$)'), [['foo(1, 2, bar(3, 4))', {}], ['foo()', {}]]);
	});

	it('needs a repeated name to match the same code', () => {
		assert.deepEqual(find('if ($X) { return $X; }'), [['if (ok) {return ok;}', { X: 'ok' }]]);
	});

	it('lets $$$ span statements inside brackets', () => {
		assert.deepEqual(find('function $NAME($$$PARAMS) { $$$BODY }'), [[
			'function f(a, b) {\n\tconst c = a + b;\n\treturn c * 2;\n}',
			{ NAME: 'f', PARAMS: 'a, b', BODY: '\n\tconst c = a + b;\n\treturn c * 2;' },
		]]);
	});

	it('uses the comment style of the language', () => {
		assert.deepEqual(find('print($X)', 'print(1)  # print(2)\nprint(3)', 'a.py'), [['print(1)', { X: '1' }], ['print(3)', { X: '3' }]]);
	});

	it('replaces matches, filling in the holes', () => {
		const pattern = parsePattern('console.log($$$ARGS)');
		const text = 'a();\nconsole.log(x, y);\nconsole.log();\n';
		assert.equal(replaceAll(text, findMatches(pattern, text), 'logger.debug($$$ARGS)'), 'a();\nlogger.debug(x, y);\nlogger.debug();\n');
		const commented = 'console.log(\n\ta,\n\tb, // why\n);';
		assert.equal(replaceAll(commented, findMatches(pattern, commented), 'logger.debug($$$ARGS)'), 'logger.debug(\n\ta,\n\tb, // why\n);');
	});

	it('rejects patterns with unpaired brackets', () => {
		assert.throws(() => parsePattern('foo($A'), /missing a "\)"/);
		assert.throws(() => parsePattern('foo]'), /unmatched "\]"/);
		assert.throws(() => parsePattern('  '), /empty/);
	});

	it('gives the agent a StructuralSearch tool', async () => {
		const dir = mkdtempSync(path.join(tmpdir(), 'nh-structural-'));
		after(() => rmSync(dir, { recursive: true, force: true }));
		writeFileSync(path.join(dir, 'a.ts'), 'fetch(url, {\n\tmethod: "POST",\n});\nfetch(other);\n');
		writeFileSync(path.join(dir, 'b.md'), 'fetch(url, { method: "GET" })\n');
		const tool = BUILTIN_TOOLS.find(t => t.spec.name === 'StructuralSearch')!;
		const context = { workspace: new NodeWorkspace([dir]), state: new SessionState(), signal: new AbortController().signal, progress: () => undefined };
		const result = await tool.run({ pattern: 'fetch($URL, { $$$OPTS })', glob: '*.ts' }, context);
		assert.deepEqual([result.summary, result.content], ['1 matches', 'a.ts:1: fetch(url, { method: "POST", })\n    $URL = url; $OPTS = method: "POST",']);
		await assert.rejects(tool.run({ pattern: 'fetch(' }, context), /missing a "\)"/);
	});
});
