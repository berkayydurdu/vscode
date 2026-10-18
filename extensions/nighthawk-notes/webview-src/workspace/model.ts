/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Api, ApiError, ROLE_RANK, vscode, type Item, type ItemChange, type ItemKind, type Member, type NoteMeta, type Priority, type Team, type User } from './api';
import { t } from './l10n';

export type ViewId = 'home' | 'board' | 'tickets' | 'timesheet' | 'rfcs';

export interface Filters {
	text: string;
	assignee: string | null;
	priority: Priority | null;
	kind: ItemKind | null;
	label: string | null;
}

interface SavedState {
	view: ViewId;
	filters: Filters;
	timesheetUser: string | null;
	boardGrouping: BoardGrouping;
}

export type BoardGrouping = 'status' | 'assignee' | 'priority';

export const TICKET_STATUSES = ['backlog', 'todo', 'in_progress', 'in_review', 'done'] as const;
export const RFC_STATUSES = ['draft', 'in_review', 'accepted', 'rejected', 'withdrawn'] as const;
export const PRIORITIES: Priority[] = ['urgent', 'high', 'medium', 'low', 'none'];

export function statusLabel(kind: ItemKind, status: string): string {
	if (kind === 'rfc') {
		switch (status) {
			case 'draft': return t('Draft');
			case 'in_review': return t('In Review');
			case 'accepted': return t('Accepted');
			case 'rejected': return t('Rejected');
			default: return t('Withdrawn');
		}
	}
	switch (status) {
		case 'backlog': return t('Backlog');
		case 'todo': return t('To Do');
		case 'in_progress': return t('In Progress');
		case 'in_review': return t('In Review');
		default: return t('Done');
	}
}

export function priorityLabel(priority: Priority): string {
	switch (priority) {
		case 'urgent': return t('Urgent');
		case 'high': return t('High');
		case 'medium': return t('Medium');
		case 'low': return t('Low');
		default: return t('No Priority');
	}
}

export function kindLabel(kind: ItemKind): string {
	return kind === 'bug' ? t('Bug') : kind === 'rfc' ? t('RFC') : t('Task');
}

export function statusesOf(kind: ItemKind): readonly string[] {
	return kind === 'rfc' ? RFC_STATUSES : TICKET_STATUSES;
}

export function isClosed(item: Item): boolean {
	return item.kind === 'rfc' ? ['accepted', 'rejected', 'withdrawn'].includes(item.status) : item.status === 'done';
}

const EMPTY_FILTERS: Filters = { text: '', assignee: null, priority: null, kind: null, label: null };

/**
 * Everything the workspace shows: the team, its members and its items,
 * kept current by polling the server for changes. Views subscribe and
 * re-render when it changes.
 */
export class Model {

	readonly api: Api;
	team: Team;
	members: Member[] = [];
	notes: NoteMeta[] = [];
	readonly items = new Map<string, Item>();
	view: ViewId;
	filters: Filters;
	timesheetUser: string | null;
	boardGrouping: BoardGrouping;
	selected: string | null = null;
	loaded = false;
	private cursor = 0;
	private readonly listeners = new Set<() => void>();
	private readonly itemListeners = new Set<(item: Item) => void>();

	constructor(readonly teamId: string, readonly me: User, teamName: string) {
		this.api = new Api(teamId);
		this.team = { id: teamId, name: teamName, role: 'viewer' };
		const saved = vscode.getState() as Partial<SavedState> | undefined;
		this.view = saved?.view ?? 'home';
		this.filters = { ...EMPTY_FILTERS, ...saved?.filters };
		this.timesheetUser = saved?.timesheetUser ?? null;
		this.boardGrouping = saved?.boardGrouping ?? 'status';
	}

	get canEdit(): boolean {
		return ROLE_RANK[this.team.role] >= ROLE_RANK.editor;
	}

	get isAdmin(): boolean {
		return ROLE_RANK[this.team.role] >= ROLE_RANK.admin;
	}

	/** Short ticket prefix from the team name: "Nighthawk Core" is NC. */
	get prefix(): string {
		const words = this.team.name.replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
		const prefix = words.length > 1 ? words.map(w => w[0]).join('').slice(0, 4) : (words[0] ?? 'T').slice(0, 3);
		return prefix.toUpperCase();
	}

	key(item: Item): string {
		return `${this.prefix}-${item.number}`;
	}

	member(userId: string): Member | undefined {
		return this.members.find(m => m.userId === userId);
	}

	people(userIds: string[]): Member[] {
		return userIds.map(id => this.member(id) ?? { userId: id, name: t('Former member'), email: '', role: 'viewer' as const, joinedAt: 0 });
	}

	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** Called when an item changes, from this window or from a teammate. */
	onItem(listener: (item: Item) => void): () => void {
		this.itemListeners.add(listener);
		return () => this.itemListeners.delete(listener);
	}

	changed(): void {
		vscode.setState({ view: this.view, filters: this.filters, timesheetUser: this.timesheetUser, boardGrouping: this.boardGrouping } satisfies SavedState);
		this.listeners.forEach(listener => listener());
	}

	all(): Item[] {
		return [...this.items.values()];
	}

	labels(): string[] {
		return [...new Set(this.all().flatMap(item => item.labels))].sort((a, b) => a.localeCompare(b));
	}

	/** Tickets (tasks and bugs) matching the toolbar filters. */
	filtered(predicate: (item: Item) => boolean = () => true): Item[] {
		const { text, assignee, priority, kind, label } = this.filters;
		const needle = text.trim().toLowerCase();
		return this.all().filter(item =>
			predicate(item)
			&& (!needle || item.title.toLowerCase().includes(needle) || this.key(item).toLowerCase() === needle || item.labels.some(l => l.toLowerCase().includes(needle)))
			&& (!assignee || (assignee === 'none' ? !item.assignees.length : item.assignees.includes(assignee)))
			&& (!priority || item.priority === priority)
			&& (!kind || item.kind === kind)
			&& (!label || item.labels.includes(label)));
	}

	hasFilters(): boolean {
		const { text, assignee, priority, kind, label } = this.filters;
		return !!(text || assignee || priority || kind || label);
	}

	clearFilters(): void {
		this.filters = { ...EMPTY_FILTERS };
		this.changed();
	}

	async load(): Promise<void> {
		const [{ team, members }, notes] = await Promise.all([this.api.team(), this.api.notes().catch(() => [])]);
		this.team = team;
		this.members = members;
		this.notes = notes.filter(note => !note.deleted).sort((a, b) => b.updatedAt - a.updatedAt);
		await this.sync();
		this.loaded = true;
		this.changed();
	}

	/** Fetches what changed since the last sync. */
	async sync(): Promise<void> {
		const { items, cursor } = await this.api.items(this.cursor);
		this.cursor = cursor;
		if (!items.length) {
			return;
		}
		for (const item of items) {
			this.put(item);
		}
		this.changed();
	}

	async refreshTeam(): Promise<void> {
		const [{ team, members }, notes] = await Promise.all([this.api.team(), this.api.notes().catch(() => this.notes)]);
		const before = JSON.stringify([this.team, this.members, this.notes.map(n => n.id + n.updatedAt)]);
		this.team = team;
		this.members = members;
		this.notes = notes.filter(note => !note.deleted).sort((a, b) => b.updatedAt - a.updatedAt);
		if (before !== JSON.stringify([this.team, this.members, this.notes.map(n => n.id + n.updatedAt)])) {
			this.changed();
		}
	}

	put(item: Item): void {
		const current = this.items.get(item.id);
		if (current && current.seq > item.seq) {
			return;
		}
		if (item.deleted) {
			this.items.delete(item.id);
		} else {
			this.items.set(item.id, item);
		}
		this.itemListeners.forEach(listener => listener(item));
	}

	async create(kind: ItemKind, change: ItemChange & { title: string }): Promise<Item> {
		const item = await this.api.createItem(kind, change);
		this.put(item);
		this.changed();
		return item;
	}

	/**
	 * Applies a change right away and sends it to the server. Edits that
	 * replace whole texts or lists pass `baseVersion`, so a teammate's
	 * newer edit is never silently overwritten.
	 */
	async update(item: Item, change: ItemChange, options?: { checkVersion?: boolean }): Promise<Item | undefined> {
		const before = this.items.get(item.id) ?? item;
		this.items.set(item.id, { ...before, ...change });
		this.changed();
		try {
			const updated = await this.api.updateItem(item.id, change, options?.checkVersion ? before.version : undefined);
			this.put(updated);
			this.changed();
			return updated;
		} catch (err) {
			this.items.set(item.id, before);
			this.changed();
			if (err instanceof ApiError && err.status === 409) {
				const { item: latest } = await this.api.item(item.id);
				this.put(latest);
				this.changed();
				throw new ApiError(409, t('{0} changed {1} while you were editing. Their version is shown now.', this.member(latest.updatedBy)?.name ?? t('Someone'), this.key(latest)));
			}
			throw err;
		}
	}

	async remove(item: Item): Promise<void> {
		await this.api.deleteItem(item.id);
		this.put({ ...item, deleted: true });
		if (this.selected === item.id) {
			this.selected = null;
		}
		this.changed();
	}

	/** Refetches one item, for example after logging time on it. */
	async reload(itemId: string): Promise<void> {
		const { item } = await this.api.item(itemId);
		this.put(item);
		this.changed();
	}
}
