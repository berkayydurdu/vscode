/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { LiveDocumentState, parseEvents } from '../src/core/liveClient.ts';
import { apply, diffOperation, replaceOperation, transform, type TextOperation } from '../src/core/textOperation.ts';

/** A seeded random generator, so failures can be reproduced. */
function random(seed: number): () => number {
	return () => {
		seed = (seed * 1103515245 + 12345) % 2147483648;
		return seed / 2147483648;
	};
}

/** What the notes server does with an edit: adjust it for later edits, then apply it. */
class FakeServer {
	text: string;
	history: TextOperation[] = [];
	constructor(text: string) {
		this.text = text;
	}
	receive(revision: number, op: TextOperation): TextOperation {
		for (const concurrent of this.history.slice(revision)) {
			op = transform(op, concurrent)[0];
		}
		this.text = apply(this.text, op);
		this.history.push(op);
		return op;
	}
}

interface FakeEditor {
	name: string;
	text: string;
	state: LiveDocumentState;
	/** Edits on their way to the server, with the revision they were made at. */
	sending: { revision: number; op: TextOperation }[];
	/** Server events not delivered yet. */
	inbox: { from: string; op: TextOperation }[];
}

describe('live editing client', () => {
	it('keeps the copy of the note-server operations in step', () => {
		const root = join(import.meta.dirname, '..', '..', '..');
		assert.strictEqual(
			readFileSync(join(root, 'extensions', 'nighthawk-notes', 'src', 'core', 'textOperation.ts'), 'utf8'),
			readFileSync(join(root, 'notes-server', 'src', 'textOperation.ts'), 'utf8'),
		);
	});

	it('ends with the same text in every editor, whatever the timing', () => {
		const next = random(11);
		for (let round = 0; round < 200; round++) {
			const server = new FakeServer('hello world\n');
			const editors: FakeEditor[] = ['a', 'b', 'c'].map(name => ({ name, text: server.text, state: new LiveDocumentState(0, server.text), sending: [], inbox: [] }));
			const send = (editor: FakeEditor, op: TextOperation | undefined) => op && editor.sending.push({ revision: editor.state.revision, op });
			for (let step = 0; step < 60; step++) {
				const editor = editors[Math.floor(next() * editors.length)];
				const choice = next();
				if (choice < 0.4) {
					// Type or delete somewhere.
					const offset = Math.floor(next() * (editor.text.length + 1));
					const length = Math.floor(next() * Math.min(3, editor.text.length - offset + 1));
					const op = replaceOperation(offset, length, next() < 0.7 ? editor.name.repeat(1 + Math.floor(next() * 2)) : '');
					editor.text = apply(editor.text, op);
					send(editor, editor.state.local(op));
				} else if (choice < 0.7 && editor.sending.length) {
					// The server takes the edit and tells everyone, in order.
					const { revision, op } = editor.sending.shift()!;
					const applied = server.receive(revision, op);
					editors.forEach(e => e.inbox.push({ from: editor.name, op: applied }));
				} else if (editor.inbox.length) {
					const { from, op } = editor.inbox.shift()!;
					if (from === editor.name) {
						send(editor, editor.state.acknowledged());
					} else {
						editor.text = apply(editor.text, editor.state.incoming(op));
						editor.state.remote(op);
					}
				}
			}
			// Deliver everything left.
			while (editors.some(e => e.sending.length || e.inbox.length)) {
				for (const editor of editors) {
					while (editor.sending.length) {
						const { revision, op } = editor.sending.shift()!;
						const applied = server.receive(revision, op);
						editors.forEach(e => e.inbox.push({ from: editor.name, op: applied }));
					}
					while (editor.inbox.length) {
						const { from, op } = editor.inbox.shift()!;
						if (from === editor.name) {
							send(editor, editor.state.acknowledged());
						} else {
							editor.text = apply(editor.text, editor.state.incoming(op));
							editor.state.remote(op);
						}
					}
				}
			}
			assert.deepStrictEqual(editors.map(e => [e.text, e.state.confirmed]), editors.map(() => [server.text, server.text]), `round ${round}`);
		}
	});

	it('reads server-sent events split across chunks', () => {
		const first = parseEvents('event: op\ndata: {"revision":1}\n\n: ping\n\nevent: sav');
		const second = parseEvents(first.rest + 'ed\ndata: {}\n\n');
		assert.deepStrictEqual([first.events, second.events, second.rest], [
			[{ event: 'op', data: '{"revision":1}' }],
			[{ event: 'saved', data: '{}' }],
			'',
		]);
	});

	it('merges the editor and the server after reconnecting', () => {
		// What both had last, what the editor has now, and what the server has now.
		const base = 'one two three';
		const mine = diffOperation(base, 'one 2 three');
		const theirs = diffOperation(base, 'one two three four');
		const [mine2, theirs2] = transform(mine, theirs);
		assert.deepStrictEqual([apply('one 2 three', theirs2), apply('one two three four', mine2)], ['one 2 three four', 'one 2 three four']);
	});
});
