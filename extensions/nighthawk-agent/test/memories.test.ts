/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { after, describe, it } from 'node:test';
import { cleanMemory, looksSecret, MAX_MEMORIES, MemoryFile, memoriesPrompt, parseMemories } from '../src/core/memories.ts';
import { buildSystemPrompt } from '../src/core/prompt.ts';
import { BUILTIN_TOOLS, SessionState, type MemoryChange, type ToolContext } from '../src/core/tools.ts';
import { NodeWorkspace } from '../src/core/workspace.ts';

const dir = mkdtempSync(path.join(tmpdir(), 'nh-memories-'));
after(() => rmSync(dir, { recursive: true, force: true }));

describe('memories', () => {
	it('saves, updates and forgets memories in a file', async () => {
		const file = new MemoryFile(path.join(dir, 'a', 'project.json'), 'project');
		const first = await file.add('Tests run with   npm run test:unit\n', 'Fix tests', 1);
		assert.equal(first.text, 'Tests run with npm run test:unit');
		assert.equal((await file.add('tests run with npm run test:unit', undefined, 2)).id, first.id);
		await file.add('The API client in src/gen is generated', undefined, 3);
		assert.equal((await file.update(first.id, 'Tests run with pnpm test', 4))?.text, 'Tests run with pnpm test');
		const again = new MemoryFile(file.file, 'project');
		assert.deepEqual((await again.list()).map(m => [m.text, m.updated, m.scope]), [['Tests run with pnpm test', 4, 'project'], ['The API client in src/gen is generated', 3, 'project']]);
		assert.equal(await again.remove(first.id), true);
		assert.equal(await again.remove('nope'), false);
		assert.equal(JSON.parse(readFileSync(file.file, 'utf8')).length, 1);
	});

	it('keeps the newest memories beyond the limit', async () => {
		const file = new MemoryFile(path.join(dir, 'many.json'), 'user');
		for (let i = 0; i < MAX_MEMORIES + 5; i++) {
			await file.add(`fact ${i}`);
		}
		const kept = await file.list();
		assert.equal(kept.length, MAX_MEMORIES);
		assert.equal(kept[0].text, 'fact 5');
	});

	it('reads only well-formed entries', () => {
		assert.deepEqual(parseMemories('[{"id":"a","text":"x","created":1},{"text":"no id"}]', 'user').map(m => m.id), ['a']);
		assert.deepEqual(parseMemories('{}', 'user'), []);
		assert.deepEqual(parseMemories('oops', 'user'), []);
	});

	it('spots secrets and cuts long facts', () => {
		assert.equal(looksSecret('The key is sk-ant-api03-abcdefghijklmnopqrstuv'), true);
		assert.equal(looksSecret('password: hunter2hunter2'), true);
		assert.equal(looksSecret('Keys live in the OS keychain'), false);
		assert.equal(cleanMemory('x'.repeat(600)).length, 500);
	});

	it('puts memories in the system prompt with their ids', () => {
		const prompt = memoriesPrompt([
			{ id: 'a1', text: 'Prefers pnpm', scope: 'user', created: 0, updated: 0 },
			{ id: 'b2', text: 'Build with make', scope: 'project', created: 0, updated: 0 },
		]);
		assert.match(prompt, /About the user \(all projects\):\n- \[a1\] Prefers pnpm/);
		assert.match(prompt, /About this project:\n- \[b2\] Build with make/);
		const base = { roots: ['/w'], platform: 'linux', shell: 'bash', date: '2026-10-21', model: 'm', instructions: [], mode: 'default' as const, isGitRepo: false };
		assert.match(buildSystemPrompt({ ...base, memories: [] }), /# Memories\n[\s\S]*\(none yet\)/);
		assert.doesNotMatch(buildSystemPrompt(base), /# Memories/);
	});

	it('runs the Memory tool through the host', async () => {
		const tool = BUILTIN_TOOLS.find(t => t.spec.name === 'Memory')!;
		const changes: MemoryChange[] = [];
		const ctx = {
			workspace: new NodeWorkspace([dir]),
			state: new SessionState(),
			signal: new AbortController().signal,
			memory: async (change: MemoryChange) => {
				changes.push(change);
				return 'ok';
			},
		} as unknown as ToolContext;
		await tool.run({ text: 'Prefers tabs', scope: 'user' }, ctx);
		await tool.run({ action: 'update', id: '[ab12]', text: 'Prefers spaces' }, ctx);
		await tool.run({ action: 'delete', id: 'ab12' }, ctx);
		assert.deepEqual(changes, [
			{ action: 'save', text: 'Prefers tabs', scope: 'user' },
			{ action: 'update', id: 'ab12', text: 'Prefers spaces' },
			{ action: 'delete', id: 'ab12' },
		]);
		await assert.rejects(tool.run({ text: 'token = abcdefghijkl' }, ctx), /secret/);
		await assert.rejects(tool.run({ text: 'x' }, { ...ctx, memory: undefined }), /turned off/);
	});
});
