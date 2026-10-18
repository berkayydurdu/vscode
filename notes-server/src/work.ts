/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

/** Tasks and bugs are tickets on the board; RFCs are documents that go through review. */
export type ItemKind = 'task' | 'bug' | 'rfc';
export const ITEM_KINDS: readonly ItemKind[] = ['task', 'bug', 'rfc'];

export const TICKET_STATUSES = ['backlog', 'todo', 'in_progress', 'in_review', 'done'] as const;
export const RFC_STATUSES = ['draft', 'in_review', 'accepted', 'rejected', 'withdrawn'] as const;
export const PRIORITIES = ['urgent', 'high', 'medium', 'low', 'none'] as const;
export const VERDICTS = ['approve', 'request_changes', 'comment'] as const;

export type Priority = typeof PRIORITIES[number];
export type Verdict = typeof VERDICTS[number];

export interface ChecklistEntry {
	id: string;
	text: string;
	done: boolean;
}

export interface Item {
	id: string;
	teamId: string;
	/** Per-team ticket number, shown as e.g. `NC-12`. */
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
	/** Total minutes logged by everyone. */
	loggedMinutes: number;
	commentCount: number;
}

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
	/** Day the work was done, `YYYY-MM-DD`. */
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

export type ItemChange = Partial<Pick<Item, 'kind' | 'title' | 'body' | 'status' | 'priority' | 'assignees' | 'reviewers' | 'labels' | 'dueDate' | 'estimateMinutes' | 'checklist'>>;

export const WORK_SCHEMA = `
CREATE TABLE IF NOT EXISTS items (
	id TEXT PRIMARY KEY,
	team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
	number INTEGER NOT NULL,
	kind TEXT NOT NULL,
	title TEXT NOT NULL,
	body TEXT NOT NULL DEFAULT '',
	status TEXT NOT NULL,
	priority TEXT NOT NULL DEFAULT 'none',
	assignees TEXT NOT NULL DEFAULT '[]',
	reviewers TEXT NOT NULL DEFAULT '[]',
	labels TEXT NOT NULL DEFAULT '[]',
	due_date TEXT,
	estimate_minutes INTEGER,
	checklist TEXT NOT NULL DEFAULT '[]',
	created_by TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	updated_by TEXT NOT NULL,
	version INTEGER NOT NULL DEFAULT 1,
	seq INTEGER NOT NULL,
	deleted INTEGER NOT NULL DEFAULT 0,
	UNIQUE (team_id, number)
);
CREATE INDEX IF NOT EXISTS items_team_seq ON items(team_id, seq);
CREATE TABLE IF NOT EXISTS comments (
	id TEXT PRIMARY KEY,
	item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
	user_id TEXT NOT NULL,
	body TEXT NOT NULL,
	created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS comments_item ON comments(item_id);
CREATE TABLE IF NOT EXISTS worklogs (
	id TEXT PRIMARY KEY,
	item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
	team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
	user_id TEXT NOT NULL,
	minutes INTEGER NOT NULL,
	date TEXT NOT NULL,
	note TEXT NOT NULL DEFAULT '',
	created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS worklogs_team_date ON worklogs(team_id, date);
CREATE INDEX IF NOT EXISTS worklogs_item ON worklogs(item_id);
CREATE TABLE IF NOT EXISTS reviews (
	item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
	user_id TEXT NOT NULL,
	verdict TEXT NOT NULL,
	body TEXT NOT NULL DEFAULT '',
	created_at INTEGER NOT NULL,
	PRIMARY KEY (item_id, user_id)
);
`;

type Row = Record<string, unknown>;

export function defaultStatus(kind: ItemKind): string {
	return kind === 'rfc' ? 'draft' : 'todo';
}

export function isValidStatus(kind: ItemKind, status: string): boolean {
	return (kind === 'rfc' ? RFC_STATUSES as readonly string[] : TICKET_STATUSES as readonly string[]).includes(status);
}

/**
 * Work items (tasks, bugs, RFCs), their comments, time logs and RFC reviews.
 * Shares the notes server's SQLite database.
 */
export class WorkStore {

	private readonly db: DatabaseSync;
	private readonly nextSeq: () => number;

	constructor(db: DatabaseSync, nextSeq: () => number) {
		this.db = db;
		this.nextSeq = nextSeq;
		db.exec(WORK_SCHEMA);
	}

	private transaction<T>(fn: () => T): T {
		this.db.exec('BEGIN IMMEDIATE');
		try {
			const result = fn();
			this.db.exec('COMMIT');
			return result;
		} catch (err) {
			this.db.exec('ROLLBACK');
			throw err;
		}
	}

	private readonly itemColumns = `items.*,
		(SELECT COALESCE(SUM(minutes), 0) FROM worklogs WHERE worklogs.item_id = items.id) AS logged_minutes,
		(SELECT COUNT(*) FROM comments WHERE comments.item_id = items.id) AS comment_count`;

	listItems(teamId: string, since: number): { items: Item[]; cursor: number } {
		const rows = this.db.prepare(`
			SELECT ${this.itemColumns} FROM items
			WHERE team_id = ? AND seq > ? AND (deleted = 0 OR ? > 0)
			ORDER BY seq
		`).all(teamId, since, since) as Row[];
		const cursor = this.db.prepare(`SELECT value FROM counters WHERE name = 'seq'`).get() as Row | undefined;
		return { items: rows.map(toItem), cursor: cursor ? Number(cursor.value) : 0 };
	}

	getItem(teamId: string, itemId: string): Item | undefined {
		const row = this.db.prepare(`SELECT ${this.itemColumns} FROM items WHERE team_id = ? AND id = ?`).get(teamId, itemId) as Row | undefined;
		return row ? toItem(row) : undefined;
	}

	createItem(teamId: string, userId: string, kind: ItemKind, change: ItemChange & { title: string }): Item {
		return this.transaction(() => {
			const max = this.db.prepare('SELECT COALESCE(MAX(number), 0) AS n FROM items WHERE team_id = ?').get(teamId) as Row;
			const id = randomUUID();
			const now = Date.now();
			this.db.prepare(`
				INSERT INTO items (id, team_id, number, kind, title, body, status, priority, assignees, reviewers, labels, due_date, estimate_minutes, checklist, created_by, created_at, updated_at, updated_by, seq)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			`).run(
				id, teamId, Number(max.n) + 1, kind, change.title, change.body ?? '', change.status ?? defaultStatus(kind), change.priority ?? 'none',
				JSON.stringify(change.assignees ?? []), JSON.stringify(change.reviewers ?? []), JSON.stringify(change.labels ?? []),
				change.dueDate ?? null, change.estimateMinutes ?? null, JSON.stringify(change.checklist ?? []),
				userId, now, now, userId, this.nextSeq(),
			);
			return this.getItem(teamId, id)!;
		});
	}

	/**
	 * Applies a field-level change. With `baseVersion` the update is refused
	 * when someone else changed the item first (returns 'conflict').
	 */
	updateItem(teamId: string, itemId: string, userId: string, change: ItemChange, baseVersion?: number): Item | 'conflict' | undefined {
		return this.transaction(() => {
			const current = this.getItem(teamId, itemId);
			if (!current || current.deleted) {
				return undefined;
			}
			if (baseVersion !== undefined && baseVersion !== current.version) {
				return 'conflict';
			}
			const next = { ...current, ...change };
			this.db.prepare(`
				UPDATE items SET kind = ?, title = ?, body = ?, status = ?, priority = ?, assignees = ?, reviewers = ?, labels = ?, due_date = ?,
					estimate_minutes = ?, checklist = ?, updated_at = ?, updated_by = ?, version = version + 1, seq = ?
				WHERE id = ?
			`).run(
				next.kind, next.title, next.body, next.status, next.priority, JSON.stringify(next.assignees), JSON.stringify(next.reviewers),
				JSON.stringify(next.labels), next.dueDate, next.estimateMinutes, JSON.stringify(next.checklist), Date.now(), userId, this.nextSeq(), itemId,
			);
			return this.getItem(teamId, itemId);
		});
	}

	deleteItem(teamId: string, itemId: string, userId: string): boolean {
		const result = this.db.prepare('UPDATE items SET deleted = 1, updated_at = ?, updated_by = ?, version = version + 1, seq = ? WHERE team_id = ? AND id = ? AND deleted = 0')
			.run(Date.now(), userId, this.nextSeq(), teamId, itemId);
		return Number(result.changes) > 0;
	}

	/** Bumps an item's sequence number so clients syncing with `since` see related changes (comments, time, reviews). */
	private touch(itemId: string): void {
		this.db.prepare('UPDATE items SET seq = ? WHERE id = ?').run(this.nextSeq(), itemId);
	}

	// --- comments

	comments(itemId: string): Comment[] {
		const rows = this.db.prepare('SELECT * FROM comments WHERE item_id = ? ORDER BY created_at').all(itemId) as Row[];
		return rows.map(row => ({ id: String(row.id), itemId: String(row.item_id), userId: String(row.user_id), body: String(row.body), createdAt: Number(row.created_at) }));
	}

	addComment(itemId: string, userId: string, body: string): Comment {
		const comment: Comment = { id: randomUUID(), itemId, userId, body, createdAt: Date.now() };
		this.db.prepare('INSERT INTO comments (id, item_id, user_id, body, created_at) VALUES (?, ?, ?, ?, ?)').run(comment.id, itemId, userId, body, comment.createdAt);
		this.touch(itemId);
		return comment;
	}

	getComment(commentId: string): Comment | undefined {
		return this.db.prepare('SELECT id, item_id AS itemId, user_id AS userId, body, created_at AS createdAt FROM comments WHERE id = ?').get(commentId) as Comment | undefined;
	}

	deleteComment(commentId: string): void {
		const comment = this.getComment(commentId);
		this.db.prepare('DELETE FROM comments WHERE id = ?').run(commentId);
		if (comment) {
			this.touch(comment.itemId);
		}
	}

	// --- time tracking

	worklogs(teamId: string, filter: { itemId?: string; userId?: string; from?: string; to?: string }): Worklog[] {
		const where = ['team_id = ?'];
		const params: (string | number)[] = [teamId];
		if (filter.itemId) {
			where.push('item_id = ?');
			params.push(filter.itemId);
		}
		if (filter.userId) {
			where.push('user_id = ?');
			params.push(filter.userId);
		}
		if (filter.from) {
			where.push('date >= ?');
			params.push(filter.from);
		}
		if (filter.to) {
			where.push('date <= ?');
			params.push(filter.to);
		}
		const rows = this.db.prepare(`SELECT * FROM worklogs WHERE ${where.join(' AND ')} ORDER BY date, created_at`).all(...params) as Row[];
		return rows.map(toWorklog);
	}

	getWorklog(worklogId: string): Worklog | undefined {
		const row = this.db.prepare('SELECT * FROM worklogs WHERE id = ?').get(worklogId) as Row | undefined;
		return row ? toWorklog(row) : undefined;
	}

	addWorklog(teamId: string, itemId: string, userId: string, minutes: number, date: string, note: string): Worklog {
		const worklog: Worklog = { id: randomUUID(), itemId, teamId, userId, minutes, date, note, createdAt: Date.now() };
		this.db.prepare('INSERT INTO worklogs (id, item_id, team_id, user_id, minutes, date, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
			.run(worklog.id, itemId, teamId, userId, minutes, date, note, worklog.createdAt);
		this.touch(itemId);
		return worklog;
	}

	updateWorklog(worklogId: string, change: { minutes?: number; date?: string; note?: string }): Worklog | undefined {
		const current = this.getWorklog(worklogId);
		if (!current) {
			return undefined;
		}
		const next = { ...current, ...change };
		this.db.prepare('UPDATE worklogs SET minutes = ?, date = ?, note = ? WHERE id = ?').run(next.minutes, next.date, next.note, worklogId);
		this.touch(current.itemId);
		return this.getWorklog(worklogId);
	}

	deleteWorklog(worklogId: string): void {
		const current = this.getWorklog(worklogId);
		this.db.prepare('DELETE FROM worklogs WHERE id = ?').run(worklogId);
		if (current) {
			this.touch(current.itemId);
		}
	}

	// --- RFC reviews

	reviews(itemId: string): Review[] {
		const rows = this.db.prepare('SELECT * FROM reviews WHERE item_id = ? ORDER BY created_at').all(itemId) as Row[];
		return rows.map(row => ({ itemId: String(row.item_id), userId: String(row.user_id), verdict: row.verdict as Verdict, body: String(row.body), createdAt: Number(row.created_at) }));
	}

	/** Records a reviewer's verdict, replacing their earlier one. */
	setReview(itemId: string, userId: string, verdict: Verdict, body: string): void {
		this.db.prepare(`
			INSERT INTO reviews (item_id, user_id, verdict, body, created_at) VALUES (?, ?, ?, ?, ?)
			ON CONFLICT(item_id, user_id) DO UPDATE SET verdict = excluded.verdict, body = excluded.body, created_at = excluded.created_at
		`).run(itemId, userId, verdict, body, Date.now());
		this.touch(itemId);
	}
}

function parseJson<T>(value: unknown, fallback: T): T {
	try {
		return typeof value === 'string' ? JSON.parse(value) as T : fallback;
	} catch {
		return fallback;
	}
}

function toItem(row: Row): Item {
	return {
		id: String(row.id),
		teamId: String(row.team_id),
		number: Number(row.number),
		kind: row.kind as ItemKind,
		title: String(row.title),
		body: String(row.body),
		status: String(row.status),
		priority: row.priority as Priority,
		assignees: parseJson(row.assignees, []),
		reviewers: parseJson(row.reviewers, []),
		labels: parseJson(row.labels, []),
		dueDate: row.due_date === null ? null : String(row.due_date),
		estimateMinutes: row.estimate_minutes === null ? null : Number(row.estimate_minutes),
		checklist: parseJson(row.checklist, []),
		createdBy: String(row.created_by),
		createdAt: Number(row.created_at),
		updatedAt: Number(row.updated_at),
		updatedBy: String(row.updated_by),
		version: Number(row.version),
		seq: Number(row.seq),
		deleted: Number(row.deleted) !== 0,
		loggedMinutes: Number(row.logged_minutes ?? 0),
		commentCount: Number(row.comment_count ?? 0),
	};
}

function toWorklog(row: Row): Worklog {
	return {
		id: String(row.id),
		itemId: String(row.item_id),
		teamId: String(row.team_id),
		userId: String(row.user_id),
		minutes: Number(row.minutes),
		date: String(row.date),
		note: String(row.note),
		createdAt: Number(row.created_at),
	};
}
