/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ChatRequest } from './types';

/** Diffs larger than this are cut per file so one huge file cannot crowd out the rest. */
const MAX_DIFF_CHARS = 60_000;
const MAX_FILE_CHARS = 8_000;

/**
 * Shortens a unified diff to fit a prompt. Each file keeps its header and as
 * many hunk lines as its share allows; lock files and generated files keep
 * only their header.
 */
export function trimDiff(diff: string, maxChars = MAX_DIFF_CHARS): string {
	if (diff.length <= maxChars) {
		return diff;
	}
	const files = diff.split(/^(?=diff --git )/m).filter(Boolean);
	const share = Math.max(1_000, Math.min(MAX_FILE_CHARS, Math.floor(maxChars / Math.max(1, files.length))));
	const parts: string[] = [];
	let total = 0;
	for (const file of files) {
		const header = file.slice(0, file.search(/^@@/m) === -1 ? file.length : file.search(/^@@/m));
		const generated = /^diff --git a\/\S*(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|\.min\.js|\.map|\.snap)\b/m.test(file);
		let part = generated ? header + '(generated file changed, contents left out)\n' : file;
		if (part.length > share) {
			part = part.slice(0, share).replace(/\n[^\n]*$/, '\n') + '... (rest of this file\'s changes left out)\n';
		}
		if (total + part.length > maxChars) {
			parts.push(`... (${files.length - parts.length} more changed files left out)\n`);
			break;
		}
		parts.push(part);
		total += part.length;
	}
	return parts.join('');
}

/** Builds the request that writes a commit message for a diff, in the style of the repository's recent commits. */
export function commitMessageRequest(diff: string, recentSubjects: string[]): ChatRequest {
	const style = recentSubjects.length
		? `Recent commit subjects in this repository, to match their style (tense, prefixes such as "feat:" or ticket ids, capitalization):\n${recentSubjects.slice(0, 15).map(s => `- ${s}`).join('\n')}`
		: 'Use the imperative mood, for example "Add retry to the upload client".';
	return {
		system: [
			'You write git commit messages.',
			'Reply with the commit message only: no preamble, no code fences, no quotes.',
			'First line: a summary of at most 72 characters that says what changed and why it matters, not which files changed.',
			'If the change needs more explanation, add a blank line and a short body wrapped at 72 characters. Keep small changes to one line.',
			style,
		].join('\n'),
		messages: [{ role: 'user', content: [{ type: 'text', text: `Write the commit message for this diff:\n\n${trimDiff(diff)}` }] }],
		tools: [],
		maxTokens: 400,
	};
}

/** Removes what models tend to wrap a commit message in: code fences, quotes and a "Commit message:" label. */
export function cleanCommitMessage(text: string): string {
	let result = text.trim();
	const fenced = /^```[\w-]*\n(?<body>[\s\S]*?)\n```$/.exec(result);
	if (fenced?.groups) {
		result = fenced.groups.body.trim();
	}
	result = result.replace(/^(commit message|message)\s*:\s*/i, '');
	if (/^(["'`]).*\1$/s.test(result)) {
		result = result.slice(1, -1).trim();
	}
	return result;
}

/** The prompt that asks the agent to review a branch before it is pushed. */
export function branchReviewPrompt(base: string, branch: string | undefined): string {
	const range = `${base}...HEAD`;
	return [
		`Review the changes on ${branch ? `the branch \`${branch}\`` : 'this branch'} compared with \`${base}\`, as a careful senior reviewer would before it is pushed.`,
		'',
		`1. Run \`git log --oneline ${base}..HEAD\` and \`git diff --stat ${range}\` to see the scope, then read \`git diff ${range}\`. Include uncommitted changes from \`git status\` and \`git diff HEAD\` too.`,
		'2. Open the surrounding code where the diff alone is not enough to judge a change.',
		'3. Look for bugs, missed edge cases, security problems, broken error handling, missing tests for new behavior, and leftovers such as debug output or commented-out code.',
		'',
		'Do not edit any files. Report your findings grouped as **Must fix**, **Should fix** and **Nits**, each with the file and line and a one-line suggested fix. If the branch looks good, say so plainly.',
	].join('\n');
}
