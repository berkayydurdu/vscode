/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The Anthropic Messages API, called over HTTP so any Anthropic-compatible
// endpoint (a proxy, a gateway) works with the same code.

import { readSse } from './sse';
import { ProviderError, type ChatRequest, type Endpoint, type Message, type Part, type StopReason, type StreamEvent, type Usage } from './types';

export interface ClaudeModel {
	family: string;
	major: number;
	minor: number;
}

/** Reads the family and version from ids like `claude-opus-4-8` or `claude-sonnet-4-5-20250929`. */
export function parseClaudeModel(model: string): ClaudeModel | undefined {
	const match = /claude-(?<family>opus|sonnet|haiku|fable|mythos)-(?<major>\d)(?:-(?<minor>\d{1,2})(?=-|$))?/.exec(model);
	if (!match?.groups) {
		return undefined;
	}
	return { family: match.groups.family, major: Number(match.groups.major), minor: Number(match.groups.minor ?? 0) };
}

function atLeast(m: ClaudeModel, major: number, minor: number): boolean {
	return m.major > major || (m.major === major && m.minor >= minor);
}

export interface AnthropicOptions {
	/** Ask for adaptive thinking where the model supports it. */
	thinking: boolean;
}

function isFirstParty(endpoint: Endpoint): boolean {
	try {
		return new URL(endpoint.baseUrl).hostname === 'api.anthropic.com';
	} catch {
		return false;
	}
}

export function messagesUrl(baseUrl: string): string {
	const base = baseUrl.replace(/\/+$/, '');
	return /\/v1$/.test(base) ? `${base}/messages` : `${base}/v1/messages`;
}

export function anthropicHeaders(endpoint: Endpoint, apiKey: string | undefined): Record<string, string> {
	const headers: Record<string, string> = {
		'content-type': 'application/json',
		'anthropic-version': '2023-06-01',
		...endpoint.headers,
	};
	if (apiKey) {
		headers['x-api-key'] = apiKey;
	}
	return headers;
}

/** Builds the request body. Exported for tests. */
export function anthropicBody(endpoint: Endpoint, model: string, request: ChatRequest, options: AnthropicOptions): { body: Record<string, unknown>; betas: string[] } {
	const claude = parseClaudeModel(model);
	const firstParty = isFirstParty(endpoint);
	const betas: string[] = [];
	const body: Record<string, unknown> = {
		model,
		max_tokens: request.maxTokens ?? endpoint.maxOutputTokens ?? 32000,
		stream: true,
		system: [{ type: 'text', text: request.system, cache_control: { type: 'ephemeral' } }],
		messages: toAnthropicMessages(request.messages),
	};
	if (request.stop?.length) {
		body.stop_sequences = request.stop;
	}
	if (request.tools.length) {
		body.tools = request.tools.map(tool => ({
			name: tool.name,
			description: tool.description,
			input_schema: tool.inputSchema,
			// Streams large inputs (whole files) as they are written. Proxies may reject the field.
			...(firstParty ? { eager_input_streaming: true } : {}),
		}));
	}
	if (claude && atLeast(claude, 4, 6)) {
		if (options.thinking) {
			body.thinking = atLeast(claude, 4, 7) ? { type: 'adaptive', display: 'summarized' } : { type: 'adaptive' };
		}
		if (request.effort) {
			const effort = request.effort === 'xhigh' && !atLeast(claude, 4, 7) ? 'high' : request.effort;
			body.output_config = { effort };
		}
		const fallbackModels = ['opus-5-0', 'opus-5-5', 'fable-5-1', 'sonnet-5-5'];
		if (firstParty && fallbackModels.includes(`${claude.family}-${claude.major}-${claude.minor}`)) {
			// On a safety decline, the API retries on its recommended fallback model.
			body.fallbacks = 'default';
			betas.push('server-side-fallback-2026-07-01');
		}
	}
	return { body, betas };
}

function toAnthropicMessages(messages: Message[]): unknown[] {
	const out: { role: string; content: Record<string, unknown>[] }[] = [];
	for (const message of messages) {
		const blocks: Record<string, unknown>[] = [];
		if (message.role === 'user') {
			// Tool results must come first in a user turn.
			for (const part of message.content) {
				if (part.type === 'tool_result') {
					const content = part.images?.length
						? [{ type: 'text', text: part.content || '(no output)' }, ...part.images.map(image => ({ type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.data } }))]
						: part.content || '(no output)';
					blocks.push({ type: 'tool_result', tool_use_id: part.toolUseId, content, ...(part.isError ? { is_error: true } : {}) });
				}
			}
		}
		for (const part of message.content) {
			switch (part.type) {
				case 'text':
					if (part.text) {
						blocks.push({ type: 'text', text: part.text });
					}
					break;
				case 'image':
					blocks.push({ type: 'image', source: { type: 'base64', media_type: part.mediaType, data: part.data } });
					break;
				case 'thinking':
					if (message.role === 'assistant' && part.raw) {
						blocks.push(part.raw as Record<string, unknown>);
					}
					break;
				case 'tool_use':
					if (message.role === 'assistant') {
						blocks.push({ type: 'tool_use', id: part.id, name: part.name, input: part.input });
					}
					break;
				case 'opaque':
					if (part.provider === 'anthropic' && message.role === 'assistant') {
						blocks.push(part.raw as Record<string, unknown>);
					}
					break;
			}
		}
		if (blocks.length) {
			out.push({ role: message.role, content: blocks });
		}
	}
	// Cache everything up to the newest block.
	const last = out.at(-1);
	const target = last && [...last.content].reverse().find(b => b.type !== 'thinking' && b.type !== 'redacted_thinking');
	if (target) {
		const index = last.content.indexOf(target);
		last.content[index] = { ...target, cache_control: { type: 'ephemeral' } };
	}
	return out;
}

interface Block {
	type: string;
	text: string;
	thinking: string;
	signature: string;
	json: string;
	raw: Record<string, unknown>;
}

function mapStop(reason: string | undefined): StopReason {
	switch (reason) {
		case 'end_turn':
		case 'stop_sequence':
			return 'end_turn';
		case 'tool_use':
			return 'tool_use';
		case 'max_tokens':
		case 'model_context_window_exceeded':
			return 'max_tokens';
		case 'refusal':
			return 'refusal';
		default:
			return 'other';
	}
}

/** Turns the streamed blocks into a message we can send back later. */
export function assembleAnthropicMessage(blocks: Block[]): Message {
	// After a mid-output fallback, only text from before the switch is echoed back.
	const lastFallback = blocks.map(b => b.type).lastIndexOf('fallback');
	const content: Part[] = [];
	blocks.forEach((block, index) => {
		if (!block) {
			return;
		}
		const beforeFallback = index < lastFallback;
		switch (block.type) {
			case 'text':
				if (block.text) {
					content.push({ type: 'text', text: block.text });
				}
				break;
			case 'thinking':
				if (!beforeFallback) {
					content.push({ type: 'thinking', text: block.thinking, raw: { type: 'thinking', thinking: block.thinking, signature: block.signature } });
				}
				break;
			case 'redacted_thinking':
				if (!beforeFallback) {
					content.push({ type: 'thinking', text: '', raw: block.raw });
				}
				break;
			case 'tool_use': {
				if (beforeFallback) {
					break;
				}
				let input: Record<string, unknown>;
				try {
					const parsed = block.json ? JSON.parse(block.json) : (block.raw.input ?? {});
					input = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : { _invalidJson: block.json };
				} catch {
					input = { _invalidJson: block.json };
				}
				content.push({ type: 'tool_use', id: String(block.raw.id), name: String(block.raw.name), input });
				break;
			}
			case 'fallback':
				break;
			default:
				if (!beforeFallback) {
					content.push({ type: 'opaque', provider: 'anthropic', raw: block.raw });
				}
		}
	});
	return { role: 'assistant', content };
}

async function readError(response: Response): Promise<ProviderError> {
	const text = await response.text().catch(() => '');
	let message = text || response.statusText;
	try {
		const json = JSON.parse(text);
		message = json?.error?.message ?? json?.message ?? message;
	} catch {
		// Not JSON.
	}
	const retryable = response.status === 429 || response.status === 408 || response.status >= 500;
	return new ProviderError(`${response.status}: ${message}`, response.status, retryable);
}

export async function* streamAnthropic(endpoint: Endpoint, model: string, apiKey: string | undefined, request: ChatRequest, options: AnthropicOptions, signal: AbortSignal): AsyncGenerator<StreamEvent> {
	const { body, betas } = anthropicBody(endpoint, model, request, options);
	const headers = anthropicHeaders(endpoint, apiKey);
	if (betas.length) {
		headers['anthropic-beta'] = betas.join(',');
	}
	let response: Response;
	try {
		response = await fetch(messagesUrl(endpoint.baseUrl), { method: 'POST', headers, body: JSON.stringify(body), signal });
	} catch (err) {
		if (signal.aborted) {
			throw err;
		}
		throw new ProviderError(`Could not reach ${endpoint.baseUrl}: ${err.cause?.message ?? err.message}`, 0, true);
	}
	if (!response.ok || !response.body) {
		throw await readError(response);
	}
	const blocks: Block[] = [];
	const usage: Usage = { inputTokens: 0, outputTokens: 0 };
	let stopReason: string | undefined;
	let detail: string | undefined;
	for await (const event of readSse(response.body as unknown as AsyncIterable<Uint8Array>)) {
		if (!event.data || event.data === '[DONE]') {
			continue;
		}
		let data: Record<string, any>;
		try {
			data = JSON.parse(event.data);
		} catch {
			continue;
		}
		switch (data.type) {
			case 'message_start': {
				const u = data.message?.usage ?? {};
				usage.cacheReadTokens = u.cache_read_input_tokens ?? 0;
				usage.cacheWriteTokens = u.cache_creation_input_tokens ?? 0;
				usage.inputTokens = (u.input_tokens ?? 0) + usage.cacheReadTokens! + usage.cacheWriteTokens!;
				usage.outputTokens = u.output_tokens ?? 0;
				break;
			}
			case 'content_block_start': {
				const raw = data.content_block ?? {};
				blocks[data.index] = { type: raw.type, text: raw.text ?? '', thinking: raw.thinking ?? '', signature: raw.signature ?? '', json: '', raw };
				if (raw.type === 'tool_use') {
					yield { type: 'tool_start', id: raw.id, name: raw.name };
				} else if (raw.type === 'text' && raw.text) {
					yield { type: 'text', text: raw.text };
				}
				break;
			}
			case 'content_block_delta': {
				const block = blocks[data.index];
				const delta = data.delta ?? {};
				if (!block) {
					break;
				}
				if (delta.type === 'text_delta') {
					block.text += delta.text;
					yield { type: 'text', text: delta.text };
				} else if (delta.type === 'thinking_delta') {
					block.thinking += delta.thinking;
					yield { type: 'thinking', text: delta.thinking };
				} else if (delta.type === 'signature_delta') {
					block.signature += delta.signature;
				} else if (delta.type === 'input_json_delta') {
					block.json += delta.partial_json ?? '';
				}
				break;
			}
			case 'message_delta':
				stopReason = data.delta?.stop_reason ?? stopReason;
				if (data.delta?.stop_details?.explanation) {
					detail = data.delta.stop_details.explanation;
				}
				if (data.usage?.output_tokens !== undefined) {
					usage.outputTokens = data.usage.output_tokens;
				}
				break;
			case 'error': {
				const type = data.error?.type ?? '';
				throw new ProviderError(data.error?.message ?? 'The model stream failed.', 0, type === 'overloaded_error' || type === 'api_error');
			}
		}
	}
	yield { type: 'done', message: assembleAnthropicMessage(blocks), stopReason: mapStop(stopReason), usage, detail };
}

export async function listAnthropicModels(endpoint: Endpoint, apiKey: string | undefined, signal?: AbortSignal): Promise<string[]> {
	const url = messagesUrl(endpoint.baseUrl).replace(/\/messages$/, '/models?limit=100');
	const response = await fetch(url, { headers: anthropicHeaders(endpoint, apiKey), signal });
	if (!response.ok) {
		throw await readError(response);
	}
	const json = await response.json() as { data?: { id: string }[] };
	return (json.data ?? []).map(m => m.id);
}

export { readError };
