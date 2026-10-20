/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ApiError, vscode, type ItemChange, type ItemKind, type User } from './api';
import { closeMenus, kindIcon, labelChip, preservingFocus, priorityIcon, reportError, showMenu } from './components';
import { DetailPanel } from './detail';
import { setBundle, t } from './l10n';
import { isClosed, kindLabel, Model, PRIORITIES, priorityLabel, type ViewId } from './model';
import { newItemDialog } from './newItem';
import { avatar, fill, h, icon, timeAgo } from './util';
import { renderBoard } from './views/board';
import { renderHome } from './views/home';
import { renderRfcs } from './views/rfcs';
import { renderTickets } from './views/tickets';
import { Timesheet } from './views/timesheet';

interface InitMessage {
	type: 'init';
	teamId: string;
	teamName: string;
	me: User;
	l10n?: Record<string, string>;
}

const SYNC_INTERVAL = 10_000;

const VIEWS: { id: ViewId; icon: string; label: () => string; key: string }[] = [
	{ id: 'home', icon: 'user', label: () => t('My Work'), key: '1' },
	{ id: 'board', icon: 'board', label: () => t('Board'), key: '2' },
	{ id: 'tickets', icon: 'list', label: () => t('Tickets'), key: '3' },
	{ id: 'timesheet', icon: 'clock', label: () => t('Timesheet'), key: '4' },
	{ id: 'rfcs', icon: 'rfc', label: () => t('RFCs'), key: '5' },
];

/**
 * The team workspace: a sidebar with the team's views, pages and people,
 * the current view, and the item panel on the right.
 */
class Workspace {

	private readonly sidebar = h('nav', { class: 'sidebar' });
	private readonly topbar = h('header', { class: 'topbar' });
	private readonly view = h('div', { class: 'view' });
	private readonly detail: DetailPanel;
	private readonly timesheet: Timesheet;
	private readonly search = h('input', { class: 'search-input', type: 'search', placeholder: t('Search or jump to NC-12...'), spellcheck: false });
	private lastSync = 0;
	private pendingNumber: number | undefined;
	private offline = false;
	private renderPending = false;

	constructor(private readonly model: Model) {
		this.detail = new DetailPanel(model);
		this.timesheet = new Timesheet(model);
		document.body.replaceChildren(h('div', { class: 'app' },
			this.sidebar,
			h('main', { class: 'main' }, this.topbar, this.view),
			this.detail.el,
		));
		this.search.value = model.filters.text;
		this.search.addEventListener('input', () => {
			model.filters.text = this.search.value;
			if (model.view === 'home' && this.search.value) {
				model.view = 'tickets';
			}
			model.changed();
		});
		this.search.addEventListener('keydown', e => {
			if (e.key === 'Enter') {
				// Jump straight to an item by its key.
				const match = /^(?:[a-z]+-)?(\d+)$/i.exec(this.search.value.trim());
				const item = match && model.all().find(i => i.number === Number(match[1]));
				if (item) {
					model.selected = item.id;
					model.changed();
				}
			} else if (e.key === 'Escape' && this.search.value) {
				e.stopPropagation();
				this.search.value = '';
				model.filters.text = '';
				model.changed();
			}
		});
		model.onChange(() => {
			if (this.pendingNumber !== undefined && model.all().some(i => i.number === this.pendingNumber)) {
				this.openNumber(this.pendingNumber);
				return;
			}
			this.render();
		});
		document.addEventListener('keydown', e => this.onKey(e));
		document.addEventListener('focusout', () => setTimeout(() => this.renderPending && this.render()));
		document.addEventListener('click', e => {
			const link = (e.target as HTMLElement).closest<HTMLAnchorElement>('a.wikilink');
			if (link) {
				e.preventDefault();
				vscode.postMessage({ type: 'openNoteByName', name: link.dataset.note });
			}
		});
		this.render();
	}

	/** Opens the item with this number, waiting for the items to load when needed. */
	openNumber(number: number): void {
		const item = this.model.all().find(i => i.number === number);
		if (item) {
			this.pendingNumber = undefined;
			this.model.selected = item.id;
			this.model.changed();
		} else {
			this.pendingNumber = number;
		}
	}

	start(): void {
		const sync = async () => {
			try {
				await this.model.sync();
				if (Date.now() - this.lastSync > 60_000) {
					await this.model.refreshTeam();
					this.timesheet.invalidate();
				}
				this.lastSync = Date.now();
				this.setOffline(false);
			} catch (err) {
				this.setOffline(true);
				if (err instanceof ApiError && err.status === 403) {
					reportError(err);
				}
			}
		};
		setInterval(() => document.visibilityState === 'visible' && sync(), SYNC_INTERVAL);
		window.addEventListener('focus', () => sync());
		this.model.load().then(() => {
			this.lastSync = Date.now();
		}, err => {
			this.setOffline(true);
			this.view.replaceChildren(h('div', { class: 'empty-state' },
				icon('sync', 32),
				h('div', { class: 'empty-title' }, t('Could not load the team')),
				h('div', { class: 'empty-text' }, err instanceof Error ? err.message : String(err)),
				h('button', { class: 'button primary', onclick: () => location.reload() }, t('Try Again')),
			));
		});
	}

	private setOffline(offline: boolean): void {
		if (this.offline !== offline) {
			this.offline = offline;
			this.render();
		}
	}

	/** Postpones redraws while someone types in a field that has no saved draft. */
	private isTyping(): boolean {
		const active = document.activeElement as HTMLElement | null;
		return !!active && this.view.contains(active) && /^(INPUT|TEXTAREA)$/.test(active.tagName) && !active.dataset.key;
	}

	render(): void {
		if (this.isTyping()) {
			this.renderPending = true;
			return;
		}
		this.renderPending = false;
		this.renderSidebar();
		this.renderTopbar();
		preservingFocus(() => this.renderView());
		this.detail.update();
	}

	private go(view: ViewId): void {
		this.model.view = view;
		this.model.changed();
		this.view.scrollTop = 0;
	}

	private newItem(kind?: ItemKind, preset?: ItemChange): void {
		if (!this.model.canEdit) {
			return;
		}
		newItemDialog(this.model, kind ?? (this.model.view === 'rfcs' ? 'rfc' : 'task'), preset);
	}

	private renderSidebar(): void {
		const { model } = this;
		const open = model.all().filter(item => !isClosed(item));
		const counts: Partial<Record<ViewId, number>> = {
			home: open.filter(item => item.assignees.includes(model.me.id) || (item.kind === 'rfc' && item.status === 'in_review' && item.reviewers.includes(model.me.id))).length,
			board: open.filter(item => item.kind !== 'rfc').length,
			rfcs: open.filter(item => item.kind === 'rfc').length,
		};
		fill(this.sidebar,
			h('div', { class: 'team-header' },
				h('span', { class: 'team-badge' }, model.prefix),
				h('div', { class: 'team-name' },
					h('strong', null, model.team.name),
					h('span', { class: 'muted small' }, roleLabel(model.team.role)),
				),
			),
			model.canEdit ? h('button', { class: 'new-button', onclick: () => this.newItem() }, icon('plus', 14), t('New'), h('kbd', null, 'N')) : null,
			h('div', { class: 'nav' }, VIEWS.map(view => h('button', {
				class: { 'nav-item': true, active: model.view === view.id },
				title: `${view.label()} (${view.key})`,
				onclick: () => this.go(view.id),
			}, icon(view.icon, 15), h('span', { class: 'nav-label' }, view.label()), counts[view.id] ? h('span', { class: 'nav-count' }, String(counts[view.id])) : null))),
			h('div', { class: 'nav-section' },
				h('div', { class: 'nav-heading' }, h('span', null, t('Pages')), h('button', { class: 'icon-button', title: t('New Team Note'), onclick: () => vscode.postMessage({ type: 'command', command: 'newNote' }) }, icon('plus', 12))),
				model.notes.slice(0, 8).map(note => h('button', {
					class: 'nav-item page',
					title: t('{0}, edited by {1} {2}', note.path, note.updatedByName, timeAgo(note.updatedAt)),
					onclick: () => vscode.postMessage({ type: 'openNote', path: note.path }),
				}, icon('doc', 14), h('span', { class: 'nav-label' }, note.path.replace(/\.md$/i, '').split('/').pop()))),
				model.notes.length ? null : h('div', { class: 'nav-empty muted small' }, t('Shared notes show up here.')),
				model.notes.length > 8 ? h('button', { class: 'nav-item muted', onclick: () => vscode.postMessage({ type: 'command', command: 'showNotes' }) }, h('span', { class: 'nav-label' }, t('All {0} pages', model.notes.length))) : null,
			),
			h('div', { class: 'nav-section' },
				h('div', { class: 'nav-heading' }, h('span', null, t('Members')), model.isAdmin ? h('button', { class: 'icon-button', title: t('Invite Members...'), onclick: () => vscode.postMessage({ type: 'command', command: 'invite' }) }, icon('plus', 12)) : null),
				h('div', { class: 'members' }, model.members.map(member => {
					const load = model.all().filter(item => !isClosed(item) && item.assignees.includes(member.userId)).length;
					return h('button', {
						class: { 'member': true, active: model.filters.assignee === member.userId },
						title: t('{0} · {1} open', member.name, load),
						onclick: () => {
							model.filters.assignee = model.filters.assignee === member.userId ? null : member.userId;
							if (model.view === 'home' || model.view === 'timesheet' || model.view === 'rfcs') {
								model.view = 'board';
							}
							model.changed();
						},
					}, avatar(member), h('span', { class: 'nav-label' }, member.userId === model.me.id ? t('{0} (you)', member.name) : member.name), load ? h('span', { class: 'nav-count' }, String(load)) : null);
				})),
			),
			h('span', { class: 'spacer' }),
			h('div', { class: { 'sync-state': true, offline: this.offline } },
				h('span', { class: 'sync-dot' }),
				this.offline ? t('Offline. Retrying...') : t('Synced with your team'),
			),
		);
	}

	private renderTopbar(): void {
		const { model } = this;
		const view = VIEWS.find(v => v.id === model.view)!;
		const filters = model.view === 'board' || model.view === 'tickets';
		const filterChip = (label: string, value: Node | string | null, onClick: (anchor: HTMLElement) => void, onClear: () => void) =>
			h('span', { class: { 'filter-chip': true, set: !!value } },
				h('button', { class: 'filter-chip-main', onclick: (e: Event) => onClick(e.currentTarget as HTMLElement) }, label, value ? h('span', { class: 'filter-value' }, value) : icon('chevronRight', 10)),
				value ? h('button', { class: 'filter-clear', title: t('Clear'), onclick: () => { onClear(); model.changed(); } }, icon('close', 10)) : null,
			);
		const assignee = model.filters.assignee;
		fill(this.topbar,
			h('div', { class: 'topbar-row' },
				h('h1', { class: 'view-title' }, icon(view.icon, 18), view.label()),
				model.view === 'board' ? h('div', { class: 'segmented small' }, (['status', 'assignee', 'priority'] as const).map(g => h('button', {
					class: { segment: true, active: model.boardGrouping === g },
					onclick: () => { model.boardGrouping = g; model.changed(); },
				}, g === 'status' ? t('By Status') : g === 'assignee' ? t('By Person') : t('By Priority')))) : null,
				h('span', { class: 'spacer' }),
				h('label', { class: 'search' }, icon('search', 14), this.search, h('kbd', null, '/')),
				model.canEdit ? h('button', { class: 'button primary', onclick: () => this.newItem() }, icon('plus', 14), model.view === 'rfcs' ? t('New RFC') : t('New Ticket')) : null,
			),
			filters ? h('div', { class: 'filter-row' },
				h('button', {
					class: { 'filter-toggle': true, active: assignee === model.me.id },
					onclick: () => { model.filters.assignee = assignee === model.me.id ? null : model.me.id; model.changed(); },
				}, icon('user', 12), t('Mine')),
				filterChip(t('Assignee'), assignee && assignee !== model.me.id ? (assignee === 'none' ? t('Unassigned') : model.member(assignee)?.name ?? '') : null,
					a => showMenu(a, [{ id: 'none', label: t('Unassigned'), icon: avatar(undefined) }, ...model.members.map(m => ({ id: m.userId, label: m.name, icon: avatar(m), checked: assignee === m.userId }))], id => { model.filters.assignee = id; model.changed(); }),
					() => model.filters.assignee = null),
				filterChip(t('Priority'), model.filters.priority ? priorityLabel(model.filters.priority) : null,
					a => showMenu(a, PRIORITIES.map(p => ({ id: p, label: priorityLabel(p), icon: priorityIcon(p), checked: model.filters.priority === p })), id => { model.filters.priority = id as typeof PRIORITIES[number]; model.changed(); }, { search: false }),
					() => model.filters.priority = null),
				filterChip(t('Type'), model.filters.kind ? kindLabel(model.filters.kind) : null,
					a => showMenu(a, (['task', 'bug'] as const).map(k => ({ id: k, label: kindLabel(k), icon: kindIcon(k), checked: model.filters.kind === k })), id => { model.filters.kind = id as ItemKind; model.changed(); }, { search: false }),
					() => model.filters.kind = null),
				filterChip(t('Label'), model.filters.label ? labelChip(model.filters.label) : null,
					a => showMenu(a, model.labels().map(l => ({ id: l, label: l, checked: model.filters.label === l })), id => { model.filters.label = id; model.changed(); }, { placeholder: t('Find a label...') }),
					() => model.filters.label = null),
				model.hasFilters() ? h('button', { class: 'button ghost small', onclick: () => { this.search.value = ''; model.clearFilters(); } }, t('Clear All')) : null,
			) : null,
		);
	}

	private renderView(): void {
		const { model } = this;
		if (!model.loaded) {
			this.view.replaceChildren(h('div', { class: 'loading' }, h('div', { class: 'skeleton' }), h('div', { class: 'skeleton' }), h('div', { class: 'skeleton short' })));
			return;
		}
		const onNew = (preset: ItemChange) => this.newItem('task', preset);
		let content: HTMLElement;
		switch (model.view) {
			case 'board': content = renderBoard(model, model.boardGrouping, onNew); break;
			case 'tickets': content = renderTickets(model, onNew); break;
			case 'timesheet': content = this.timesheet.render(); break;
			case 'rfcs': content = renderRfcs(model, () => this.newItem('rfc')); break;
			default: content = renderHome(model, view => this.go(view)); break;
		}
		this.view.className = `view view-${model.view}`;
		const scroll = [this.view.scrollTop, this.view.querySelector('.board')?.scrollLeft ?? 0];
		this.view.replaceChildren(content);
		this.view.scrollTop = scroll[0];
		const board = this.view.querySelector('.board');
		if (board) {
			board.scrollLeft = scroll[1];
		}
	}

	private onKey(e: KeyboardEvent): void {
		const target = e.target as HTMLElement;
		const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.isContentEditable;
		if (e.key === 'Escape') {
			if (closeMenus() || document.querySelector('.modal-backdrop')) {
				return;
			}
			if (this.detail.close()) {
				e.preventDefault();
			}
			return;
		}
		if (typing || e.ctrlKey || e.metaKey || e.altKey || document.querySelector('.modal-backdrop, .popover')) {
			return;
		}
		if (e.key === '/') {
			e.preventDefault();
			this.search.focus();
		} else if (e.key === 'n' || e.key === 'c') {
			e.preventDefault();
			this.newItem();
		} else {
			const view = VIEWS.find(v => v.key === e.key);
			if (view) {
				this.go(view.id);
			}
		}
	}
}

function roleLabel(role: string): string {
	switch (role) {
		case 'owner': return t('Owner');
		case 'admin': return t('Admin');
		case 'editor': return t('Editor');
		default: return t('Viewer');
	}
}

let workspace: Workspace | undefined;
let openOnStart: number | undefined;

window.addEventListener('message', event => {
	// Only the extension's messages, which the webview host relays from this page's own origin.
	if (event.origin !== window.origin) {
		return;
	}
	const message = event.data;
	if (message?.type === 'init') {
		const init = message as InitMessage;
		setBundle(init.l10n);
		const model = new Model(init.teamId, init.me, init.teamName);
		workspace = new Workspace(model);
		workspace.start();
		if (openOnStart !== undefined) {
			workspace.openNumber(openOnStart);
		}
	} else if (message?.type === 'openItem' && typeof message.number === 'number') {
		if (workspace) {
			workspace.openNumber(message.number);
		} else {
			openOnStart = message.number;
		}
	}
});

vscode.postMessage({ type: 'ready' });
