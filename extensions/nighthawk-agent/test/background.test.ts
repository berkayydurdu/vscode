/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { backgroundPrompt, parseShortstat, taskSlug, taskTitle } from '../src/core/background.ts';

describe('background tasks', () => {
	it('names branches and titles from the task', () => {
		assert.deepEqual([
			taskSlug('Add tests for the upload client and fix what they find'),
			taskSlug('\u00dcbersetze die README ins Englische'),
			taskSlug('!!!'),
			taskTitle('  Fix the flaky test\nIt fails on CI about once a day'),
			taskTitle('x'.repeat(100)).length,
		], ['add-tests-for-the-upload-client-and-fix', 'ubersetze-die-readme-ins-englische', 'task', 'Fix the flaky test', 70]);
	});

	it('tells the agent where it works', () => {
		const prompt = backgroundPrompt({ prompt: 'Add a dark mode', worktree: '/w/app/add-a-dark-mode-1a2b3c', branch: 'nighthawk/add-a-dark-mode-1a2b3c', baseName: 'main' });
		assert.ok(prompt.startsWith('Add a dark mode\n'));
		assert.match(prompt, /worktree at `\/w\/app\/add-a-dark-mode-1a2b3c`, on the branch `nighthawk\/add-a-dark-mode-1a2b3c`, which starts from `main`/);
	});

	it('reads git diff --shortstat', () => {
		assert.deepEqual([
			parseShortstat(' 3 files changed, 10 insertions(+), 2 deletions(-)\n'),
			parseShortstat(' 1 file changed, 1 insertion(+)'),
			parseShortstat(''),
		], [{ files: 3, added: 10, removed: 2 }, { files: 1, added: 1, removed: 0 }, { files: 0, added: 0, removed: 0 }]);
	});
});
