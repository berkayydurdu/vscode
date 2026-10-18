/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The agent loop: ask the model, run the tools it calls (asking the user
// where needed), send the results back, and repeat until it is done.

import type { Hooks } from './hooks';
import { ToolError, type Tool, type ToolContext, type ToolDisplay, type ToolResult } from './tools';
import { textOf, type Message, type ModelStream, type Part, type StopReason, type Usage } from './types';

export type AgentEvent =
	| { type: 'text'; text: string }
	| { type: 'thinking'; text: string }
	/** A model response ended; the next text starts a new block. */
	| { type: 'response_end' }
	| { type: 'tool_call'; id: string; name: string; title: string; input: Record<string, unknown> }
	| { type: 'tool_progress'; id: string; text: string }
	| { type: 'tool_result'; id: string; result: ToolResult; status: 'done' | 'error' | 'denied' }
	| { type: 'usage'; usage: Usage }
	| { type: 'compacted'; summary: string }
	| { type: 'notice'; level: 'info' | 'warning' | 'error'; text: string };

export type PermissionAnswer =
	| { allow: true }
	| { allow: false; reason: string; /** Stop the turn and wait for the user. */ stop?: boolean };

export interface AgentOptions {
	model: ModelStream;
	tools: Tool[];
	system: string;
	contextWindow: number;
	/** Compact the conversation when this share of the context window is used. Zero turns it off. */
	compactAt: number;
	maxSteps: number;
	/** Decides whether a call may run, asking the user if needed. */
	permission(tool: Tool, input: Record<string, unknown>, callId: string, preview: ToolDisplay | undefined): Promise<PermissionAnswer>;
	/** Everything tools need except the per-call bits. */
	context: Omit<ToolContext, 'signal' | 'progress'>;
	hooks?: Hooks;
	onEvent(event: AgentEvent): void;
	/** Messages the user sent while the agent was working. */
	takeQueued?(): string[];
}

export interface RunResult {
	stopReason: StopReason | 'aborted' | 'denied' | 'max_steps';
	text: string;
}

const COMPACT_PROMPT = [
	'Your context window is nearly full. Write a summary of the conversation so far that will replace it, so you can continue without losing anything important.',
	'Do not call any tools. Include:',
	'1. The user\'s requests and intent, in detail, quoting their exact words where it matters.',
	'2. Key technical context, decisions and conventions.',
	'3. Files read or changed, with what changed and why; include short code snippets that matter.',
	'4. Errors met and how they were fixed.',
	'5. What was being worked on right before this summary, and the next step if work is unfinished.',
].join('\n');

export class Agent {
	private lastUsage: Usage | undefined;
	private readonly options: AgentOptions;

	constructor(options: AgentOptions) {
		this.options = options;
	}

	get usage(): Usage | undefined {
		return this.lastUsage;
	}

	/** Runs until the model stops calling tools. `messages` is updated in place. */
	async run(messages: Message[], signal: AbortSignal): Promise<RunResult> {
		const { onEvent } = this.options;
		let steps = 0;
		let lastText = '';
		while (true) {
			if (signal.aborted) {
				return { stopReason: 'aborted', text: lastText };
			}
			if (this.needsCompaction()) {
				await this.compact(messages, signal);
			}
			const response = await this.callModel(messages, signal);
			if (response.message.content.length) {
				messages.push(response.message);
			}
			onEvent({ type: 'response_end' });
			lastText = textOf(response.message) || lastText;
			if (response.aborted) {
				return { stopReason: 'aborted', text: lastText };
			}
			if (response.stopReason === 'refusal') {
				onEvent({ type: 'notice', level: 'warning', text: response.detail ? `The model declined to continue: ${response.detail}` : 'The model declined to continue with this request.' });
				return { stopReason: 'refusal', text: lastText };
			}
			const calls = response.message.content.filter((p): p is Extract<Part, { type: 'tool_use' }> => p.type === 'tool_use');
			if (!calls.length) {
				if (response.stopReason === 'max_tokens') {
					onEvent({ type: 'notice', level: 'warning', text: 'The response hit the output token limit and was cut off.' });
				}
				const followUp = await this.afterStop(lastText, signal);
				if (followUp) {
					messages.push({ role: 'user', content: [{ type: 'text', text: followUp }] });
					continue;
				}
				return { stopReason: response.stopReason, text: lastText };
			}
			const { results, stop } = await this.runTools(calls, response.stopReason, signal);
			const queued = this.options.takeQueued?.() ?? [];
			messages.push({ role: 'user', content: [...results, ...queued.map(text => ({ type: 'text' as const, text }))] });
			if (signal.aborted) {
				return { stopReason: 'aborted', text: lastText };
			}
			if (stop) {
				return { stopReason: 'denied', text: lastText };
			}
			if (++steps >= this.options.maxSteps) {
				onEvent({ type: 'notice', level: 'warning', text: `Stopped after ${steps} steps. Send a message to let the agent continue.` });
				return { stopReason: 'max_steps', text: lastText };
			}
		}
	}

	/** After the model stops: a Stop hook may send it back to work, and so may queued messages. */
	private async afterStop(lastText: string, signal: AbortSignal): Promise<string | undefined> {
		const hooks = this.options.hooks;
		if (hooks?.has('Stop')) {
			const outcome = await hooks.run('Stop', { last_message: lastText }, undefined, signal);
			if (outcome.block) {
				return `A Stop hook says the work is not finished:\n${outcome.block}`;
			}
		}
		const queued = this.options.takeQueued?.() ?? [];
		return queued.length ? queued.join('\n\n') : undefined;
	}

	private needsCompaction(): boolean {
		const { compactAt, contextWindow } = this.options;
		if (!compactAt || !this.lastUsage) {
			return false;
		}
		return this.lastUsage.inputTokens + this.lastUsage.outputTokens > contextWindow * compactAt;
	}

	private async callModel(messages: Message[], signal: AbortSignal): Promise<{ message: Message; stopReason: StopReason; aborted?: boolean; detail?: string }> {
		const { model, tools, system, onEvent } = this.options;
		let text = '';
		try {
			for await (const event of model({ system, messages, tools: tools.map(t => t.spec) }, signal)) {
				if (event.type === 'text') {
					text += event.text;
					onEvent({ type: 'text', text: event.text });
				} else if (event.type === 'thinking') {
					onEvent({ type: 'thinking', text: event.text });
				} else if (event.type === 'done') {
					this.lastUsage = event.usage;
					onEvent({ type: 'usage', usage: event.usage });
					return { message: event.message, stopReason: event.stopReason, detail: event.detail };
				}
			}
		} catch (err) {
			if (signal.aborted) {
				// Keep what was said so far; drop any half-written tool calls.
				return { message: { role: 'assistant', content: text ? [{ type: 'text', text }] : [] }, stopReason: 'other', aborted: true };
			}
			throw err;
		}
		return { message: { role: 'assistant', content: text ? [{ type: 'text', text }] : [] }, stopReason: 'other' };
	}

	/** Replaces the conversation with a summary of it. */
	async compact(messages: Message[], signal: AbortSignal, instructions?: string): Promise<void> {
		const { model, tools, system, onEvent } = this.options;
		if (!messages.length) {
			return;
		}
		const prompt = instructions ? `${COMPACT_PROMPT}\n\nAlso: ${instructions}` : COMPACT_PROMPT;
		let summary = '';
		for await (const event of model({ system, messages: [...messages, { role: 'user', content: [{ type: 'text', text: prompt }] }], tools: tools.map(t => t.spec) }, signal)) {
			if (event.type === 'done') {
				summary = textOf(event.message);
			}
		}
		if (!summary.trim()) {
			throw new Error('The model returned an empty summary, so the conversation was not compacted.');
		}
		const unfinished = messages.at(-1)?.role === 'user';
		messages.splice(0, messages.length, {
			role: 'user',
			content: [{
				type: 'text',
				text: `This conversation continues an earlier one that was summarized to save context. The summary:\n\n${summary}${unfinished ? '\n\nContinue the work from where it stopped, without asking the user to repeat anything.' : ''}`,
			}],
		});
		this.lastUsage = undefined;
		onEvent({ type: 'compacted', summary });
	}

	private async runTools(calls: Extract<Part, { type: 'tool_use' }>[], stopReason: StopReason, signal: AbortSignal): Promise<{ results: Part[]; stop: boolean }> {
		const results = new Map<string, Part>();
		let stop = false;
		let batch: Promise<void>[] = [];
		const flush = async () => {
			await Promise.all(batch);
			batch = [];
		};
		for (const call of calls) {
			if (signal.aborted || stop) {
				const reason = signal.aborted ? 'The user interrupted before this ran.' : 'Skipped because the user declined an earlier call.';
				results.set(call.id, { type: 'tool_result', toolUseId: call.id, content: reason, isError: true });
				this.options.onEvent({ type: 'tool_result', id: call.id, result: { content: reason, isError: true }, status: 'denied' });
				continue;
			}
			const tool = this.options.tools.find(t => t.spec.name === call.name);
			const prepared = await this.prepare(call, tool, stopReason, signal);
			if (!prepared.run) {
				results.set(call.id, prepared.result);
				stop ||= prepared.stop;
				continue;
			}
			const job = this.execute(call, tool!, signal).then(result => {
				results.set(call.id, result);
			});
			if (tool!.parallel) {
				batch.push(job);
			} else {
				await flush();
				await job;
			}
		}
		await flush();
		return { results: calls.map(c => results.get(c.id)!), stop };
	}

	/** Checks a call and gets permission. Returns a result when it must not run. */
	private async prepare(call: Extract<Part, { type: 'tool_use' }>, tool: Tool | undefined, stopReason: StopReason, signal: AbortSignal): Promise<{ run: false; result: Part; stop: boolean } | { run: true }> {
		const { onEvent, hooks, context } = this.options;
		const fail = (content: string, status: 'error' | 'denied' = 'error', stop = false) => {
			onEvent({ type: 'tool_result', id: call.id, result: { content, isError: true }, status });
			return { run: false as const, result: { type: 'tool_result' as const, toolUseId: call.id, content, isError: true }, stop };
		};
		const title = (() => {
			try {
				return tool?.title(call.input, context.workspace) ?? call.name;
			} catch {
				return call.name;
			}
		})();
		onEvent({ type: 'tool_call', id: call.id, name: call.name, title, input: call.input });
		if (!tool) {
			return fail(`There is no tool named ${call.name}.`);
		}
		if (Object.hasOwn(call.input, '_invalidJson')) {
			return fail(stopReason === 'max_tokens'
				? 'Your response hit the output limit before this call was complete. Write the content in smaller pieces (for example, Write a short file, then Edit to add more).'
				: 'The tool input was not valid JSON. Try again.');
		}
		let hookAllowed = false;
		if (hooks?.has('PreToolUse')) {
			const outcome = await hooks.run('PreToolUse', { tool_name: call.name, tool_input: call.input }, call.name, signal);
			if (outcome.block) {
				return fail(`A PreToolUse hook blocked this call: ${outcome.block}`, 'denied');
			}
			hookAllowed = !!outcome.allow;
		}
		if (!hookAllowed) {
			let preview: ToolDisplay | undefined;
			try {
				preview = await tool.preview?.(call.input, { ...context, signal, callId: call.id, progress: () => { } });
			} catch (err) {
				// The call would fail anyway; report it without asking.
				return fail(err instanceof ToolError ? err.message : `${call.name} failed: ${err.message}`);
			}
			const answer = await this.options.permission(tool, call.input, call.id, preview);
			if (!answer.allow) {
				return fail(answer.reason, 'denied', !!answer.stop);
			}
		}
		return { run: true };
	}

	private async execute(call: Extract<Part, { type: 'tool_use' }>, tool: Tool, signal: AbortSignal): Promise<Part> {
		const { onEvent, hooks, context } = this.options;
		let result: ToolResult;
		try {
			result = await tool.run(call.input, { ...context, signal, callId: call.id, progress: text => onEvent({ type: 'tool_progress', id: call.id, text }) });
		} catch (err) {
			const message = signal.aborted ? 'The user interrupted this call.' : err instanceof ToolError ? err.message : `${call.name} failed: ${err?.message ?? err}`;
			result = { content: message, isError: true };
		}
		if (hooks?.has('PostToolUse') && !signal.aborted) {
			const outcome = await hooks.run('PostToolUse', { tool_name: call.name, tool_input: call.input, tool_response: { content: result.content, is_error: !!result.isError } }, call.name, signal);
			const note = outcome.block ?? outcome.context;
			if (note) {
				result = { ...result, content: `${result.content}\n\n<post-tool-hook>${note}</post-tool-hook>` };
			}
		}
		onEvent({ type: 'tool_result', id: call.id, result, status: result.isError ? 'error' : 'done' });
		return { type: 'tool_result', toolUseId: call.id, content: result.content, isError: result.isError, images: result.images };
	}
}
