/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { commentBody, diffFiles, GitHub, githubRepo, newFindings, parseReview, placeFindings, postReview, REVIEW_MARKER, reviewBody, reviewPullRequest, type Finding } from '../src/core/prReview.ts';
import type { ChatRequest, StreamEvent } from '../src/core/types.ts';

const diff = [
	'diff --git a/src/api.ts b/src/api.ts',
	'index 1..2 100644',
	'--- a/src/api.ts',
	'+++ b/src/api.ts',
	'@@ -1,3 +1,4 @@',
	' export function load(id) {',
	'-  return fetch(id);',
	'+  const url = `/api/${id}`;',
	'+  return fetch(url).then(r => r.json());',
	' }',
	'diff --git a/old.txt b/old.txt',
	'deleted file mode 100644',
	'--- a/old.txt',
	'+++ /dev/null',
	'@@ -1 +0,0 @@',
	'-bye',
	'',
].join('\n');

const finding = (path: string, line: number, extra: Partial<Finding> = {}): Finding => ({ path, line, severity: 'medium', title: 'Unchecked response', body: 'r.json() throws on errors.', ...extra });

describe('pull request review', () => {
	it('reads GitHub remotes', () => {
		assert.deepStrictEqual([
			'https://github.com/berkayydurdu/vscode.git',
			'git@github.com:owner/my.repo.git',
			'ssh://git@github.com/owner/name',
			'https://token@github.com/owner/name/',
			'https://gitlab.com/owner/name.git',
		].map(githubRepo), ['berkayydurdu/vscode', 'owner/my.repo', 'owner/name', 'owner/name', undefined]);
	});

	it('finds the lines a comment can go on', () => {
		assert.deepStrictEqual(diffFiles(diff).map(f => ({ ...f, lines: [...f.lines] })), [
			{ path: 'src/api.ts', deleted: false, lines: [1, 2, 3, 4] },
			{ path: 'old.txt', deleted: true, lines: [] },
		]);
	});

	it('reads the model\'s findings and places them on lines GitHub accepts', () => {
		const review = parseReview('Here you go:\n```json\n{"summary": "Loads JSON.", "findings": [' + [
			'{"path": "b/src/api.ts", "line": 3, "severity": "high", "title": "Unchecked response", "body": "x", "suggestion": "  return fetch(url).then(check);\\n"}',
			'{"path": "src/api.ts", "line": 6, "severity": "loud", "title": "Near the hunk", "suggestion": "x"}',
			'{"path": "README.md", "line": 1, "title": "Not in the diff"}',
			'{"path": "src/api.ts", "line": "nope", "title": "Broken"}',
		].join(',') + ']}\n```');
		const placed = placeFindings(review.findings, diffFiles(diff));
		assert.deepStrictEqual([review.summary, placed.inline.map(f => [f.path, f.line, f.severity, f.suggestion]), placed.general.map(f => f.title)], [
			'Loads JSON.',
			[['src/api.ts', 3, 'high', '  return fetch(url).then(check);'], ['src/api.ts', 4, 'medium', undefined]],
			['Not in the diff'],
		]);
		assert.throws(() => parseReview('I could not review this.'));
	});

	it('writes comments and the review body, and skips findings posted before', () => {
		const inline = finding('src/api.ts', 3, { suggestion: '  return x;' });
		const general = finding('README.md', 1, { severity: 'low', title: 'Docs', body: '' });
		assert.equal(commentBody(inline), `**Medium: Unchecked response**\n\nr.json() throws on errors.\n\n\`\`\`suggestion\n  return x;\n\`\`\`\n\n${REVIEW_MARKER}`);
		assert.equal(reviewBody('Loads JSON.', [inline], [general]), `### Nighthawk review\n\nLoads JSON.\n\nFound 2 issues (1 medium, 1 low).\n\n- **Low: Docs** (\`README.md:1\`)\n\n${REVIEW_MARKER}`);
		assert.deepStrictEqual(newFindings([inline, finding('src/api.ts', 9, { title: 'Other' }), finding('src/other.ts', 3)], [
			{ path: 'src/api.ts', body: `**High: Unchecked  response!**\n\n${REVIEW_MARKER}` },
			{ path: 'src/api.ts', body: '**Medium: Other**\n\nA person wrote this.' },
		]).map(f => `${f.path}:${f.title}`), ['src/api.ts:Other', 'src/other.ts:Unchecked response']);
	});

	it('reviews a pull request through the GitHub API and posts the review', async () => {
		const calls: string[] = [];
		let posted: unknown;
		const fakeFetch = (async (url: string, init: RequestInit) => {
			const route = url.replace('https://api.github.com', '');
			calls.push(`${init.method} ${route}`);
			const accept = (init.headers as Record<string, string>).Accept;
			if (init.method === 'POST') {
				posted = JSON.parse(String(init.body));
				return Response.json({ html_url: 'https://github.com/o/r/pull/7#review' });
			}
			if (route === '/repos/o/r/pulls/7' && accept.includes('diff')) {
				return new Response(diff);
			}
			if (route === '/repos/o/r/pulls/7') {
				return Response.json({ number: 7, title: 'Parse JSON', body: 'Fixes #3', html_url: 'https://github.com/o/r/pull/7', user: { login: 'a' }, head: { sha: 'abc', ref: 'json' }, base: { ref: 'main' } });
			}
			if (route.startsWith('/repos/o/r/pulls/7/comments') || route.startsWith('/repos/o/r/pulls/7/reviews')) {
				return Response.json([]);
			}
			if (route === '/repos/o/r/contents/.nighthawk/review.md?ref=abc') {
				return new Response('Always check HTTP status codes.');
			}
			if (route === '/repos/o/r/contents/src/api.ts?ref=abc') {
				return new Response('export function load(id) {\n  const url = `/api/${id}`;\n  return fetch(url).then(r => r.json());\n}\n');
			}
			return new Response('', { status: 404 });
		}) as typeof fetch;
		let request: ChatRequest | undefined;
		const stream = async function* (req: ChatRequest): AsyncGenerator<StreamEvent> {
			request = req;
			yield { type: 'text', text: '{"summary": "Parses JSON.", "findings": [{"path": "src/api.ts", "line": 3, "severity": "high", "title": "Unchecked response", "body": "Check r.ok."}]}' };
		};
		const github = new GitHub('t0ken', undefined, fakeFetch);
		const result = await reviewPullRequest(github, 'o/r', 7, stream, new AbortController().signal);
		await postReview(github, 'o/r', result, result.inline, result.general);
		const prompt = JSON.stringify(request);
		assert.deepStrictEqual([
			result.inline.length,
			result.reviewedBefore,
			prompt.includes('Always check HTTP status codes.'),
			prompt.includes('   3|   return fetch(url).then(r => r.json());'),
			posted,
		], [1, false, true, true, {
			commit_id: 'abc',
			event: 'COMMENT',
			body: reviewBody('Parses JSON.', result.inline, []),
			comments: [{ path: 'src/api.ts', line: 3, side: 'RIGHT', body: commentBody(result.inline[0]) }],
		}]);
		assert.ok(!calls.some(c => c.includes('old.txt')), 'deleted files are not fetched');
	});
});
