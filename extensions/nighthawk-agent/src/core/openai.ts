/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// OpenAI-compatible chat completions: OpenAI, OpenRouter, Ollama, LM Studio,
// Groq, DeepSeek, Mistral, Gemini's compatibility endpoint, vLLM and others.

import { readError } from './anthropic';
import { readSse } from './sse';
import { ProviderError, type ChatRequest, type Endpoint, type Message, type Part, type StopReason, type StreamEvent, type Usage } from './types';

function url(baseUrl: string, path: string): string {
	return `${baseUrl.replace(/\/+$/, '')}${path}`;
}

function headers(endpoint: Endpoint, apiKey: string | undefined): Record<string, string> {
	const result: Record<string, string> = { 'content-type': 'application/json', ...endpoint.headers };
	if (apiKey) {
		result.authorization = `Bearer ${apiKey}`;
	}
	return result;
}

export function toOpenAIMessages(system: string, messages: Message[]): Record<string, unknown>[] {
	const out: Record<string, unknown>[] = [{ role: 'system', content: system }];
	for (const message of messages) {
		if (message.role === 'assistant') {
			const text = message.content.filter(p => p.type === 'text').map(p => (p as { text: string }).text).join('');
			const calls = message.content.filter((p): p is Extract<Part, { type: 'tool_use' }> => p.type === 'tool_use');
			if (!text && !calls.length) {
				continue;
			}
			const entry: Record<string, unknown> = { role: 'assistant', content: text || null };
			if (calls.length) {
				entry.tool_calls = calls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.input) } }));
			}
			out.push(entry);
			continue;
		}
		const pendingImages: { mediaType: string; data: string }[] = [];
		for (const part of message.content) {
			if (part.type === 'tool_result') {
				out.push({ role: 'tool', tool_call_id: part.toolUseId, content: (part.isError ? 'Error: ' : '') + (part.content || '(no output)') });
				pendingImages.push(...part.images ?? []);
			}
		}
		const userParts: Record<string, unknown>[] = [];
		for (const part of message.content) {
			if (part.type === 'text' && part.text) {
				userParts.push({ type: 'text', text: part.text });
			} else if (part.type === 'image') {
				pendingImages.push(part);
			}
		}
		// Tool messages cannot carry images, so they follow in a user message.
		for (const image of pendingImages) {
			userParts.push({ type: 'image_url', image_url: { url: `data:${image.mediaType};base64,${image.data}` } });
		}
		if (userParts.length) {
			const onlyText = userParts.every(p => p.type === 'text');
			out.push({ role: 'user', content: onlyText ? userParts.map(p => p.text).join('\n\n') : userParts });
		}
	}
	return out;
}

export function openAIBody(endpoint: Endpoint, model: string, request: ChatRequest): Record<string, unknown> {
	const body: Record<string, unknown> = {
		model,
		stream: true,
		stream_options: { include_usage: true },
		messages: toOpenAIMessages(request.system, request.messages),
	};
	if (request.tools.length) {
		body.tools = request.tools.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } }));
	}
	const maxTokens = request.maxTokens ?? endpoint.maxOutputTokens;
	if (maxTokens) {
		body.max_tokens = maxTokens;
	}
	const reasoning = /^(o\d|gpt-5)/.test(model.replace(/^.*\//, ''));
	if (request.effort && reasoning) {
		body.reasoning_effort = request.effort === 'xhigh' || request.effort === 'max' ? 'high' : request.effort;
	}
	if (request.stop?.length && !reasoning) {
		body.stop = request.stop;
	}
	return body;
}

export async function* streamOpenAI(endpoint: Endpoint, model: string, apiKey: string | undefined, request: ChatRequest, signal: AbortSignal): AsyncGenerator<StreamEvent> {
	let response: Response;
	try {
		response = await fetch(url(endpoint.baseUrl, '/chat/completions'), { method: 'POST', headers: headers(endpoint, apiKey), body: JSON.stringify(openAIBody(endpoint, model, request)), signal });
	} catch (err) {
		if (signal.aborted) {
			throw err;
		}
		throw new ProviderError(`Could not reach ${endpoint.baseUrl}: ${err.cause?.message ?? err.message}`, 0, true);
	}
	if (!response.ok || !response.body) {
		throw await readError(response);
	}
	let text = '';
	let reasoning = '';
	const calls: { id: string; name: string; args: string }[] = [];
	let finish: string | undefined;
	const usage: Usage = { inputTokens: 0, outputTokens: 0 };
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
		if (data.error) {
			throw new ProviderError(data.error.message ?? String(data.error), 0, false);
		}
		if (data.usage) {
			usage.inputTokens = data.usage.prompt_tokens ?? usage.inputTokens;
			usage.outputTokens = data.usage.completion_tokens ?? usage.outputTokens;
			usage.cacheReadTokens = data.usage.prompt_tokens_details?.cached_tokens;
			if (typeof data.usage.cost === 'number') {
				usage.cost = data.usage.cost;
			}
		}
		const choice = data.choices?.[0];
		if (!choice) {
			continue;
		}
		const delta = choice.delta ?? choice.message ?? {};
		const thought = delta.reasoning_content ?? delta.reasoning;
		if (typeof thought === 'string' && thought) {
			reasoning += thought;
			yield { type: 'thinking', text: thought };
		}
		if (typeof delta.content === 'string' && delta.content) {
			text += delta.content;
			yield { type: 'text', text: delta.content };
		}
		for (const call of delta.tool_calls ?? []) {
			const index = typeof call.index === 'number' ? call.index : calls.length;
			if (!calls[index]) {
				calls[index] = { id: call.id ?? `call_${index}_${Date.now()}`, name: '', args: '' };
			}
			const entry = calls[index];
			if (call.id) {
				entry.id = call.id;
			}
			if (call.function?.name) {
				const first = !entry.name;
				entry.name += call.function.name;
				if (first) {
					yield { type: 'tool_start', id: entry.id, name: entry.name };
				}
			}
			if (call.function?.arguments) {
				entry.args += typeof call.function.arguments === 'string' ? call.function.arguments : JSON.stringify(call.function.arguments);
			}
		}
		if (choice.finish_reason) {
			finish = choice.finish_reason;
		}
	}
	const content: Part[] = [];
	if (reasoning) {
		// Shown to the user; never sent back, as these APIs ask.
		content.push({ type: 'thinking', text: reasoning });
	}
	if (text) {
		content.push({ type: 'text', text });
	}
	for (const call of calls.filter(Boolean)) {
		let input: Record<string, unknown>;
		try {
			const parsed = call.args.trim() ? JSON.parse(call.args) : {};
			input = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : { _invalidJson: call.args };
		} catch {
			input = { _invalidJson: call.args };
		}
		content.push({ type: 'tool_use', id: call.id, name: call.name, input });
	}
	let stopReason: StopReason = 'end_turn';
	if (finish === 'length') {
		stopReason = 'max_tokens';
	} else if (calls.length) {
		stopReason = 'tool_use';
	} else if (finish === 'content_filter') {
		stopReason = 'refusal';
	}
	yield { type: 'done', message: { role: 'assistant', content }, stopReason, usage };
}

export async function listOpenAIModels(endpoint: Endpoint, apiKey: string | undefined, signal?: AbortSignal): Promise<string[]> {
	const response = await fetch(url(endpoint.baseUrl, '/models'), { headers: headers(endpoint, apiKey), signal });
	if (!response.ok) {
		throw await readError(response);
	}
	const json = await response.json() as { data?: { id: string }[]; models?: { name: string }[] };
	return (json.data ?? []).map(m => m.id).concat((json.models ?? []).map(m => m.name)).sort();
}
