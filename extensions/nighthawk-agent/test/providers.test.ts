/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { anthropicBody, assembleAnthropicMessage, parseClaudeModel } from '../src/core/anthropic.ts';
import { toOpenAIMessages } from '../src/core/openai.ts';
import { modelStream } from '../src/core/providers.ts';
import { readSse } from '../src/core/sse.ts';
import type { Endpoint, Message, StreamEvent } from '../src/core/types.ts';

async function* chunks(...parts: string[]): AsyncGenerator<Uint8Array> {
	for (const part of parts) {
		yield new TextEncoder().encode(part);
	}
}

describe('readSse', () => {
	it('parses events split across chunks and line endings', async () => {
		const events = [];
		for await (const e of readSse(chunks('event: a\r', '\ndata: {"x"', ':1}\r\n\r\ndata: two\ndata: lines\n\n', 'data: last'))) {
			events.push(e);
		}
		assert.deepEqual(events, [
			{ event: 'a', data: '{"x":1}' },
			{ event: 'message', data: 'two\nlines' },
			{ event: 'message', data: 'last' },
		]);
	});
});

describe('anthropic', () => {
	const endpoint: Endpoint = { name: 'Anthropic', provider: 'anthropic', baseUrl: 'https://api.anthropic.com', models: [] };

	it('reads model versions', () => {
		assert.deepEqual(parseClaudeModel('claude-opus-4-8'), { family: 'opus', major: 4, minor: 8 });
		assert.deepEqual(parseClaudeModel('claude-sonnet-4-5-20250929'), { family: 'sonnet', major: 4, minor: 5 });
		assert.deepEqual(parseClaudeModel('claude-opus-5'), { family: 'opus', major: 5, minor: 0 });
		assert.equal(parseClaudeModel('claude-3-5-sonnet-20241022'), undefined);
	});

	it('asks for adaptive thinking, effort and fallbacks only where supported', () => {
		const request = { system: 'sys', messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hi' }] }], tools: [], effort: 'xhigh' };
		const opus = anthropicBody(endpoint, 'claude-opus-5-5', request, { thinking: true });
		assert.deepEqual(opus.body.thinking, { type: 'adaptive', display: 'summarized' });
		assert.deepEqual(opus.body.output_config, { effort: 'xhigh' });
		assert.equal(opus.body.fallbacks, 'default');
		assert.deepEqual(opus.betas, ['server-side-fallback-2026-07-01']);

		const old = anthropicBody(endpoint, 'claude-sonnet-4-6', request, { thinking: true });
		assert.deepEqual(old.body.thinking, { type: 'adaptive' });
		assert.deepEqual(old.body.output_config, { effort: 'high' });
		assert.equal(old.body.fallbacks, undefined);

		const haiku45 = anthropicBody(endpoint, 'claude-haiku-4-5', request, { thinking: true });
		assert.equal(haiku45.body.thinking, undefined);
		assert.equal(haiku45.body.output_config, undefined);

		const proxy = anthropicBody({ ...endpoint, baseUrl: 'https://proxy.example.com' }, 'claude-opus-5-5', { ...request, tools: [{ name: 't', description: 'd', inputSchema: {} }] }, { thinking: true });
		assert.equal(proxy.body.fallbacks, undefined);
		assert.equal((proxy.body.tools as Record<string, unknown>[])[0].eager_input_streaming, undefined);
	});

	it('sends tool results first, echoes thinking blocks and caches the last block', () => {
		const messages: Message[] = [
			{ role: 'user', content: [{ type: 'text', text: 'go' }] },
			{ role: 'assistant', content: [{ type: 'thinking', text: 'hm', raw: { type: 'thinking', thinking: 'hm', signature: 's' } }, { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'a' } }] },
			{ role: 'user', content: [{ type: 'text', text: 'also this' }, { type: 'tool_result', toolUseId: 't1', content: 'data' }] },
		];
		const { body } = anthropicBody(endpoint, 'claude-opus-5-5', { system: 's', messages, tools: [] }, { thinking: true });
		const sent = body.messages as { role: string; content: Record<string, unknown>[] }[];
		assert.deepEqual(sent[1].content[0], { type: 'thinking', thinking: 'hm', signature: 's' });
		assert.equal(sent[2].content[0].type, 'tool_result');
		assert.deepEqual(sent[2].content[1], { type: 'text', text: 'also this', cache_control: { type: 'ephemeral' } });
	});

	it('drops pre-fallback model-internal blocks when assembling', () => {
		const block = (type: string, extra: Record<string, unknown> = {}) => ({ type, text: '', thinking: '', signature: '', json: '', raw: { type, ...extra }, ...extra });
		const message = assembleAnthropicMessage([
			{ ...block('thinking'), thinking: 'a', signature: 'x' },
			{ ...block('text'), text: 'partial ' },
			{ ...block('tool_use', { id: 'old', name: 'Read' }), json: '{}' },
			block('fallback'),
			{ ...block('text'), text: 'rest' },
			{ ...block('tool_use', { id: 'new', name: 'Read' }), json: '{"file_path":"x"}' },
		]);
		assert.deepEqual(message.content, [
			{ type: 'text', text: 'partial ' },
			{ type: 'text', text: 'rest' },
			{ type: 'tool_use', id: 'new', name: 'Read', input: { file_path: 'x' } },
		]);
	});
});

describe('openai', () => {
	it('turns tool results into tool messages followed by user content', () => {
		const out = toOpenAIMessages('sys', [
			{ role: 'user', content: [{ type: 'text', text: 'go' }] },
			{ role: 'assistant', content: [{ type: 'thinking', text: 'secret' }, { type: 'text', text: 'ok' }, { type: 'tool_use', id: 'c1', name: 'Read', input: { a: 1 } }] },
			{ role: 'user', content: [{ type: 'tool_result', toolUseId: 'c1', content: 'oops', isError: true }, { type: 'text', text: 'next' }] },
		]);
		assert.deepEqual(out, [
			{ role: 'system', content: 'sys' },
			{ role: 'user', content: 'go' },
			{ role: 'assistant', content: 'ok', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'Read', arguments: '{"a":1}' } }] },
			{ role: 'tool', tool_call_id: 'c1', content: 'Error: oops' },
			{ role: 'user', content: 'next' },
		]);
	});
});

describe('modelStream over HTTP', () => {
	let server: Server;
	let base = '';
	let failures = 0;
	const seen: Record<string, unknown>[] = [];

	before(async () => {
		server = createServer((req, res) => {
			let body = '';
			req.on('data', d => body += d);
			req.on('end', () => {
				seen.push({ url: req.url, headers: req.headers, body: JSON.parse(body || '{}') });
				if (failures > 0) {
					failures--;
					res.writeHead(529, { 'content-type': 'application/json' });
					res.end(JSON.stringify({ error: { type: 'overloaded_error', message: 'Overloaded' } }));
					return;
				}
				res.writeHead(200, { 'content-type': 'text/event-stream' });
				if (req.url === '/v1/messages') {
					const send = (data: unknown) => res.write(`event: x\ndata: ${JSON.stringify(data)}\n\n`);
					send({ type: 'message_start', message: { usage: { input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 1 } } });
					send({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
					send({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Reading.' } });
					send({ type: 'content_block_stop', index: 0 });
					send({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tu1', name: 'Read', input: {} } });
					send({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"file_pa' } });
					send({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: 'th":"a.ts"}' } });
					send({ type: 'content_block_stop', index: 1 });
					send({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 20 } });
					send({ type: 'message_stop' });
				} else {
					const send = (data: unknown) => res.write(`data: ${JSON.stringify(data)}\n\n`);
					send({ choices: [{ delta: { reasoning_content: 'think' } }] });
					send({ choices: [{ delta: { content: 'Hi' } }] });
					send({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'Grep', arguments: '{"pat' } }] } }] });
					send({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'tern":"x"}' } }] } }] });
					send({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
					send({ choices: [], usage: { prompt_tokens: 50, completion_tokens: 5 } });
					res.write('data: [DONE]\n\n');
				}
				res.end();
			});
		});
		await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
		base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	});

	after(() => server.close());

	const collect = async (stream: AsyncIterable<StreamEvent>) => {
		const events: StreamEvent[] = [];
		for await (const e of stream) {
			events.push(e);
		}
		return events;
	};
	const request = { system: 's', messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hi' }] }], tools: [] };

	it('streams an Anthropic response with a tool call, retrying an overload', async () => {
		failures = 1;
		const stream = modelStream({ name: 'a', provider: 'anthropic', baseUrl: base, models: [] }, 'claude-opus-5-5', 'key', { thinking: true, sleep: async () => { } });
		const events = await collect(stream(request, new AbortController().signal));
		const done = events.at(-1);
		assert.equal(done?.type, 'done');
		if (done?.type === 'done') {
			assert.equal(done.stopReason, 'tool_use');
			assert.deepEqual(done.usage, { inputTokens: 100, outputTokens: 20, cacheReadTokens: 90, cacheWriteTokens: 0 });
			assert.deepEqual(done.message.content, [{ type: 'text', text: 'Reading.' }, { type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: 'a.ts' } }]);
		}
		assert.equal((seen.at(-1)!.headers as Record<string, string>)['x-api-key'], 'key');
	});

	it('streams an OpenAI-compatible response with reasoning and a tool call', async () => {
		const stream = modelStream({ name: 'o', provider: 'openai', baseUrl: `${base}/v1`, models: [] }, 'local-model', undefined, { thinking: true });
		const events = await collect(stream(request, new AbortController().signal));
		assert.deepEqual(events.filter(e => e.type === 'thinking' || e.type === 'text').map(e => (e as { text: string }).text), ['think', 'Hi']);
		const done = events.at(-1);
		assert.equal(done?.type, 'done');
		if (done?.type === 'done') {
			assert.equal(done.stopReason, 'tool_use');
			assert.deepEqual(done.message.content, [{ type: 'thinking', text: 'think' }, { type: 'text', text: 'Hi' }, { type: 'tool_use', id: 'c1', name: 'Grep', input: { pattern: 'x' } }]);
			assert.equal(done.usage.inputTokens, 50);
		}
		assert.equal(seen.at(-1)!.url, '/v1/chat/completions');
	});
});
