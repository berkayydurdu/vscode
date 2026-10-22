/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Pull request reviews, as in Cursor's Bugbot: a model reads a GitHub pull
// request (the diff and the changed files) and its findings are posted as
// review comments on the lines they are about. The editor runs it on a pull
// request you pick, and a GitHub workflow (src/bot/reviewBot.ts) runs it on
// every push. Uses fetch only, so it runs in Node and in that workflow alike.

import { trimDiff } from './commit';
import type { ChatRequest, ModelStream } from './types';

/** Marks comments and reviews this reviewer wrote, so later runs can tell them apart. */
export const REVIEW_MARKER = '<!-- nighthawk-review -->';
/** The repository's own review instructions, read from the pull request's head. */
export const INSTRUCTION_FILES = ['.nighthawk/review.md', '.cursor/BUGBOT.md'];

const MAX_FILE_CHARS = 20_000;
const MAX_FILES_CHARS = 80_000;

export type Severity = 'high' | 'medium' | 'low';

export interface Finding {
	path: string;
	line: number;
	severity: Severity;
	title: string;
	body: string;
	/** The replacement for the commented line, posted as a suggestion GitHub can apply. */
	suggestion?: string;
}

export interface PullRequest {
	number: number;
	title: string;
	body: string | null;
	html_url: string;
	draft?: boolean;
	user: { login: string } | null;
	head: { sha: string; ref: string };
	base: { ref: string };
}

/** The GitHub REST calls a review needs. */
export class GitHub {
	private readonly token: string;
	private readonly api: string;
	private readonly fetcher: typeof fetch;

	constructor(token: string, api = 'https://api.github.com', fetcher: typeof fetch = fetch) {
		this.token = token;
		this.api = api.replace(/\/+$/, '');
		this.fetcher = fetcher;
	}

	private async call(route: string, options: { method?: string; accept?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<Response> {
		const response = await this.fetcher(`${this.api}${route}`, {
			method: options.method ?? 'GET',
			headers: {
				'Accept': options.accept ?? 'application/vnd.github+json',
				'Authorization': `Bearer ${this.token}`,
				'X-GitHub-Api-Version': '2022-11-28',
				'User-Agent': 'nighthawk-review',
				...(options.body ? { 'Content-Type': 'application/json' } : {}),
			},
			body: options.body ? JSON.stringify(options.body) : undefined,
			signal: options.signal,
		});
		if (!response.ok && response.status !== 404) {
			const text = await response.text().catch(() => '');
			let message = text;
			try {
				message = (JSON.parse(text) as { message?: string }).message ?? text;
			} catch {
				// Not JSON; keep the text.
			}
			throw new Error(`GitHub ${options.method ?? 'GET'} ${route} failed (${response.status}): ${message.slice(0, 300)}`);
		}
		return response;
	}

	private async json<T>(route: string, signal?: AbortSignal): Promise<T | undefined> {
		const response = await this.call(route, { signal });
		return response.status === 404 ? undefined : await response.json() as T;
	}

	async pullRequests(repo: string, signal?: AbortSignal): Promise<PullRequest[]> {
		return await this.json<PullRequest[]>(`/repos/${repo}/pulls?state=open&per_page=50&sort=updated&direction=desc`, signal) ?? [];
	}

	async pullRequest(repo: string, number: number, signal?: AbortSignal): Promise<PullRequest> {
		const pr = await this.json<PullRequest>(`/repos/${repo}/pulls/${number}`, signal);
		if (!pr) {
			throw new Error(`Pull request #${number} was not found in ${repo}.`);
		}
		return pr;
	}

	async diff(repo: string, number: number, signal?: AbortSignal): Promise<string> {
		return (await this.call(`/repos/${repo}/pulls/${number}`, { accept: 'application/vnd.github.diff', signal })).text();
	}

	/** A file's text at a commit, or undefined when it does not exist there. */
	async file(repo: string, path: string, ref: string, signal?: AbortSignal): Promise<string | undefined> {
		const response = await this.call(`/repos/${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(ref)}`, { accept: 'application/vnd.github.raw', signal });
		return response.status === 404 ? undefined : response.text();
	}

	/** Bodies of the review comments and reviews already on the pull request. */
	async existing(repo: string, number: number, signal?: AbortSignal): Promise<{ comments: { path: string; body: string }[]; reviews: { body: string }[] }> {
		const [comments, reviews] = await Promise.all([
			this.json<{ path: string; body: string }[]>(`/repos/${repo}/pulls/${number}/comments?per_page=100`, signal),
			this.json<{ body: string }[]>(`/repos/${repo}/pulls/${number}/reviews?per_page=100`, signal),
		]);
		return { comments: comments ?? [], reviews: reviews ?? [] };
	}

	async postReview(repo: string, number: number, review: { commit_id: string; body: string; comments: { path: string; line: number; side: 'RIGHT'; body: string }[] }, signal?: AbortSignal): Promise<{ html_url: string }> {
		const response = await this.call(`/repos/${repo}/pulls/${number}/reviews`, { method: 'POST', body: { ...review, event: 'COMMENT' }, signal });
		return await response.json() as { html_url: string };
	}
}

/** `owner/repo` from a GitHub remote URL (https or ssh), or undefined for other hosts. */
export function githubRepo(remote: string): string | undefined {
	const match = /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|(?:ssh:\/\/)?git@github\.com[:/])(?<owner>[\w.-]+)\/(?<name>[\w.-]+?)(?:\.git)?\/?$/i.exec(remote.trim());
	return match?.groups ? `${match.groups.owner}/${match.groups.name}` : undefined;
}

interface DiffFile {
	path: string;
	deleted: boolean;
	/** Lines of the new file that the diff shows (added or unchanged), which GitHub lets a comment go on. */
	lines: Set<number>;
}

/** The files a unified diff changes and the new-file lines it shows. */
export function diffFiles(diff: string): DiffFile[] {
	const files: DiffFile[] = [];
	let current: DiffFile | undefined;
	let line = 0;
	for (const text of diff.split('\n')) {
		const header = /^diff --git a\/(?<old>.+?) b\/(?<new>.+)$/.exec(text);
		if (header?.groups) {
			current = { path: header.groups.new, deleted: false, lines: new Set() };
			files.push(current);
			continue;
		}
		if (!current) {
			continue;
		}
		if (text.startsWith('+++ ')) {
			current.deleted = text === '+++ /dev/null';
			continue;
		}
		const hunk = /^@@ -\d+(?:,\d+)? \+(?<start>\d+)(?:,\d+)? @@/.exec(text);
		if (hunk?.groups) {
			line = Number(hunk.groups.start);
			continue;
		}
		if (line && (text.startsWith('+') || text.startsWith(' '))) {
			current.lines.add(line++);
		}
	}
	return files;
}

/** The changed files' new text with line numbers, as far as the budget allows; the model needs them to judge a change and to name lines. */
export function numberedFiles(files: { path: string; text: string }[]): string {
	const parts: string[] = [];
	let total = 0;
	for (const { path, text } of files) {
		const lines = text.split('\n');
		let numbered = lines.map((l, i) => `${String(i + 1).padStart(4)}| ${l}`).join('\n');
		if (numbered.length > MAX_FILE_CHARS) {
			numbered = `${numbered.slice(0, MAX_FILE_CHARS).replace(/\n[^\n]*$/, '')}\n... (rest of the file left out)`;
		}
		if (total + numbered.length > MAX_FILES_CHARS) {
			parts.push(`(${files.length - parts.length} more changed files left out; judge them from the diff)`);
			break;
		}
		parts.push(`<file path="${path}">\n${numbered}\n</file>`);
		total += numbered.length;
	}
	return parts.join('\n\n');
}

/** The request that reviews a pull request and answers in JSON. */
export function reviewRequest(pr: Pick<PullRequest, 'title' | 'body' | 'head' | 'base'>, diff: string, files: string, instructions?: string): ChatRequest {
	const system = [
		'You review GitHub pull requests the way a careful senior engineer would, looking for problems worth a comment before the change is merged.',
		'Look for: bugs and wrong logic, missed edge cases (empty, null, off by one, concurrency), security problems (injection, secrets, missing checks), broken error handling, data loss, performance traps, and API misuse.',
		'Only report real problems in the changed code that you can explain. Do not comment on style, formatting or naming unless it causes a bug, and do not praise. Fewer, accurate findings are better than many; an empty list is a fine answer.',
		'Reply with JSON only, no code fences, in this shape:',
		'{"summary": "one or two sentences on what the pull request does and its overall risk", "findings": [{"path": "src/file.ts", "line": 42, "severity": "high", "title": "short headline", "body": "what goes wrong, when, and how to fix it", "suggestion": "optional replacement for that one line"}]}',
		'"path" is the file\'s path as in the diff. "line" is the line number in the new version of the file, as numbered in the file listing, and must be a line the diff adds or shows. "severity" is "high" (will break or is unsafe), "medium" (likely bug or risk) or "low" (worth a look).',
		'Give "suggestion" only when the fix replaces exactly the commented line; write the whole new line with its indentation.',
		instructions ? `\nThe repository's own review instructions, which take priority:\n${instructions.trim()}` : '',
	].filter(Boolean).join('\n');
	const text = [
		`Pull request: ${pr.title} (${pr.head.ref} into ${pr.base.ref})`,
		pr.body?.trim() ? `Description:\n${pr.body.trim().slice(0, 4000)}` : '',
		`Diff:\n${trimDiff(diff)}`,
		files ? `Changed files after the change, with line numbers:\n${files}` : '',
	].filter(Boolean).join('\n\n');
	return { system, messages: [{ role: 'user', content: [{ type: 'text', text }] }], tools: [], maxTokens: 8000 };
}

/** Reads the model's answer, keeping only well-formed findings. */
export function parseReview(text: string): { summary: string; findings: Finding[] } {
	const start = text.indexOf('{');
	const end = text.lastIndexOf('}');
	if (start < 0 || end < start) {
		throw new Error('The model did not answer with a review.');
	}
	const value = JSON.parse(text.slice(start, end + 1)) as { summary?: unknown; findings?: unknown };
	const findings = (Array.isArray(value.findings) ? value.findings : []).flatMap((f: Partial<Record<keyof Finding, unknown>>) => {
		const line = Number(f?.line);
		if (typeof f?.path !== 'string' || !Number.isInteger(line) || line < 1 || typeof f.title !== 'string' || !f.title.trim()) {
			return [];
		}
		const severity: Severity = f.severity === 'high' || f.severity === 'low' ? f.severity : 'medium';
		return [{ path: f.path.replace(/^[ab]\//, ''), line, severity, title: f.title.trim(), body: typeof f.body === 'string' ? f.body.trim() : '', suggestion: typeof f.suggestion === 'string' && f.suggestion.trim() ? f.suggestion.replace(/\n+$/, '') : undefined }];
	});
	return { summary: typeof value.summary === 'string' ? value.summary.trim() : '', findings };
}

/**
 * Puts each finding on a line GitHub accepts (one the diff shows, moving a
 * few lines when the model was close); the rest go in the review's body.
 */
export function placeFindings(findings: Finding[], files: DiffFile[]): { inline: Finding[]; general: Finding[] } {
	const byPath = new Map(files.map(f => [f.path, f]));
	const inline: Finding[] = [];
	const general: Finding[] = [];
	for (const finding of findings) {
		const lines = byPath.get(finding.path)?.lines;
		const line = lines && [0, 1, -1, 2, -2, 3, -3].map(d => finding.line + d).find(l => lines.has(l));
		if (line) {
			// A suggestion replaces the line the comment is on, so it only fits the line it was written for.
			inline.push({ ...finding, line, suggestion: line === finding.line ? finding.suggestion : undefined });
		} else {
			general.push(finding);
		}
	}
	return { inline, general };
}

const SEVERITY_LABEL: Record<Severity, string> = { high: 'High', medium: 'Medium', low: 'Low' };
const SEVERITY_ORDER: Record<Severity, number> = { high: 0, medium: 1, low: 2 };

/** A finding as a review comment, with a suggestion block GitHub can apply. */
export function commentBody(finding: Finding): string {
	const parts = [`**${SEVERITY_LABEL[finding.severity]}: ${finding.title}**`];
	if (finding.body) {
		parts.push(finding.body);
	}
	if (finding.suggestion !== undefined) {
		const fence = finding.suggestion.includes('```') ? '````' : '```';
		parts.push(`${fence}suggestion\n${finding.suggestion}\n${fence}`);
	}
	parts.push(REVIEW_MARKER);
	return parts.join('\n\n');
}

/** The review's own text: the summary, a count, and the findings that have no line of their own. */
export function reviewBody(summary: string, inline: Finding[], general: Finding[]): string {
	const all = [...inline, ...general];
	const counts = (['high', 'medium', 'low'] as const).map(s => [s, all.filter(f => f.severity === s).length] as const).filter(([, n]) => n).map(([s, n]) => `${n} ${SEVERITY_LABEL[s].toLowerCase()}`);
	const lines = ['### Nighthawk review'];
	if (summary) {
		lines.push(summary);
	}
	lines.push(all.length ? `Found ${all.length === 1 ? '1 issue' : `${all.length} issues`} (${counts.join(', ')}).` : 'No issues found.');
	for (const finding of [...general].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])) {
		lines.push(`- **${SEVERITY_LABEL[finding.severity]}: ${finding.title}** (\`${finding.path}:${finding.line}\`)${finding.body ? `: ${finding.body}` : ''}`);
	}
	lines.push(REVIEW_MARKER);
	return lines.join('\n\n');
}

const titleKey = (path: string, title: string) => `${path}\n${title.toLowerCase().replace(/\W+/g, ' ').trim()}`;

/** Drops findings an earlier run already posted on the same file with the same headline. */
export function newFindings(findings: Finding[], comments: { path: string; body: string }[]): Finding[] {
	const posted = new Set(comments.filter(c => c.body.includes(REVIEW_MARKER)).flatMap(c => {
		const title = /^\*\*(?:High|Medium|Low): (?<title>.+?)\*\*/.exec(c.body)?.groups?.title;
		return title ? [titleKey(c.path, title)] : [];
	}));
	return findings.filter(f => !posted.has(titleKey(f.path, f.title)));
}

export interface ReviewResult {
	pr: PullRequest;
	summary: string;
	inline: Finding[];
	general: Finding[];
	/** Findings left out because an earlier review already posted them. */
	skipped: number;
	/** Whether this reviewer has reviewed the pull request before. */
	reviewedBefore: boolean;
}

/** Reads a pull request, has the model review it, and places the findings; posting is up to the caller. */
export async function reviewPullRequest(github: GitHub, repo: string, number: number, stream: ModelStream, signal: AbortSignal, onStatus: (status: string) => void = () => undefined): Promise<ReviewResult> {
	onStatus('Reading the pull request');
	const pr = await github.pullRequest(repo, number, signal);
	const [diff, existing] = await Promise.all([github.diff(repo, number, signal), github.existing(repo, number, signal)]);
	const files = diffFiles(diff);
	const instructions = (await Promise.all(INSTRUCTION_FILES.map(f => github.file(repo, f, pr.head.sha, signal)))).find(Boolean);
	const contents = await Promise.all(files.filter(f => !f.deleted && !/(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$|\.(min\.js|map|snap|png|jpe?g|gif|ico|woff2?|pdf|zip)$/i.test(f.path)).slice(0, 40).map(async f => ({ path: f.path, text: await github.file(repo, f.path, pr.head.sha, signal) ?? '' })));
	onStatus('Reviewing the changes');
	let text = '';
	for await (const event of stream(reviewRequest(pr, diff, numberedFiles(contents.filter(c => c.text && !c.text.includes('\0'))), instructions), signal)) {
		if (event.type === 'text') {
			text += event.text;
		}
	}
	const review = parseReview(text);
	const fresh = newFindings(review.findings, existing.comments);
	return {
		pr,
		summary: review.summary,
		...placeFindings(fresh, files),
		skipped: review.findings.length - fresh.length,
		reviewedBefore: existing.reviews.some(r => r.body?.includes(REVIEW_MARKER)) || existing.comments.some(c => c.body.includes(REVIEW_MARKER)),
	};
}

/** Posts a review with the findings as line comments. */
export function postReview(github: GitHub, repo: string, result: Pick<ReviewResult, 'pr' | 'summary'>, inline: Finding[], general: Finding[], signal?: AbortSignal): Promise<{ html_url: string }> {
	return github.postReview(repo, result.pr.number, {
		commit_id: result.pr.head.sha,
		body: reviewBody(result.summary, inline, general),
		comments: inline.map(f => ({ path: f.path, line: f.line, side: 'RIGHT' as const, body: commentBody(f) })),
	}, signal);
}
