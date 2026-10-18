/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { Item, ItemChange } from '../api';
import { dueChip, select, timeChip } from '../card';
import { kindIcon, labelChip, priorityIcon, reportError, statusIcon } from '../components';
import { t } from '../l10n';
import { priorityLabel, TICKET_STATUSES, statusLabel, type Model } from '../model';
import { pickPeople, pickPriority, pickStatus } from '../pickers';
import { avatar, avatarStack, h, icon } from '../util';
import { byPriority } from './board';

const collapsed = new Set<string>(['done']);

/** All tickets as a dense list, grouped by status like Linear. */
export function renderTickets(model: Model, onNew: (change: ItemChange) => void): HTMLElement {
	const tickets = model.filtered(item => item.kind !== 'rfc').sort(byPriority);
	const el = h('div', { class: 'ticket-list' });
	for (const status of TICKET_STATUSES) {
		const group = tickets.filter(item => item.status === status);
		if (!group.length && model.hasFilters()) {
			continue;
		}
		const isCollapsed = collapsed.has(status);
		el.appendChild(h('div', { class: 'list-group-header', onclick: () => { if (!collapsed.delete(status)) { collapsed.add(status); } model.changed(); } },
			h('span', { class: { chevron: true, collapsed: isCollapsed } }, icon('chevronRight', 12)),
			statusIcon('task', status),
			h('span', { class: 'list-group-title' }, statusLabel('task', status)),
			h('span', { class: 'column-count' }, String(group.length)),
			h('span', { class: 'spacer' }),
			model.canEdit ? h('button', { class: 'icon-button', title: t('New Ticket'), onclick: (e: Event) => { e.stopPropagation(); onNew({ status }); } }, icon('plus', 14)) : null,
		));
		if (!isCollapsed) {
			el.append(...group.map(item => row(model, item)));
		}
	}
	if (!tickets.length) {
		el.appendChild(emptyState(model, onNew));
	}
	return el;
}

export function row(model: Model, item: Item): HTMLElement {
	const update = (change: ItemChange) => model.update(item, change).catch(reportError);
	const stop = (handler: (anchor: HTMLElement) => void) => (e: Event) => {
		e.stopPropagation();
		if (model.canEdit) {
			handler(e.currentTarget as HTMLElement);
		}
	};
	const people = model.people(item.assignees);
	return h('div', {
		class: { 'list-row': true, selected: model.selected === item.id },
		tabindex: 0,
		onclick: () => select(model, item.id),
		onkeydown: (e: KeyboardEvent) => e.key === 'Enter' && select(model, item.id),
	},
		h('button', { class: 'icon-button', title: priorityLabel(item.priority), onclick: stop(anchor => pickPriority(anchor, item.priority, priority => update({ priority }))) }, priorityIcon(item.priority)),
		h('span', { class: 'row-key' }, model.key(item)),
		h('button', { class: 'icon-button', title: statusLabel(item.kind, item.status), onclick: stop(anchor => pickStatus(anchor, item.kind, item.status, status => update({ status }))) }, statusIcon(item.kind, item.status)),
		item.kind === 'bug' ? kindIcon('bug', 13) : null,
		h('span', { class: 'row-title' }, item.title),
		h('span', { class: 'row-labels' }, item.labels.slice(0, 3).map(label => labelChip(label))),
		h('span', { class: 'spacer' }),
		item.checklist.length ? h('span', { class: 'meta-chip' }, icon('task', 12), `${item.checklist.filter(c => c.done).length}/${item.checklist.length}`) : null,
		timeChip(item),
		dueChip(item),
		h('button', { class: 'card-people', title: people.map(p => p.name).join(', ') || t('Assign'), onclick: stop(anchor => pickPeople(anchor, model, item.assignees, assignees => update({ assignees }))) },
			people.length ? avatarStack(people) : avatar(undefined)),
	);
}

function emptyState(model: Model, onNew: (change: ItemChange) => void): HTMLElement {
	if (model.hasFilters()) {
		return h('div', { class: 'empty-state' },
			h('div', { class: 'empty-title' }, t('No tickets match these filters')),
			h('button', { class: 'button ghost', onclick: () => model.clearFilters() }, t('Clear Filters')),
		);
	}
	return h('div', { class: 'empty-state' },
		icon('board', 32),
		h('div', { class: 'empty-title' }, t('No tickets yet')),
		h('div', { class: 'empty-text' }, t('Tickets track work: who does it, by when, and how long it took.')),
		model.canEdit ? h('button', { class: 'button primary', onclick: () => onNew({}) }, icon('plus', 14), t('New Ticket')) : null,
	);
}
