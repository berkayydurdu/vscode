/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { branchReviewPrompt, cleanCommitMessage, commitMessageRequest, trimDiff } from '../src/core/commit.ts';

function fileDiff(name: string, lines: number): string {
	return `diff --git a/${name} b/${name}\n--- a/${name}\n+++ b/${name}\n@@ -1,1 +1,${lines} @@\n${Array.from({ length: lines }, (_, i) => `+line ${i}`).join('\n')}\n`;
}

describe('commit messages', () => {
	it('strips fences, labels and quotes', () => {
		assert.deepEqual(
			['```\nAdd retry\n\nBody\n```', 'Commit message: Fix crash', '"Update docs"', 'Plain one'].map(cleanCommitMessage),
			['Add retry\n\nBody', 'Fix crash', 'Update docs', 'Plain one'],
		);
	});

	it('keeps small diffs and shortens large ones per file', () => {
		const small = fileDiff('a.ts', 3);
		assert.equal(trimDiff(small), small);
		const big = fileDiff('package-lock.json', 2000) + fileDiff('src/app.ts', 2000);
		const trimmed = trimDiff(big, 6000);
		assert.ok(trimmed.length < 7000);
		assert.match(trimmed, /generated file changed/);
		assert.match(trimmed, /diff --git a\/src\/app\.ts/);
	});

	it('asks for the repository style', () => {
		const request = commitMessageRequest(fileDiff('a.ts', 2), ['feat: add login']);
		assert.match(request.system, /feat: add login/);
		assert.equal(request.tools.length, 0);
	});

	it('reviews the branch against its base without edits', () => {
		const prompt = branchReviewPrompt('origin/main', 'feature/x');
		assert.match(prompt, /git diff origin\/main\.\.\.HEAD/);
		assert.match(prompt, /Do not edit any files/);
	});
});
