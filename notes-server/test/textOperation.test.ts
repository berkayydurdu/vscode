/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { apply, compose, diffOperation, isTextOperation, replacementsOperation, replaceOperation, transform, transformOffset, type TextOperation } from '../src/textOperation.ts';

/** A small seeded random generator, so failures can be reproduced. */
function random(seed: number): () => number {
	return () => {
		seed = (seed * 1103515245 + 12345) % 2147483648;
		return seed / 2147483648;
	};
}

function randomOperation(text: string, next: () => number): TextOperation {
	const changes = [];
	let position = 0;
	while (position <= text.length && changes.length < 3) {
		const offset = position + Math.floor(next() * (text.length - position + 1));
		const deleteLength = Math.floor(next() * Math.min(4, text.length - offset + 1));
		changes.push({ offset, deleteLength, text: next() < 0.6 ? 'xyz'.slice(0, 1 + Math.floor(next() * 3)) : '' });
		position = offset + deleteLength + 1;
	}
	return replacementsOperation(changes);
}

describe('text operations', () => {
	it('applies replacements', () => {
		assert.deepStrictEqual({
			replace: apply('hello world', replaceOperation(6, 5, 'there')),
			several: apply('abcdef', replacementsOperation([{ offset: 4, deleteLength: 1, text: 'E' }, { offset: 0, deleteLength: 0, text: '>' }])),
			diff: diffOperation('the cat sat', 'the dog sat'),
			valid: [isTextOperation([3, 'a', -2]), isTextOperation([0]), isTextOperation(['']), isTextOperation('x')],
		}, {
			replace: 'hello there',
			several: '>abcdEf',
			diff: [4, 'dog', -3],
			valid: [true, false, false, false],
		});
	});

	it('converges whatever order concurrent edits arrive in', () => {
		const next = random(7);
		for (let i = 0; i < 2000; i++) {
			const text = 'abcdefghij'.slice(0, Math.floor(next() * 11));
			const a = randomOperation(text, next);
			const b = randomOperation(text, next);
			const [a2, b2] = transform(a, b);
			assert.strictEqual(apply(apply(text, a), b2), apply(apply(text, b), a2), JSON.stringify({ text, a, b }));
			const c = randomOperation(apply(text, a), next);
			assert.strictEqual(apply(text, compose(a, c)), apply(apply(text, a), c), JSON.stringify({ text, a, c }));
		}
	});

	it('moves offsets past text changed before them', () => {
		const op = replacementsOperation([{ offset: 2, deleteLength: 3, text: '' }, { offset: 8, deleteLength: 0, text: 'NEW' }]);
		assert.deepStrictEqual([0, 3, 6, 8, 10].map(offset => transformOffset(offset, op)), [0, 2, 3, 8, 10]);
	});
});
