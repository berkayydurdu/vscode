/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Types mirror notes-server/src/work.ts and store.ts.

export type Role = 'owner' | 'admin' | 'editor' | 'viewer';
export type ItemKind = 'task' | 'bug' | 'rfc';
export type Priority = 'urgent' | 'high' | 'medium' | 'low' | 'none';
export type Verdict = 'approve' | 'request_changes' | 'comment';

export const ROLE_RANK: Record<Role, number> = { owner: 3, admin: 2, editor: 1, viewer: 0 };

export interface Member {
	userId: string;
	email: string;
	name: string;
	role: Role;
	joinedAt: number;
}

export interface Team {
	id: string;
	name: string;
	role: Role;
}

export interface ChecklistEntry {
	id: string;
	text: string;
	done: boolean;
}

export interface Item {
	id: string;
	teamId: string;
	number: number;
	kind: ItemKind;
	title: string;
	body: string;
	status: string;
	priority: Priority;
	assignees: string[];
	reviewers: string[];
	labels: string[];
	dueDate: string | null;
	estimateMinutes: number | null;
	checklist: ChecklistEntry[];
	createdBy: string;
	createdAt: number;
	updatedAt: number;
	updatedBy: string;
	version: number;
	seq: number;
	deleted: boolean;
	loggedMinutes: number;
	commentCount: number;
}

export type ItemChange = Partial<Pick<Item, 'kind' | 'title' | 'body' | 'status' | 'priority' | 'assignees' | 'reviewers' | 'labels' | 'dueDate' | 'estimateMinutes' | 'checklist'>>;

export interface Comment {
	id: string;
	itemId: string;
	userId: string;
	body: string;
	createdAt: number;
}

export interface Worklog {
	id: string;
	itemId: string;
	teamId: string;
	userId: string;
	minutes: number;
	date: string;
	note: string;
	createdAt: number;
}

export interface Review {
	itemId: string;
	userId: string;
	verdict: Verdict;
	body: string;
	createdAt: number;
}

export interface NoteMeta {
	id: string;
	path: string;
	updatedAt: number;
	updatedByName: string;
	deleted: boolean;
}

export interface User {
	id: string;
	name: string;
	email: string;
}

export class ApiError extends Error {
	constructor(readonly status: number, message: string) {
		super(message);
	}
}

interface VsCodeApi {
	postMessage(message: unknown): void;
	getState(): unknown;
	setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

export const vscode = acquireVsCodeApi();

const pending = new Map<number, { resolve: (value: any) => void; reject: (err: Error) => void }>();
let nextRequest = 1;

window.addEventListener('message', event => {
	const message = event.data;
	if (event.origin !== window.origin || message?.type !== 'response') {
		return;
	}
	const request = pending.get(message.id);
	if (request) {
		pending.delete(message.id);
		if (message.ok) {
			request.resolve(message.data);
		} else {
			request.reject(new ApiError(message.status, message.error));
		}
	}
});

/**
 * Calls the notes server through the extension, which holds the session
 * token. Only paths under the open team are allowed through.
 */
function request<T>(method: string, path: string, body?: unknown): Promise<T> {
	const id = nextRequest++;
	return new Promise<T>((resolve, reject) => {
		pending.set(id, { resolve, reject });
		vscode.postMessage({ type: 'request', id, method, path, body });
	});
}

export interface LinkedCommit {
	hash: string;
	shortHash: string;
	subject: string;
	author: string;
	/** Seconds since the epoch. */
	date: number;
}

export interface RepositoryLinks {
	name: string;
	root: string;
	current: string | undefined;
	branches: string[];
	commits: LinkedCommit[];
}

/** Time the extension saw you work on a ticket or branch, not yet on the timesheet. Mirrors src/core/timeTracking.ts. */
export interface Suggestion {
	id: string;
	date: string;
	repo: string;
	branch: string;
	teamId?: string;
	number?: number;
	key?: string;
	tracked: number;
	logged: number;
	minutes: number;
	files: string[];
}

/** Asks the extension itself for what only it has, such as the Git history of the open folders. */
export function extensionRequest<T>(type: string, payload: Record<string, unknown>): Promise<T> {
	const id = nextRequest++;
	return new Promise<T>((resolve, reject) => {
		pending.set(id, { resolve, reject });
		vscode.postMessage({ ...payload, type, id });
	});
}

/** The team's work API: items, comments, reviews and time. */
export class Api {

	constructor(private readonly teamId: string) { }

	private get base(): string {
		return `/api/teams/${encodeURIComponent(this.teamId)}`;
	}

	team() {
		return request<{ team: Team; members: Member[] }>('GET', this.base);
	}

	items(since: number) {
		return request<{ items: Item[]; cursor: number }>('GET', `${this.base}/items?since=${since}`);
	}

	item(itemId: string) {
		return request<{ item: Item; comments: Comment[]; worklogs: Worklog[]; reviews: Review[] }>('GET', `${this.base}/items/${itemId}`);
	}

	async createItem(kind: ItemKind, change: ItemChange & { title: string }): Promise<Item> {
		return (await request<{ item: Item }>('POST', `${this.base}/items`, { kind, ...change })).item;
	}

	async updateItem(itemId: string, change: ItemChange, baseVersion?: number): Promise<Item> {
		return (await request<{ item: Item }>('PATCH', `${this.base}/items/${itemId}`, { ...change, baseVersion })).item;
	}

	deleteItem(itemId: string) {
		return request('DELETE', `${this.base}/items/${itemId}`);
	}

	async addComment(itemId: string, body: string): Promise<Comment> {
		return (await request<{ comment: Comment }>('POST', `${this.base}/items/${itemId}/comments`, { body })).comment;
	}

	deleteComment(itemId: string, commentId: string) {
		return request('DELETE', `${this.base}/items/${itemId}/comments/${commentId}`);
	}

	async review(itemId: string, verdict: Verdict, body: string): Promise<Review[]> {
		return (await request<{ reviews: Review[] }>('POST', `${this.base}/items/${itemId}/reviews`, { verdict, body })).reviews;
	}

	async worklogs(query: { from?: string; to?: string; userId?: string; itemId?: string }): Promise<Worklog[]> {
		const params = new URLSearchParams(Object.entries(query).filter(([, value]) => value) as [string, string][]);
		return (await request<{ worklogs: Worklog[] }>('GET', `${this.base}/worklogs?${params}`)).worklogs;
	}

	async logTime(itemId: string, minutes: number, date: string, note = ''): Promise<Worklog> {
		return (await request<{ worklog: Worklog }>('POST', `${this.base}/worklogs`, { itemId, minutes, date, note })).worklog;
	}

	async updateWorklog(worklogId: string, change: { minutes?: number; date?: string; note?: string }): Promise<Worklog> {
		return (await request<{ worklog: Worklog }>('PATCH', `${this.base}/worklogs/${worklogId}`, change)).worklog;
	}

	deleteWorklog(worklogId: string) {
		return request('DELETE', `${this.base}/worklogs/${worklogId}`);
	}

	async notes(): Promise<NoteMeta[]> {
		return (await request<{ notes: NoteMeta[] }>('GET', `${this.base}/notes`)).notes;
	}
}
