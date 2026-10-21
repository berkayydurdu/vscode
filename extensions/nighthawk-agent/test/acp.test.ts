/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { after, describe, it } from 'node:test';
import { AcpClient, AcpError, AGENT_PRESETS, contentText, externalAgents, JsonRpcPeer, pickOption, type AcpHost, type AcpUpdate } from '../src/core/acp.ts';

const dir = mkdtempSync(path.join(tmpdir(), 'nh-acp-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const fake = { name: 'Fake', command: process.execPath, args: [path.join(import.meta.dirname, 'fixtures', 'fakeAcpAgent.mjs')] };

function host(files: Map<string, string>, answer = 'yes'): AcpHost & { updates: AcpUpdate[]; asked: number; terminal: string } {
	const result = {
		updates: [] as AcpUpdate[],
		asked: 0,
		terminal: '',
		onUpdate: (update: AcpUpdate) => result.updates.push(update),
		requestPermission: async () => {
			result.asked++;
			return answer;
		},
		readTextFile: async (file: string) => files.get(file) ?? '',
		writeTextFile: async (file: string, content: string) => {
			files.set(file, content);
		},
		onTerminalOutput: (_id: string, text: string) => {
			result.terminal += text;
		},
	};
	return result;
}

describe('agent client protocol', () => {
	it('runs a turn: reads, asks, writes, runs a terminal and replies', async () => {
		const files = new Map([['/w/a.txt', 'say hello\n']]);
		const h = host(files);
		const client = new AcpClient(fake, h);
		try {
			const init = await client.start(dir);
			assert.equal(init.protocolVersion, 1);
			const session = await client.newSession(dir);
			assert.equal(session.modes?.currentModeId, 'default');
			const stop = await client.prompt([{ type: 'text', text: 'please edit /w/a.txt' }], new AbortController().signal);
			assert.equal(stop, 'end_turn');
			assert.equal(files.get('/w/a.txt'), 'say hello from the fake agent\n');
			assert.equal(h.asked, 1);
			assert.match(h.terminal, /checked: ok/);
			const reply = h.updates.filter(u => u.sessionUpdate === 'agent_message_chunk').map(u => contentText((u as { content: { type: 'text'; text: string } }).content)).join('');
			assert.match(reply, /Done: I changed \/w\/a\.txt and the check printed "checked: ok"/);
			assert.ok(h.updates.some(u => u.sessionUpdate === 'tool_call' && (u as { kind?: string }).kind === 'edit'));
		} finally {
			client.dispose();
		}
	});

	it('leaves the file alone when the user says no, and switches modes', async () => {
		const files = new Map([['/w/a.txt', 'hello']]);
		const h = host(files, 'no');
		const client = new AcpClient(fake, h);
		try {
			await client.start(dir);
			await client.newSession(dir);
			await client.prompt([{ type: 'text', text: 'edit /w/a.txt' }], new AbortController().signal);
			assert.equal(files.get('/w/a.txt'), 'hello');
			await client.setMode('bypassPermissions');
			assert.equal(client.session?.modes?.currentModeId, 'bypassPermissions');
			await client.prompt([{ type: 'text', text: 'edit /w/a.txt' }], new AbortController().signal);
			assert.equal(files.get('/w/a.txt'), 'hello from the fake agent');
			assert.equal(h.asked, 1);
		} finally {
			client.dispose();
		}
	});

	it('reports a sign-in the agent needs, and signs in', async () => {
		const client = new AcpClient({ ...fake, env: { FAKE_ACP_AUTH: '1' } }, host(new Map()));
		try {
			const init = await client.start(dir);
			const error = await client.newSession(dir).then(() => undefined, (err: unknown) => err);
			assert.ok(error instanceof AcpError && error.authRequired);
			await client.authenticate(init.authMethods![0].id);
			assert.equal((await client.newSession(dir)).sessionId, 'fake-session-1');
		} finally {
			client.dispose();
		}
	});

	it('says why an agent cannot start', async () => {
		const client = new AcpClient({ name: 'Missing', command: path.join(dir, 'no-such-agent') }, host(new Map()));
		await assert.rejects(client.start(dir), /Missing (could not start|stopped)/);
		client.dispose();
	});

	it('speaks JSON-RPC over lines, in pieces too', async () => {
		const sent: string[] = [];
		const peer = new JsonRpcPeer(line => sent.push(line));
		peer.on('echo', async params => params);
		const answer = peer.request<number>('add', [1, 2]);
		peer.receive('{"jsonrpc":"2.0","id":1,');
		peer.receive('"result":3}\n{"jsonrpc":"2.0","id":7,"method":"echo","params":{"a":1}}\n');
		assert.equal(await answer, 3);
		await new Promise(resolve => setImmediate(resolve));
		assert.deepEqual(JSON.parse(sent[1]), { jsonrpc: '2.0', id: 7, result: { a: 1 } });
		peer.receive('{"jsonrpc":"2.0","id":8,"method":"nope"}\n');
		assert.equal(JSON.parse(sent[2]).error.code, -32601);
		const failing = peer.request('x', {});
		peer.close(new Error('gone'));
		await assert.rejects(failing, /gone/);
	});

	it('lists configured agents before the presets they do not replace', () => {
		const agents = externalAgents([{ name: 'Claude Code', command: 'claude-agent-acp' }, { name: 'Mine', command: 'my-agent', args: ['--acp'] }, { name: '', command: 'x' }]);
		assert.deepEqual(agents.map(a => a.name), ['Claude Code', 'Mine', 'Gemini CLI', 'Codex']);
		assert.equal(agents[0].command, 'claude-agent-acp');
		assert.equal(externalAgents(undefined).length, AGENT_PRESETS.length);
	});

	it('picks permission options by kind', () => {
		const options = [{ optionId: 'a', name: 'A', kind: 'allow_always' as const }, { optionId: 'r', name: 'R', kind: 'reject_once' as const }];
		assert.equal(pickOption(options, 'allow_once', 'allow_always')?.optionId, 'a');
		assert.equal(pickOption(options, 'reject_always'), undefined);
	});
});
