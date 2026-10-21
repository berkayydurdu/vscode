/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { after, describe, it } from 'node:test';
import { checkCodeMap, codeMapMarkdown, type CodeMap } from '../src/core/codemap.ts';
import { BUILTIN_TOOLS, SessionState, type ToolContext } from '../src/core/tools.ts';
import { NodeWorkspace } from '../src/core/workspace.ts';

const dir = mkdtempSync(path.join(tmpdir(), 'nh-codemap-'));
after(() => rmSync(dir, { recursive: true, force: true }));
mkdirSync(path.join(dir, 'src'));
writeFileSync(path.join(dir, 'src', 'router.ts'), 'export function route() {\n\treturn login();\n}\n');
writeFileSync(path.join(dir, 'src', 'auth.ts'), 'export function login() {\n\treturn token();\n}\nfunction token() {}\n');

const input = {
	title: 'Sign-in flow',
	summary: 'The router calls login, which issues a token.',
	sections: [
		{ title: 'Entry', items: [{ id: 'route', file: './src/router.ts', line: 1, symbol: 'route', note: 'Handles the request.' }, { file: 'src/missing.ts', line: 1, note: 'x' }] },
		{ title: 'Auth', description: 'Checks the user.', items: [{ id: 'login', file: 'src/auth.ts', line: '1', endLine: 3, symbol: 'login', note: 'Signs in.' }, { id: 'login', file: 'src/auth.ts', line: 99, note: 'too far' }] },
		{ title: 'Empty', items: [] },
	],
	flow: [{ from: 'route', to: 'login', label: 'calls' }, { from: 'route', to: 'nowhere' }],
};

describe('code maps', () => {
	it('keeps the locations that exist and says which were left out', async () => {
		const { map, problems } = await checkCodeMap(input, 'How does sign-in work?', async file => file === 'src/router.ts' ? 4 : file === 'src/auth.ts' ? 5 : undefined);
		assert.deepEqual([map.sections.map(s => [s.title, s.items.map(i => [i.id, i.file, i.line, i.endLine])]), map.flow, problems], [
			[['Entry', [['route', 'src/router.ts', 1, undefined]]], ['Auth', [['login', 'src/auth.ts', 1, 3]]]],
			[{ from: 'route', to: 'login', label: 'calls' }],
			['src/missing.ts does not exist.', 'src/auth.ts:99 is past the end of the file (5 lines).', 'The arrow route -> nowhere names an unknown item id.'],
		]);
		assert.equal(codeMapMarkdown(map as CodeMap), [
			'# Sign-in flow', '', '> How does sign-in work?', '', 'The router calls login, which issues a token.', '',
			'## Entry', '', '- `route` (src/router.ts:1): Handles the request.', '',
			'## Auth', '', 'Checks the user.', '', '- `login` (src/auth.ts:1-3): Signs in.', '',
			'## Flow', '', '- route → login (calls)', '',
		].join('\n'));
	});

	it('shows the map through the CodeMap tool', async () => {
		const tool = BUILTIN_TOOLS.find(t => t.spec.name === 'CodeMap')!;
		const shown: CodeMap[] = [];
		const context: ToolContext = { workspace: new NodeWorkspace([dir]), state: new SessionState(), signal: new AbortController().signal, progress: () => undefined, showCodeMap: async map => { shown.push(map); } };
		const result = await tool.run(input, context);
		assert.deepEqual([shown.length, shown[0].sections.length, result.summary], [1, 2, '2 locations']);
		assert.match(result.content, /^The map is shown to the user: 2 locations in 2 sections\.\nLeft out: src\/missing\.ts does not exist\./);
		await assert.rejects(tool.run({ title: 'x', summary: 'y', sections: [{ title: 'a', items: [{ file: 'nope.ts', line: 1, note: 'n' }] }] }, context), /no valid locations/);
		await assert.rejects(tool.run(input, { ...context, showCodeMap: undefined }), /cannot be shown here/);
	});
});
