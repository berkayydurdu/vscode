/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { listAnthropicModels, streamAnthropic } from './anthropic';
import { listOpenAIModels, streamOpenAI } from './openai';
import { ProviderError, type ChatRequest, type Endpoint, type ModelStream, type StreamEvent } from './types';

export interface ModelOptions {
	thinking: boolean;
	effort?: string;
	/** Waits before a retry; replaced in tests. */
	sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

const RETRY_DELAYS = [1000, 4000, 10000];

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(resolve, ms);
		signal.addEventListener('abort', () => {
			clearTimeout(timer);
			reject(signal.reason ?? new Error('Aborted'));
		}, { once: true });
	});
}

/**
 * Returns a function that streams responses from one model, retrying
 * rate limits and server errors as long as nothing has streamed yet.
 */
export function modelStream(endpoint: Endpoint, model: string, apiKey: string | undefined, options: ModelOptions): ModelStream {
	const sleep = options.sleep ?? defaultSleep;
	return async function* (request: ChatRequest, signal: AbortSignal): AsyncGenerator<StreamEvent> {
		const withEffort = { ...request, effort: request.effort ?? options.effort };
		for (let attempt = 0; ; attempt++) {
			let started = false;
			try {
				const stream = endpoint.provider === 'anthropic'
					? streamAnthropic(endpoint, model, apiKey, withEffort, { thinking: options.thinking }, signal)
					: streamOpenAI(endpoint, model, apiKey, withEffort, signal);
				for await (const event of stream) {
					started = true;
					yield event;
				}
				return;
			} catch (err) {
				if (signal.aborted || started || !(err instanceof ProviderError) || !err.retryable || attempt >= RETRY_DELAYS.length) {
					throw err;
				}
				await sleep(RETRY_DELAYS[attempt], signal);
			}
		}
	};
}

export function listModels(endpoint: Endpoint, apiKey: string | undefined, signal?: AbortSignal): Promise<string[]> {
	return endpoint.provider === 'anthropic' ? listAnthropicModels(endpoint, apiKey, signal) : listOpenAIModels(endpoint, apiKey, signal);
}

/** A best guess at the context window when the endpoint does not say. */
export function guessContextWindow(endpoint: Endpoint, model: string): number {
	if (endpoint.contextWindow) {
		return endpoint.contextWindow;
	}
	const id = model.toLowerCase();
	if (/claude-(opus|sonnet|fable|mythos)-(4-[6-9]|[5-9])|claude-haiku-[5-9]|gemini-(1\.5|2|3)/.test(id)) {
		return 1_000_000;
	}
	if (/claude/.test(id)) {
		return 200_000;
	}
	if (/gpt-5|gpt-4\.1/.test(id)) {
		return 400_000;
	}
	if (/gpt-4o|o\d|deepseek|qwen|llama-3\.[1-3]|mistral-large|codestral|grok/.test(id)) {
		return 128_000;
	}
	return endpoint.provider === 'anthropic' ? 200_000 : 32_000;
}

export interface Preset {
	id: string;
	label: string;
	provider: 'anthropic' | 'openai';
	baseUrl: string;
	models: string[];
	needsKey: boolean;
	keyUrl?: string;
}

/** Endpoints offered when adding one. Model lists are fetched live when possible. */
export const PRESETS: Preset[] = [
	{ id: 'anthropic', label: 'Anthropic (Claude)', provider: 'anthropic', baseUrl: 'https://api.anthropic.com', models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'], needsKey: true, keyUrl: 'https://console.anthropic.com/settings/keys' },
	{ id: 'openai', label: 'OpenAI', provider: 'openai', baseUrl: 'https://api.openai.com/v1', models: [], needsKey: true, keyUrl: 'https://platform.openai.com/api-keys' },
	{ id: 'openrouter', label: 'OpenRouter', provider: 'openai', baseUrl: 'https://openrouter.ai/api/v1', models: [], needsKey: true, keyUrl: 'https://openrouter.ai/keys' },
	{ id: 'gemini', label: 'Google Gemini', provider: 'openai', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', models: [], needsKey: true, keyUrl: 'https://aistudio.google.com/apikey' },
	{ id: 'deepseek', label: 'DeepSeek', provider: 'openai', baseUrl: 'https://api.deepseek.com/v1', models: ['deepseek-chat', 'deepseek-reasoner'], needsKey: true, keyUrl: 'https://platform.deepseek.com/api_keys' },
	{ id: 'mistral', label: 'Mistral', provider: 'openai', baseUrl: 'https://api.mistral.ai/v1', models: [], needsKey: true, keyUrl: 'https://console.mistral.ai/api-keys' },
	{ id: 'groq', label: 'Groq', provider: 'openai', baseUrl: 'https://api.groq.com/openai/v1', models: [], needsKey: true, keyUrl: 'https://console.groq.com/keys' },
	{ id: 'xai', label: 'xAI (Grok)', provider: 'openai', baseUrl: 'https://api.x.ai/v1', models: [], needsKey: true, keyUrl: 'https://console.x.ai' },
	{ id: 'ollama', label: 'Ollama (local)', provider: 'openai', baseUrl: 'http://localhost:11434/v1', models: [], needsKey: false },
	{ id: 'lmstudio', label: 'LM Studio (local)', provider: 'openai', baseUrl: 'http://localhost:1234/v1', models: [], needsKey: false },
	{ id: 'custom-openai', label: 'Other OpenAI-compatible endpoint', provider: 'openai', baseUrl: '', models: [], needsKey: false },
	{ id: 'custom-anthropic', label: 'Other Anthropic-compatible endpoint', provider: 'anthropic', baseUrl: '', models: [], needsKey: false },
];
