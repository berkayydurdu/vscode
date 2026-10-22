/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// What model requests cost, and the monthly summary the usage page shows.
// No Node imports: the usage page bundles the types from this file.

import type { Usage } from './types';

/** US dollars per million tokens. */
export interface Price {
	input: number;
	output: number;
	/** Defaults to a tenth of `input`. */
	cacheRead?: number;
	/** Defaults to 1.25 times `input`. */
	cacheWrite?: number;
	/** A higher price for requests whose input is larger than `above` tokens. */
	longContext?: { above: number; input: number; output: number };
}

/**
 * List prices as of October 2026, matched against the model id (provider
 * prefixes such as `anthropic/` are fine). The first match wins, so more
 * specific patterns come first. Users can override any of them with
 * `nighthawk.ai.prices`.
 */
const LIST_PRICES: [RegExp, Price][] = [
	// Embedding models, used by the codebase index
	[/text-embedding-3-small/, { input: 0.02, output: 0 }],
	[/text-embedding-3-large/, { input: 0.13, output: 0 }],
	[/text-embedding-ada/, { input: 0.1, output: 0 }],
	[/gemini-embedding/, { input: 0.15, output: 0 }],
	[/codestral-embed/, { input: 0.15, output: 0 }],
	[/mistral-embed/, { input: 0.1, output: 0 }],
	[/voyage-code-3/, { input: 0.18, output: 0 }],
	// Anthropic
	[/claude-(fable|mythos)-5-1/, { input: 10, output: 50, cacheRead: 0.25 }],
	[/claude-(fable|mythos)/, { input: 10, output: 50 }],
	[/claude-opus-5-5/, { input: 4, output: 20, cacheRead: 0.2 }],
	[/claude-opus-(5|4-[5-9])/, { input: 5, output: 25 }],
	[/claude-(opus|3-opus)/, { input: 15, output: 75 }],
	[/claude-sonnet-5/, { input: 2, output: 10, cacheRead: 0.2 }],
	[/claude-(sonnet|3-[57]-sonnet)/, { input: 3, output: 15 }],
	[/claude-haiku-5-5/, { input: 0.1, output: 0.5, longContext: { above: 100_000, input: 0.5, output: 2.5 } }],
	[/claude-haiku-4/, { input: 1, output: 5 }],
	[/claude-(3-5-haiku|haiku-3-5)/, { input: 0.8, output: 4 }],
	[/claude-(3-haiku|haiku)/, { input: 0.25, output: 1.25 }],
	// OpenAI
	[/gpt-5[\w.-]*-nano/, { input: 0.05, output: 0.4, cacheRead: 0.005 }],
	[/gpt-5[\w.-]*-mini/, { input: 0.25, output: 2, cacheRead: 0.025 }],
	[/gpt-5/, { input: 1.25, output: 10, cacheRead: 0.125 }],
	[/gpt-4\.1-nano/, { input: 0.1, output: 0.4, cacheRead: 0.025 }],
	[/gpt-4\.1-mini/, { input: 0.4, output: 1.6, cacheRead: 0.1 }],
	[/gpt-4\.1/, { input: 2, output: 8, cacheRead: 0.5 }],
	[/gpt-4o-mini/, { input: 0.15, output: 0.6, cacheRead: 0.075 }],
	[/gpt-4o/, { input: 2.5, output: 10, cacheRead: 1.25 }],
	[/\bo4-mini/, { input: 1.1, output: 4.4, cacheRead: 0.275 }],
	[/\bo3-mini/, { input: 1.1, output: 4.4, cacheRead: 0.55 }],
	[/\bo3\b/, { input: 2, output: 8, cacheRead: 0.5 }],
	[/\bo1\b/, { input: 15, output: 60, cacheRead: 7.5 }],
	// Google
	[/gemini-[\d.]+-flash-lite/, { input: 0.1, output: 0.4, cacheRead: 0.025 }],
	[/gemini-2\.5-flash/, { input: 0.3, output: 2.5, cacheRead: 0.075 }],
	[/gemini-2\.0-flash/, { input: 0.1, output: 0.4, cacheRead: 0.025 }],
	[/gemini-2\.5-pro/, { input: 1.25, output: 10, cacheRead: 0.31, longContext: { above: 200_000, input: 2.5, output: 15 } }],
	// DeepSeek, Mistral, xAI
	[/deepseek-reasoner/, { input: 0.55, output: 2.19, cacheRead: 0.14 }],
	[/deepseek-chat/, { input: 0.27, output: 1.1, cacheRead: 0.07 }],
	[/codestral/, { input: 0.3, output: 0.9 }],
	[/mistral-large/, { input: 2, output: 6 }],
	[/mistral-medium/, { input: 0.4, output: 2 }],
	[/mistral-small/, { input: 0.1, output: 0.3 }],
	[/grok-code-fast/, { input: 0.2, output: 1.5, cacheRead: 0.02 }],
	[/grok-4/, { input: 3, output: 15, cacheRead: 0.75 }],
];

const FREE: Price = { input: 0, output: 0 };

/** True for models served from this computer, such as Ollama or LM Studio, which cost nothing. */
export function isLocalEndpoint(baseUrl: string): boolean {
	try {
		const host = new URL(baseUrl).hostname.replace(/^\[|\]$/g, '');
		return host === 'localhost' || host === '::1' || host === '0.0.0.0' || /^127\./.test(host) || host.endsWith('.localhost');
	} catch {
		return false;
	}
}

function globToRegExp(glob: string): RegExp {
	return new RegExp(`^${glob.split('*').map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'i');
}

/**
 * The price of a model: the user's own setting first (exact id or a `*`
 * pattern), then free for local servers, then the list price. Undefined
 * when the price is not known.
 */
export function findPrice(model: string, baseUrl: string, overrides: Record<string, Price> = {}): Price | undefined {
	const own = overrides[model] ?? Object.entries(overrides).find(([pattern]) => pattern.includes('*') && globToRegExp(pattern).test(model))?.[1];
	if (own && typeof own.input === 'number' && typeof own.output === 'number') {
		return own;
	}
	if (isLocalEndpoint(baseUrl)) {
		return FREE;
	}
	const id = model.toLowerCase();
	return LIST_PRICES.find(([pattern]) => pattern.test(id))?.[1];
}

/** The cost of one request in US dollars: what the provider reported, else from the price. */
export function costOf(usage: Usage, price: Price | undefined): number | undefined {
	if (typeof usage.cost === 'number') {
		return usage.cost;
	}
	if (!price) {
		return undefined;
	}
	const cacheRead = usage.cacheReadTokens ?? 0;
	const cacheWrite = usage.cacheWriteTokens ?? 0;
	const uncached = Math.max(0, usage.inputTokens - cacheRead - cacheWrite);
	const long = price.longContext && usage.inputTokens > price.longContext.above ? price.longContext : undefined;
	const input = long?.input ?? price.input;
	const output = long?.output ?? price.output;
	const scale = input / price.input || 1;
	return (uncached * input
		+ cacheRead * (price.cacheRead ?? price.input * 0.1) * scale
		+ cacheWrite * (price.cacheWrite ?? price.input * 1.25) * scale
		+ usage.outputTokens * output) / 1_000_000;
}

/** What a request was for, shown as "Used for" on the usage page. */
export type UsageFeature = 'agent' | 'chat' | 'commit' | 'terminal' | 'inline' | 'autocomplete' | 'nextEdit' | 'index' | 'prReview';

/** One model request, as stored in the monthly usage log. */
export interface UsageRecord {
	/** Milliseconds since the epoch. */
	time: number;
	endpoint: string;
	model: string;
	feature: UsageFeature;
	/** The agent conversation, when the request was part of one. */
	session?: string;
	title?: string;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	/** US dollars; absent when the model's price is not known. */
	cost?: number;
}

export interface UsageGroup {
	key: string;
	label: string;
	detail?: string;
	requests: number;
	input: number;
	output: number;
	cost: number;
	/** Requests whose cost is not known, so `cost` is too low. */
	unpriced: number;
	last: number;
}

export interface UsageSummary {
	/** "2026-10" */
	month: string;
	cost: number;
	requests: number;
	input: number;
	output: number;
	unpriced: number;
	/** Cost per day of the month; index 0 is the 1st. */
	days: number[];
	byModel: UsageGroup[];
	byChat: UsageGroup[];
	byFeature: UsageGroup[];
}

/** "2026-10" for a time in October 2026, in local time. */
export function monthKey(time: number): string {
	const date = new Date(time);
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

export function daysInMonth(month: string): number {
	const [year, index] = month.split('-').map(Number);
	return new Date(year, index, 0).getDate();
}

function group(groups: Map<string, UsageGroup>, key: string, label: string, record: UsageRecord, detail?: string): void {
	let entry = groups.get(key);
	if (!entry) {
		entry = { key, label, detail, requests: 0, input: 0, output: 0, cost: 0, unpriced: 0, last: 0 };
		groups.set(key, entry);
	}
	entry.requests++;
	entry.input += record.input;
	entry.output += record.output;
	entry.cost += record.cost ?? 0;
	entry.unpriced += record.cost === undefined ? 1 : 0;
	if (record.time >= entry.last) {
		entry.last = record.time;
		// A conversation's title can change as it goes; show the latest.
		entry.label = label;
	}
}

function sorted(groups: Map<string, UsageGroup>): UsageGroup[] {
	return [...groups.values()].sort((a, b) => b.cost - a.cost || b.input + b.output - (a.input + a.output));
}

/** Totals for one month, per day, per model, per conversation and per feature. */
export function summarize(records: readonly UsageRecord[], month: string): UsageSummary {
	const summary: UsageSummary = { month, cost: 0, requests: 0, input: 0, output: 0, unpriced: 0, days: new Array(daysInMonth(month)).fill(0), byModel: [], byChat: [], byFeature: [] };
	const models = new Map<string, UsageGroup>();
	const chats = new Map<string, UsageGroup>();
	const features = new Map<string, UsageGroup>();
	for (const record of records) {
		if (monthKey(record.time) !== month) {
			continue;
		}
		summary.requests++;
		summary.input += record.input;
		summary.output += record.output;
		summary.cost += record.cost ?? 0;
		summary.unpriced += record.cost === undefined ? 1 : 0;
		summary.days[new Date(record.time).getDate() - 1] += record.cost ?? 0;
		group(models, `${record.endpoint}\u0000${record.model}`, record.model, record, record.endpoint);
		if (record.session) {
			group(chats, record.session, record.title || 'Untitled', record);
		}
		group(features, record.feature, record.feature, record);
	}
	summary.byModel = sorted(models);
	summary.byChat = sorted(chats);
	summary.byFeature = sorted(features);
	return summary;
}

export type BudgetState = 'none' | 'ok' | 'near' | 'over';

/** Where spending stands against a monthly limit; "near" from 80%. */
export function budgetState(spent: number, limit: number): BudgetState {
	if (!(limit > 0)) {
		return 'none';
	}
	return spent >= limit ? 'over' : spent >= limit * 0.8 ? 'near' : 'ok';
}

/** "$0.42", "$12.30", or "<$0.01" for tiny non-zero amounts. */
export function formatCost(cost: number): string {
	if (cost > 0 && cost < 0.01) {
		return '<$0.01';
	}
	return `$${cost.toFixed(2)}`;
}

/** Messages from the extension to the usage page. */
export type UsageHostMessage =
	| { type: 'summary'; l10n?: Record<string, string>; summary: UsageSummary; months: string[]; limit: number; allowedOver: boolean; current: boolean; now: number };

/** Messages from the usage page to the extension. */
export type UsagePageMessage =
	| { type: 'ready' }
	| { type: 'month'; month: string }
	| { type: 'editLimit' }
	| { type: 'editPrice'; model: string }
	| { type: 'openChat'; id: string }
	| { type: 'settings' };
