/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Background tasks: an agent working on its own Git worktree and branch.

export type BackgroundStatus = 'queued' | 'running' | 'waiting' | 'done' | 'failed' | 'stopped' | 'merged';

export interface BackgroundTask {
	id: string;
	/** What the user asked for, as typed. */
	prompt: string;
	/** A short name for lists. */
	title: string;
	/** The repository the worktree was made from. */
	repo: string;
	worktree: string;
	branch: string;
	/** The commit the branch started from. */
	base: string;
	/** The branch that was checked out in `repo` when the task started. */
	baseName?: string;
	status: BackgroundStatus;
	sessionId: string;
	created: number;
	finished?: number;
	changes?: { files: number; added: number; removed: number };
	error?: string;
}

/** "fix-the-flaky-upload-test" from a task, at most 40 characters on word boundaries. */
export function taskSlug(prompt: string): string {
	const words = prompt.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
	let slug = '';
	for (const word of words) {
		const next = slug ? `${slug}-${word}` : word;
		if (next.length > 40) {
			break;
		}
		slug = next;
	}
	return slug || 'task';
}

/** The first line of the task, shortened for lists. */
export function taskTitle(prompt: string): string {
	const line = prompt.trim().split('\n')[0].replace(/\s+/g, ' ');
	return line.length > 70 ? `${line.slice(0, 67).trimEnd()}...` : line;
}

/** What the agent is told, around the user's task. */
export function backgroundPrompt(task: Pick<BackgroundTask, 'prompt' | 'worktree' | 'branch' | 'baseName'>): string {
	return [
		task.prompt.trim(),
		'',
		'---',
		`You are working as a background task in a separate Git worktree at \`${task.worktree}\`, on the branch \`${task.branch}\`${task.baseName ? `, which starts from \`${task.baseName}\`` : ''}. The user keeps working in their own checkout meanwhile, so stay inside this worktree.`,
		'Work through the whole task without waiting for the user, and check your work (build, tests or lint) where the project has them. Do not push and do not switch branches. Nighthawk commits your changes on this branch when you finish, so you do not need to commit.',
		'End with a short summary of what you changed and anything the user should check.',
	].join('\n');
}

/** Parses `git diff --shortstat` output: " 3 files changed, 10 insertions(+), 2 deletions(-)". */
export function parseShortstat(text: string): { files: number; added: number; removed: number } {
	const number = (pattern: RegExp) => Number(pattern.exec(text)?.groups?.n ?? 0);
	return {
		files: number(/(?<n>\d+) files? changed/),
		added: number(/(?<n>\d+) insertions?\(\+\)/),
		removed: number(/(?<n>\d+) deletions?\(-\)/),
	};
}
