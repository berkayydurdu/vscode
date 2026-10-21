/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { EDIT_PAUSE_MS, EditHistory, editSnippets, nextEditRequest, parseNextEdit, type NextEditTarget } from '../src/core/nextEdit.ts';
import { textOf } from '../src/core/types.ts';

const file = [
	'function greet(userName: string) {',
	'\tconsole.log(userName);',
	'\treturn userName.length;',
	'}',
	'',
].join('\n');

function target(text: string, edits: string[] = []): NextEditTarget {
	const cursor = text.indexOf('|');
	return { path: 'src/a.ts', languageId: 'typescript', text: text.slice(0, cursor) + text.slice(cursor + 1), cursor, edits };
}

describe('next edit', () => {
	it('splits typing into edits at pauses', () => {
		const history = new EditHistory();
		history.open('a', 'one\ntwo\n', 0);
		history.change('a', 'one!\ntwo\n', 100);
		history.change('a', 'one!!\ntwo\n', 200);
		assert.deepEqual(history.recent('a', 300), ['@@ line 1\n-one\n+one!!\n two']);
		history.change('a', 'one!!\ntwo?\n', 200 + EDIT_PAUSE_MS);
		assert.deepEqual(history.recent('a', 2000), ['@@ line 1\n-one\n+one!!\n two', '@@ line 1\n one!!\n-two\n+two?']);
	});

	it('forgets edits after a while and files that close', () => {
		const history = new EditHistory();
		history.open('a', 'x\n', 0);
		history.change('a', 'y\n', 10);
		assert.equal(history.recent('a', 10 * 60_000).length, 0);
		history.close('a');
		assert.equal(history.recent('a', 20).length, 0);
	});

	it('shows each changed place with a line around it', () => {
		assert.deepEqual(editSnippets('a\nb\nc\n', 'a\nB\nc\n'), ['@@ line 1\n a\n-b\n+B\n c']);
	});

	it('sends the recent edits and the file around the cursor', () => {
		const request = nextEditRequest(target(file.replace('function greet(userName', 'function greet(name|'), ['@@ line 1\n-function greet(userName: string) {\n+function greet(name: string) {']));
		const text = textOf(request.messages[0]);
		assert.match(text, /<edit>\n@@ line 1\n-function greet\(userName/);
		assert.match(text, /function greet\(name<CURSOR>: string\)/);
		assert.match(request.system ?? '', /<none\/>/);
	});

	it('cuts long files to the lines around the cursor', () => {
		const long = Array.from({ length: 400 }, (_, i) => `line ${i}`).join('\n');
		const text = textOf(nextEditRequest(target(long.replace('line 200', 'line 200|'))).messages[0]);
		assert.match(text, /\[earlier lines left out\]\nline 120\n/);
		assert.match(text, /line 280\n\[later lines left out\]/);
		assert.doesNotMatch(text, /line 119\n/);
	});

	it('finds the edit in the file and trims the lines it keeps', () => {
		const t = target(file.replace('function greet(userName', 'function greet(name|'));
		const edit = parseNextEdit('<old>\tconsole.log(userName);\n\treturn userName.length;</old>\n<new>\tconsole.log(userName);\n\treturn name.length;</new>', t);
		assert.ok(edit);
		assert.equal(t.text.slice(edit.start, edit.end), '\treturn userName.length;');
		assert.equal(edit.text, '\treturn name.length;');
	});

	it('picks the copy nearest the cursor', () => {
		const t = target('a = 1;\nb = 2;\na = 1;\n|\nc = 3;\n');
		const edit = parseNextEdit('<old>a = 1;</old><new>a = 2;</new>', t);
		assert.equal(edit?.start, 'a = 1;\nb = 2;\n'.length);
	});

	it('gives up on no edit, text not in the file, or no change', () => {
		const t = target(file.replace('userName)', 'userName|)'));
		assert.equal(parseNextEdit('<none/>', t), undefined);
		assert.equal(parseNextEdit('<old>missing()</old><new>found()</new>', t), undefined);
		assert.equal(parseNextEdit('<old>console.log(userName);</old><new>console.log(userName);</new>', t), undefined);
		assert.equal(parseNextEdit('sure, here it is', t), undefined);
	});

	it('never undoes an edit the user just made', () => {
		const edited = file.replace('function greet(userName', 'function greet(name|');
		const t = target(edited, ['@@ line 1\n-function greet(userName: string) {\n+function greet(name: string) {']);
		assert.equal(parseNextEdit('<old>function greet(name: string) {</old><new>function greet(userName: string) {</new>', t), undefined);
		assert.ok(parseNextEdit('<old>\tconsole.log(userName);</old><new>\tconsole.log(name);</new>', t));
	});
});
