/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, it } from 'node:test';
import { chatModels, githubWebUrl, initiator, pollDeviceToken, requestDeviceCode } from '../src/core/copilot.ts';
import { guessContextWindow, listModels, modelStream } from '../src/core/providers.ts';
import type { Endpoint, Message, StreamEvent } from '../src/core/types.ts';

interface Seen {
	method: string;
	path: string;
	headers: IncomingMessage['headers'];
	body: string;
}

describe('copilot', () => {
	let server: Server;
	let base = '';
	let seen: Seen[] = [];
	let tokenRequests = 0;
	let pollAnswers: Record<string, unknown>[] = [];
	let rejectChatOnce = false;

	before(async () => {
		server = createServer((req, res) => {
			let body = '';
			req.on('data', chunk => body += chunk);
			req.on('end', () => {
				const path = req.url ?? '';
				seen.push({ method: req.method ?? '', path, headers: req.headers, body });
				const json = (status: number, value: unknown) => {
					res.writeHead(status, { 'content-type': 'application/json' });
					res.end(JSON.stringify(value));
				};
				if (path === '/login/device/code') {
					json(200, { device_code: 'dev-1', user_code: 'ABCD-1234', verification_uri: 'https://github.com/login/device', interval: 5, expires_in: 900 });
				} else if (path === '/login/oauth/access_token') {
					json(200, pollAnswers.shift() ?? { error: 'expired_token' });
				} else if (path === '/copilot_internal/v2/token') {
					tokenRequests++;
					if (req.headers.authorization !== 'token gho_good') {
						json(401, { message: 'Bad credentials' });
						return;
					}
					json(200, { token: `cop-${tokenRequests}`, expires_at: Math.floor(Date.now() / 1000) + 1800, endpoints: { api: `${base}/copilot` } });
				} else if (path === '/copilot/models') {
					json(200, {
						data: [
							{ id: 'gpt-5', model_picker_enabled: true, capabilities: { type: 'chat' }, supported_endpoints: ['/chat/completions', '/responses'] },
							{ id: 'claude-sonnet-4.5', model_picker_enabled: true, capabilities: { type: 'chat' } },
							{ id: 'gpt-5-codex', model_picker_enabled: true, capabilities: { type: 'chat' }, supported_endpoints: ['/responses'] },
							{ id: 'text-embedding-3-small', model_picker_enabled: false, capabilities: { type: 'embeddings' } },
							{ id: 'gpt-4o-mini', model_picker_enabled: false, capabilities: { type: 'chat' } },
							{ id: 'o-locked', model_picker_enabled: true, capabilities: { type: 'chat' }, policy: { state: 'disabled' } },
						],
					});
				} else if (path === '/copilot/chat/completions') {
					if (rejectChatOnce) {
						rejectChatOnce = false;
						json(401, { error: { message: 'token expired' } });
						return;
					}
					res.writeHead(200, { 'content-type': 'text/event-stream' });
					// Copilot sends Claude's text and its tool call as two choices.
					res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'Reading it.' } }] })}\n\n`);
					res.write(`data: ${JSON.stringify({ choices: [{ index: 1, delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'Read', arguments: '{"file_path":"a.ts"}' } }] }, finish_reason: 'tool_calls' }] })}\n\n`);
					res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 5 } })}\n\n`);
					res.end('data: [DONE]\n\n');
				} else {
					json(404, { message: 'not found' });
				}
			});
		});
		await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
		base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	});

	after(() => server.close());

	beforeEach(() => {
		seen = [];
	});

	const endpoint = (): Endpoint => ({ name: 'GitHub Copilot', provider: 'copilot', baseUrl: base, models: ['gpt-5'] });

	it('finds the device flow host for a GitHub API URL', () => {
		assert.equal(githubWebUrl('https://api.github.com'), 'https://github.com');
		assert.equal(githubWebUrl('https://api.acme.ghe.com/'), 'https://acme.ghe.com');
		assert.equal(githubWebUrl('http://127.0.0.1:9000'), 'http://127.0.0.1:9000');
	});

	it('signs in with the device flow', async () => {
		const code = await requestDeviceCode(base);
		assert.deepEqual(code, { deviceCode: 'dev-1', userCode: 'ABCD-1234', verificationUri: 'https://github.com/login/device', interval: 5, expiresIn: 900 });
		assert.match(seen[0].body, /client_id=Iv1\.b507a08c87ecfe98/);

		pollAnswers = [{ error: 'authorization_pending' }, { error: 'slow_down', interval: 10 }, { access_token: 'gho_good' }];
		const waits: number[] = [];
		const token = await pollDeviceToken(base, code, undefined, async ms => { waits.push(ms); });
		assert.equal(token, 'gho_good');
		assert.deepEqual(waits, [5000, 5000, 10000]);
		assert.match(seen[1].body, /grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code/);
	});

	it('reports a cancelled sign-in', async () => {
		pollAnswers = [{ error: 'access_denied' }];
		await assert.rejects(pollDeviceToken(base, { deviceCode: 'd', userCode: 'u', verificationUri: 'v', interval: 1, expiresIn: 60 }, undefined, async () => { }), /cancelled/);
	});

	it('lists the chat models from the model picker', async () => {
		assert.deepEqual(await listModels(endpoint(), 'gho_good'), ['claude-sonnet-4.5', 'gpt-5']);
		const models = seen.find(s => s.path === '/copilot/models');
		assert.ok(models);
		assert.match(String(models.headers.authorization), /^Bearer cop-\d+$/);
		assert.equal(models.headers['copilot-integration-id'], 'vscode-chat');
	});

	it('keeps models without picker or endpoint details', () => {
		assert.deepEqual(chatModels([{ id: 'b' }, { id: 'a' }, { id: 'a' }, { id: 7 }]), ['a', 'b']);
	});

	it('explains an expired or missing sign-in', async () => {
		await assert.rejects(listModels(endpoint(), 'gho_bad'), /expired.*Sign In to GitHub Copilot/);
		await assert.rejects(listModels(endpoint(), undefined), /Sign in to GitHub Copilot first/);
	});

	it('streams chat with a cached Copilot token and merges choices', async () => {
		const before = tokenRequests;
		const messages: Message[] = [{ role: 'user', content: [{ type: 'text', text: 'read a.ts' }, { type: 'image', mediaType: 'image/png', data: 'AAAA' }] }];
		const stream = modelStream(endpoint(), 'claude-sonnet-4.5', 'gho_good', { thinking: false });
		const events: StreamEvent[] = [];
		for await (const event of stream({ system: 'sys', messages, tools: [] }, new AbortController().signal)) {
			events.push(event);
		}
		const done = events.at(-1);
		assert.equal(done?.type, 'done');
		if (done?.type === 'done') {
			assert.equal(done.stopReason, 'tool_use');
			assert.deepEqual(done.message.content, [
				{ type: 'text', text: 'Reading it.' },
				{ type: 'tool_use', id: 'call_1', name: 'Read', input: { file_path: 'a.ts' } },
			]);
			assert.equal(done.usage.inputTokens, 12);
		}
		assert.equal(tokenRequests, before, 'the token from listing models is reused');
		const chat = seen.find(s => s.path === '/copilot/chat/completions');
		assert.ok(chat);
		assert.equal(chat.headers['x-initiator'], 'user');
		assert.equal(chat.headers['copilot-vision-request'], 'true');
		assert.equal(JSON.parse(chat.body).model, 'claude-sonnet-4.5');
	});

	it('gets a new Copilot token once when the chat API rejects the old one', async () => {
		const before = tokenRequests;
		rejectChatOnce = true;
		const stream = modelStream(endpoint(), 'gpt-5', 'gho_good', { thinking: false });
		const events: StreamEvent[] = [];
		for await (const event of stream({ system: 'sys', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], tools: [] }, new AbortController().signal)) {
			events.push(event);
		}
		assert.equal(events.at(-1)?.type, 'done');
		assert.equal(tokenRequests, before + 1);
	});

	it('marks tool follow-ups as agent requests', () => {
		assert.equal(initiator([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]), 'user');
		assert.equal(initiator([{ role: 'user', content: [{ type: 'tool_result', toolUseId: 'x', content: 'ok' }] }]), 'agent');
		assert.equal(initiator([]), 'agent');
	});

	it('uses a conservative context window', () => {
		assert.equal(guessContextWindow(endpoint(), 'claude-sonnet-4.5'), 128_000);
	});
});
