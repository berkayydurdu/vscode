/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { budgetState, costOf, findPrice, formatCost, isLocalEndpoint, summarize, type UsageRecord } from '../src/core/usage.ts';

describe('usage prices', () => {
	it('finds list prices, local models and the user\'s own prices', () => {
		const anthropic = 'https://api.anthropic.com';
		const openrouter = 'https://openrouter.ai/api/v1';
		assert.deepEqual({
			opus: findPrice('claude-opus-5-5', anthropic)?.input,
			opus48: findPrice('claude-opus-4-8', anthropic)?.input,
			sonnet: findPrice('anthropic/claude-sonnet-4-6', openrouter)?.input,
			mini: findPrice('gpt-5-mini', 'https://api.openai.com/v1')?.input,
			ollama: findPrice('qwen2.5-coder:14b', 'http://localhost:11434/v1')?.input,
			unknown: findPrice('some-new-model', 'https://example.com/v1'),
			own: findPrice('my-co/fast', 'https://example.com/v1', { 'my-co/*': { input: 1, output: 4 } })?.output,
			ownBeatsList: findPrice('gpt-4o', 'https://api.openai.com/v1', { 'gpt-4o': { input: 9, output: 9 } })?.input,
		}, { opus: 4, opus48: 5, sonnet: 3, mini: 0.25, ollama: 0, unknown: undefined, own: 4, ownBeatsList: 9 });
		assert.deepEqual([isLocalEndpoint('http://127.0.0.1:1234/v1'), isLocalEndpoint('http://[::1]:8080'), isLocalEndpoint('https://api.openai.com')], [true, true, false]);
	});

	it('prices cache reads, writes and long prompts', () => {
		const price = findPrice('claude-sonnet-4-6', 'https://api.anthropic.com');
		// 100k input of which 80k cache reads and 10k cache writes, 2k output.
		const cost = costOf({ inputTokens: 100_000, outputTokens: 2_000, cacheReadTokens: 80_000, cacheWriteTokens: 10_000 }, price)!;
		assert.equal(cost.toFixed(4), (0.01 * 3 + 0.08 * 0.3 + 0.01 * 3.75 + 0.002 * 15).toFixed(4));
		const haiku = findPrice('claude-haiku-5-5', 'https://api.anthropic.com');
		assert.deepEqual([
			costOf({ inputTokens: 1_000_000, outputTokens: 0 }, haiku),
			costOf({ inputTokens: 50_000, outputTokens: 0 }, haiku),
			costOf({ inputTokens: 10, outputTokens: 10, cost: 0.5 }, undefined),
			costOf({ inputTokens: 10, outputTokens: 10 }, undefined),
		], [0.5, 0.005, 0.5, undefined]);
	});
});

describe('usage summary', () => {
	it('totals a month per day, model, conversation and feature', () => {
		const at = (day: number, hour = 12) => new Date(2026, 9, day, hour).getTime();
		const base = { endpoint: 'Anthropic', input: 1000, output: 100, cacheRead: 0, cacheWrite: 0 };
		const records: UsageRecord[] = [
			{ ...base, time: at(1), model: 'claude-opus-5-5', feature: 'agent', session: 's1', title: 'Fix login', cost: 0.5 },
			{ ...base, time: at(1, 13), model: 'claude-opus-5-5', feature: 'agent', session: 's1', title: 'Fix the login redirect', cost: 0.25 },
			{ ...base, time: at(3), model: 'gpt-5-mini', feature: 'commit', cost: 0.01 },
			{ ...base, time: at(3), model: 'mystery', feature: 'agent', session: 's2', title: 'Other' },
			{ ...base, time: new Date(2026, 8, 30).getTime(), model: 'claude-opus-5-5', feature: 'agent', cost: 9 },
		];
		const summary = summarize(records, '2026-10');
		assert.deepEqual({
			cost: summary.cost.toFixed(2),
			requests: summary.requests,
			unpriced: summary.unpriced,
			days: summary.days.slice(0, 4).map(d => d.toFixed(2)),
			length: summary.days.length,
			models: summary.byModel.map(g => [g.label, g.requests, g.cost.toFixed(2), g.unpriced]),
			chats: summary.byChat.map(g => [g.key, g.label, g.requests]),
			features: summary.byFeature.map(g => g.key),
		}, {
			cost: '0.76',
			requests: 4,
			unpriced: 1,
			days: ['0.75', '0.00', '0.01', '0.00'],
			length: 31,
			models: [['claude-opus-5-5', 2, '0.75', 0], ['gpt-5-mini', 1, '0.01', 0], ['mystery', 1, '0.00', 1]],
			chats: [['s1', 'Fix the login redirect', 2], ['s2', 'Other', 1]],
			features: ['agent', 'commit'],
		});
	});

	it('reports the budget state and formats amounts', () => {
		assert.deepEqual([budgetState(5, 0), budgetState(5, 20), budgetState(16, 20), budgetState(20, 20)], ['none', 'ok', 'near', 'over']);
		assert.deepEqual([formatCost(0), formatCost(0.004), formatCost(12.3)], ['$0.00', '<$0.01', '$12.30']);
	});
});
