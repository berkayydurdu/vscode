/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CompletionCache, cleanCompletion, completionRequest, fitIndentation, isSensitiveFile, parseCompletion, replacesLineSuffix, shouldComplete, wantsMultiline, type CompletionTarget } from '../src/core/autocomplete.ts';
import { anthropicBody } from '../src/core/anthropic.ts';
import { openAIBody } from '../src/core/openai.ts';
import { textOf, type Endpoint } from '../src/core/types.ts';

function at(text: string, path = 'src/a.ts', languageId = 'typescript'): CompletionTarget {
	const cursor = text.indexOf('|');
	return { path, languageId, prefix: text.slice(0, cursor), suffix: text.slice(cursor + 1) };
}

describe('autocomplete', () => {
	it('suggests only where the rest of the line is empty or closing punctuation', () => {
		assert.equal(shouldComplete(at('const a = |')), true);
		assert.equal(shouldComplete(at('foo(|);\nbar();')), true);
		assert.equal(shouldComplete(at('foo(|a, b)')), false);
		assert.equal(shouldComplete(at('con|st a = 1;')), false);
	});

	it('suggests several lines on an empty line or after a block opener, else one line', () => {
		assert.equal(wantsMultiline(at('function a() {\n  |\n}')), true);
		assert.equal(wantsMultiline(at('function a() {|\n}')), true);
		assert.equal(wantsMultiline(at('items.map(x =>|')), true);
		assert.equal(wantsMultiline(at('def f(x):|', 'a.py', 'python')), true);
		assert.equal(wantsMultiline(at('const total = a +|')), false);
	});

	it('never sends files that usually hold secrets', () => {
		assert.equal(isSensitiveFile('/repo/.env'), true);
		assert.equal(isSensitiveFile('/repo/.env.local'), true);
		assert.equal(isSensitiveFile('C:\\repo\\certs\\server.KEY'), true);
		assert.equal(isSensitiveFile('/home/me/.npmrc'), true);
		assert.equal(isSensitiveFile('/repo/src/env.ts'), false);
		assert.equal(isSensitiveFile('/repo/keys.ts'), false);
	});

	it('sends the file with the cursor marked, trimmed around it', () => {
		const long = Array.from({ length: 2000 }, (_, i) => `line ${i}`).join('\n');
		const request = completionRequest(at(`${long}\nconst a = |;\n${long}`));
		const text = textOf(request.messages[0]);
		assert.match(text, /^File: src\/a\.ts \(typescript\)/);
		assert.match(text, /const a = <CURSOR>;/);
		assert.match(text, /\[earlier lines left out\]\nline \d+\n/);
		assert.match(text, /\[later lines left out\]/);
		assert.ok(text.length < 12_000);
		assert.equal(request.maxTokens, 80);
		assert.deepEqual(request.stop, ['</completion>']);
		assert.match(request.system, /only the current line/);
		assert.match(completionRequest(at('if (a) {\n|')).system, /current statement or block/);
	});

	it('passes stop text to models that take it', () => {
		const request = completionRequest(at('const a = |'));
		const openai: Endpoint = { name: 'o', provider: 'openai', baseUrl: 'http://localhost:1234/v1', models: [] };
		assert.deepEqual(openAIBody(openai, 'qwen2.5-coder', request).stop, ['</completion>']);
		assert.equal(openAIBody(openai, 'gpt-5-mini', request).stop, undefined);
		const anthropic: Endpoint = { name: 'a', provider: 'anthropic', baseUrl: 'https://api.anthropic.com', models: [] };
		assert.deepEqual(anthropicBody(anthropic, 'claude-haiku-5-5', request, { thinking: false }).body.stop_sequences, ['</completion>']);
	});

	it('reads the suggestion out of the reply', () => {
		assert.equal(parseCompletion('<completion>a + b;</completion>'), 'a + b;');
		assert.equal(parseCompletion('Sure:\n<completion>\n  return 1;\n'), '\n  return 1;\n');
		assert.equal(parseCompletion('```ts\nreturn x;\n```'), 'return x;');
		assert.equal(parseCompletion('a<CURSOR>b'), 'ab');
		assert.equal(parseCompletion('<completion></completion>'), '');
	});

	it('drops what repeats the line before the cursor', () => {
		assert.equal(cleanCompletion('return a + b;', at('  return |')), 'a + b;');
		assert.equal(cleanCompletion('  const total = a + b;', at('  const total = |')), 'a + b;');
		assert.equal(cleanCompletion('a + b;', at('  const total = |')), 'a + b;');
	});

	it('keeps single-line suggestions to one line', () => {
		assert.equal(cleanCompletion('a + b;\nconsole.log(total);', at('const total = |')), 'a + b;');
		assert.equal(cleanCompletion('\n  return 1;\n}\n\n', at('function a() {|')), '\n  return 1;\n}');
	});

	it('leaves out the closing punctuation and lines that follow the cursor already', () => {
		assert.equal(cleanCompletion('a, b);', at('foo(|);')), 'a, b');
		assert.equal(cleanCompletion('a, b)', at('foo(|)')), 'a, b');
		assert.equal(cleanCompletion('  return a + b;\n}', at('function add(a, b) {\n|\n}\n')), '  return a + b;');
		assert.equal(cleanCompletion('}', at('function add(a, b) {\n|\n}\n')), '');
		assert.equal(cleanCompletion('   ', at('const a = |')), '');
	});

	it('shows the rest of a suggestion while its start is typed', () => {
		const cache = new CompletionCache();
		cache.add('a.ts', at('const total = |;'), 'items.reduce(sum, 0)');
		assert.equal(cache.find('a.ts', at('const total = |;')), 'items.reduce(sum, 0)');
		assert.equal(cache.find('a.ts', at('const total = ite|;')), 'ms.reduce(sum, 0)');
		assert.equal(cache.find('a.ts', at('const total = itx|;')), undefined);
		assert.equal(cache.find('a.ts', at('const total = items.reduce(sum, 0)|;')), undefined);
		assert.equal(cache.find('b.ts', at('const total = |;')), undefined);
		assert.equal(cache.find('a.ts', at('let total = |;')), undefined);
		// Nothing to suggest is remembered too, so the same place is not asked again.
		cache.add('a.ts', at('x|'), '');
		assert.equal(cache.find('a.ts', at('x|')), '');
	});

	it('indents the way the file does, without repeating the indentation at the cursor', () => {
		const spaces = { insertSpaces: true, tabSize: 4 };
		assert.equal(fitIndentation('\tname: string;\n\tprice: number;', '    ', spaces), 'name: string;\n    price: number;');
		assert.equal(fitIndentation('\tif (n < 2) {\n\t\treturn n;\n\n\t}', '', spaces), '    if (n < 2) {\n        return n;\n\n    }');
		assert.equal(fitIndentation('        return n;', '    ', spaces), '    return n;');
		assert.equal(fitIndentation('    a;\n        b;', '\t', { insertSpaces: false, tabSize: 4 }), 'a;\n\t\tb;');
		assert.equal(fitIndentation(' + b;\n  c;', 'x = a', { insertSpaces: false, tabSize: 2 }), ' + b;\n\tc;');
		const target = { ...at('interface A {\n    |\n}'), indent: spaces };
		assert.equal(cleanCompletion('\tname: string;\n\tprice: number;\n}', target), 'name: string;\n    price: number;');
	});

	it('replaces the closing punctuation after the cursor when the suggestion writes it again', () => {
		assert.equal(replacesLineSuffix('`Total: ${total}`);', at('console.log(|)')), true);
		assert.equal(replacesLineSuffix(' {\n  return x;\n});', at('items.map(x =>|)')), true);
		assert.equal(replacesLineSuffix('a(b), c', at('foo(|)')), false);
		assert.equal(replacesLineSuffix('a, b', at('foo(|)')), false);
		assert.equal(replacesLineSuffix('a + b;', at('const x = |')), false);
	});
});
