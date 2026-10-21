/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CodeStream, editHunks, editStats, fitCode, inlineEditRequest, type EditTarget } from '../src/core/inlineEdit.ts';
import { textOf } from '../src/core/types.ts';

function read(chunks: string[]): { streamed: string[]; code: string[] } {
	const stream = new CodeStream();
	const streamed = chunks.flatMap(chunk => stream.push(chunk));
	streamed.push(...stream.end());
	return { streamed, code: stream.code };
}

describe('inline edit', () => {
	it('reads code as it streams, without fences, markers or chatter', () => {
		assert.deepStrictEqual(read(['function a() {\n  ret', 'urn 1;\n}']), { streamed: ['function a() {', '  return 1;', '}'], code: ['function a() {', '  return 1;', '}'] });
		assert.deepStrictEqual(read(['```ts\nconst x = 1;\n', '\nconst y = 2;\n```\nThis adds y.']).code, ['const x = 1;', '', 'const y = 2;']);
		assert.deepStrictEqual(read(['\n\n<selection>\nlet a;\n</selection>\n']).code, ['let a;']);
		assert.deepStrictEqual(read(['a\r\nb\r\n']).code, ['a', 'b']);
	});

	it('keeps the blank lines around the selection and its indentation', () => {
		assert.deepStrictEqual(fitCode(['', 'return a + b;', ''], ['', '    return a - b;', '']), ['', '    return a + b;', '']);
		assert.deepStrictEqual(fitCode(['  if (x) {', '    y();', '  }'], ['  y();']), ['  if (x) {', '    y();', '  }']);
		assert.deepStrictEqual(fitCode(['log();'], [], '\t\t'), ['\t\tlog();']);
	});

	it('finds the changed lines', () => {
		const original = ['a', 'b', 'c', 'd', 'e'];
		const updated = ['a', 'B', 'c', 'e', 'f'];
		const hunks = editHunks(original, updated);
		assert.deepStrictEqual(hunks, [
			{ start: 1, added: 1, removed: ['b'] },
			{ start: 3, added: 0, removed: ['d'] },
			{ start: 4, added: 1, removed: [] },
		]);
		assert.deepStrictEqual(editStats(hunks), { added: 2, removed: 2 });
		assert.deepStrictEqual(editHunks([], ['x', 'y']), [{ start: 0, added: 2, removed: [] }]);
		assert.deepStrictEqual(editHunks(['x'], []), [{ start: 0, added: 0, removed: ['x'] }]);
		assert.deepStrictEqual(editHunks(['x'], ['x']), []);
	});

	it('marks the selection and carries follow-ups', () => {
		const target: EditTarget = { path: 'src/a.ts', languageId: 'typescript', before: ['import x;', ''], selected: ['let a = 1;'], after: ['export {};'], problems: ['line 3: Unused a'] };
		const first = inlineEditRequest(target, 'use const');
		assert.equal(first.messages.length, 1);
		const prompt = textOf(first.messages[0]);
		assert.match(prompt, /import x;\n\n<selection>\nlet a = 1;\n<\/selection>\nexport \{\};/);
		assert.match(prompt, /Unused a/);
		assert.match(prompt, /Instruction: use const$/);
		const followUp = inlineEditRequest(target, 'and name it b', [{ instruction: 'use const', code: 'const a = 1;' }]);
		assert.deepStrictEqual(followUp.messages.map(m => [m.role, textOf(m).split('\n')[0]]), [
			['user', 'File: src/a.ts (typescript)'],
			['assistant', 'const a = 1;'],
			['user', 'Change your code: and name it b'],
		]);
		assert.match(textOf(followUp.messages[0]), /Instruction: use const$/);
		const insert = inlineEditRequest({ ...target, selected: [] }, 'add a logger');
		assert.match(textOf(insert.messages[0]), /\n<cursor\/>\nexport/);
		assert.match(insert.system, /insert at the <cursor\/>/);
	});

	it('leaves out the far ends of big files', () => {
		const line = 'x'.repeat(99);
		const target: EditTarget = { path: 'big.txt', languageId: 'plaintext', before: Array(1000).fill(line), selected: ['y'], after: Array(1000).fill(line) };
		const prompt = textOf(inlineEditRequest(target, 'z').messages[0]);
		assert.match(prompt, /\[600 lines above left out\]/);
		assert.match(prompt, /\[800 lines below left out\]/);
	});
});
