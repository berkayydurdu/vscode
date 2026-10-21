/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Shared types for the agent core. Files in src/core must not import 'vscode'
// so they can be tested with plain Node.

export type ProviderKind = 'anthropic' | 'openai';

/** A model endpoint the user configured under `nighthawk.ai.endpoints`. */
export interface Endpoint {
	name: string;
	provider: ProviderKind;
	baseUrl: string;
	models: string[];
	/** Tokens the model can read; used for the context meter and auto-compaction. */
	contextWindow?: number;
	maxOutputTokens?: number;
	headers?: Record<string, string>;
}

/** A conversation part, independent of the provider's wire format. */
export type Part =
	| { type: 'text'; text: string }
	| { type: 'image'; mediaType: string; data: string }
	/** `raw` is the provider's own block, echoed back unchanged on later requests. */
	| { type: 'thinking'; text: string; raw?: unknown }
	| { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
	| { type: 'tool_result'; toolUseId: string; content: string; isError?: boolean; images?: { mediaType: string; data: string }[] }
	/** A provider block the harness does not understand but must send back as is. */
	| { type: 'opaque'; provider: ProviderKind; raw: unknown };

export interface Message {
	role: 'user' | 'assistant';
	content: Part[];
}

export interface ToolSpec {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
}

export interface Usage {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens?: number;
	cacheWriteTokens?: number;
	/** US dollars, when the provider reports what the request cost (OpenRouter does). */
	cost?: number;
}

export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal' | 'other';

export interface ChatRequest {
	system: string;
	messages: Message[];
	tools: ToolSpec[];
	maxTokens?: number;
	/** Reasoning effort for models that support it. */
	effort?: string;
}

export type StreamEvent =
	| { type: 'text'; text: string }
	| { type: 'thinking'; text: string }
	| { type: 'tool_start'; id: string; name: string }
	| { type: 'done'; message: Message; stopReason: StopReason; usage: Usage; detail?: string };

/** Streams one model response. */
export type ModelStream = (request: ChatRequest, signal: AbortSignal) => AsyncIterable<StreamEvent>;

export class ProviderError extends Error {
	readonly status: number;
	readonly retryable: boolean;

	constructor(message: string, status = 0, retryable = false) {
		super(message);
		this.status = status;
		this.retryable = retryable;
	}
}

export function textOf(message: Message): string {
	return message.content.filter(p => p.type === 'text').map(p => (p as { text: string }).text).join('');
}
