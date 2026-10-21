/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Embeddings through OpenAI-compatible `/embeddings` endpoints: OpenAI,
// Gemini, Mistral, Voyage, Ollama, LM Studio and others. Anthropic's API has
// none, so the index then ranks by words alone.

import { readError } from './anthropic';
import { ProviderError, type Endpoint } from './types';

export interface EmbeddingResult {
	vectors: number[][];
	tokens: number;
}

/** Model ids that are embedding models rather than chat models. */
export function isEmbeddingModel(model: string): boolean {
	return /embed|^(?:.*\/)?(?:bge|gte|e5|multilingual-e5|snowflake-arctic|jina-embeddings|voyage)|minilm|nomic/i.test(model);
}

/** The embedding model an endpoint offers, judged by its listed models and its host. */
export function defaultEmbeddingModel(endpoint: Endpoint, available: string[] = []): string | undefined {
	if (endpoint.provider !== 'openai') {
		return undefined;
	}
	const listed = [...endpoint.models, ...available].find(isEmbeddingModel);
	if (listed) {
		return listed;
	}
	let host = '';
	try {
		host = new URL(endpoint.baseUrl).hostname;
	} catch {
		return undefined;
	}
	switch (host) {
		case 'api.openai.com': return 'text-embedding-3-small';
		case 'generativelanguage.googleapis.com': return 'gemini-embedding-001';
		case 'api.mistral.ai': return 'codestral-embed';
		case 'api.voyageai.com': return 'voyage-code-3';
		default: return undefined;
	}
}

/** A smaller vector size for models that support one, to keep the index small. */
export function embeddingDimensions(model: string): number | undefined {
	return /text-embedding-3/.test(model) ? 512 : undefined;
}

/** Texts per request, and characters per text: embedding models take about 8000 tokens. */
export const MAX_EMBEDDING_CHARS = 8000;

export async function requestEmbeddings(endpoint: Endpoint, model: string, apiKey: string | undefined, texts: string[], signal: AbortSignal): Promise<EmbeddingResult> {
	const body: Record<string, unknown> = { model, input: texts.map(t => t.slice(0, MAX_EMBEDDING_CHARS) || ' ') };
	const dimensions = embeddingDimensions(model);
	if (dimensions) {
		body.dimensions = dimensions;
	}
	const headers: Record<string, string> = { 'content-type': 'application/json', ...endpoint.headers };
	if (apiKey) {
		headers.authorization = `Bearer ${apiKey}`;
	}
	let response: Response;
	try {
		response = await fetch(`${endpoint.baseUrl.replace(/\/+$/, '')}/embeddings`, { method: 'POST', headers, body: JSON.stringify(body), signal });
	} catch (err) {
		if (signal.aborted) {
			throw err;
		}
		throw new ProviderError(`Could not reach ${endpoint.baseUrl}: ${err.cause?.message ?? err.message}`, 0, true);
	}
	if (!response.ok) {
		throw await readError(response);
	}
	const json = await response.json() as { data?: { index?: number; embedding?: number[] }[]; usage?: { prompt_tokens?: number; total_tokens?: number } };
	if (!Array.isArray(json.data)) {
		throw new ProviderError(`${model} on ${endpoint.name} did not return embeddings.`);
	}
	const vectors: number[][] = new Array(texts.length).fill(undefined).map(() => []);
	json.data.forEach((item, i) => {
		const at = typeof item.index === 'number' ? item.index : i;
		if (Array.isArray(item.embedding) && at >= 0 && at < vectors.length) {
			vectors[at] = item.embedding;
		}
	});
	// Local servers often leave usage out; a rough count keeps the meter honest.
	const tokens = json.usage?.prompt_tokens ?? json.usage?.total_tokens ?? Math.ceil(texts.reduce((sum, t) => sum + Math.min(t.length, MAX_EMBEDDING_CHARS), 0) / 4);
	return { vectors, tokens };
}

/** Retries rate limits and server errors a few times, like chat requests. */
export async function requestEmbeddingsWithRetry(endpoint: Endpoint, model: string, apiKey: string | undefined, texts: string[], signal: AbortSignal, sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))): Promise<EmbeddingResult> {
	const delays = [1000, 4000, 10000];
	for (let attempt = 0; ; attempt++) {
		try {
			return await requestEmbeddings(endpoint, model, apiKey, texts, signal);
		} catch (err) {
			if (signal.aborted || !(err instanceof ProviderError) || !err.retryable || attempt >= delays.length) {
				throw err;
			}
			await sleep(delays[attempt]);
		}
	}
}
