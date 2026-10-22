/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildSystemPrompt } from '../src/core/prompt.ts';

describe('system prompt', () => {
	const base = { roots: ['/w'], platform: 'linux', shell: 'bash', date: '2026-10-22', model: 'm', instructions: [], mode: 'plan' as const, isGitRepo: true };

	it('tells the Chat view it answers questions and cannot change files', () => {
		const chat = buildSystemPrompt({ ...base, chat: true });
		assert.match(chat, /^You are Nighthawk Chat/);
		assert.match(chat, /cannot edit files or run commands/);
		assert.doesNotMatch(chat, /# Permissions|PLAN MODE|shell for Bash/);
	});

	it('keeps the agent guidance and permission notes for the agent', () => {
		const agent = buildSystemPrompt(base);
		assert.match(agent, /^You are Nighthawk Agent/);
		assert.match(agent, /# Permissions\nPLAN MODE/);
	});
});
