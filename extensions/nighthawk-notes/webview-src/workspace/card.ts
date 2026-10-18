/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { Item } from './api';
import { kindIcon, labelChip, priorityIcon, reportError, statusIcon } from './components';
import { t } from './l10n';
import { isClosed, priorityLabel, statusLabel, type Model } from './model';
import { pickPeople, pickPriority, pickStatus } from './pickers';
import { avatar, avatarStack, formatMinutes, h, icon, isoDate, shortDate } from './util';

/** Due date chip, red when overdue and amber when due within two days. */
export function dueChip(item: Item): HTMLElement | null {
	if (!item.dueDate) {
		return null;
	}
	const today = isoDate(new Date());
	const soon = isoDate(new Date(Date.now() + 2 * 86400_000));
	const state = isClosed(item) ? '' : item.dueDate < today ? 'overdue' : item.dueDate <= soon ? 'soon' : '';
	return h('span', { class: `meta-chip due ${state}`, title: t('Due {0}', item.dueDate) }, icon('calendar', 12), item.dueDate === today ? t('Today') : shortDate(item.dueDate));
}

export function checklistChip(item: Item): HTMLElement | null {
	if (!item.checklist.length) {
		return null;
	}
	const done = item.checklist.filter(c => c.done).length;
	return h('span', { class: { 'meta-chip': true, complete: done === item.checklist.length }, title: t('{0} of {1} to-dos done', done, item.checklist.length) },
		progressRing(done / item.checklist.length), `${done}/${item.checklist.length}`);
}

export function timeChip(item: Item): HTMLElement | null {
	if (!item.loggedMinutes && !item.estimateMinutes) {
		return null;
	}
	if (!item.loggedMinutes) {
		return h('span', { class: 'meta-chip', title: t('Estimate') }, icon('clock', 12), t('{0} est.', formatMinutes(item.estimateMinutes!)));
	}
	const over = !!item.estimateMinutes && item.loggedMinutes > item.estimateMinutes;
	const text = item.estimateMinutes ? `${formatMinutes(item.loggedMinutes)} / ${formatMinutes(item.estimateMinutes)}` : formatMinutes(item.loggedMinutes);
	return h('span', { class: { 'meta-chip': true, over }, title: item.estimateMinutes ? t('Time logged / estimate') : t('Time logged') }, icon('clock', 12), text);
}

function progressRing(fraction: number): SVGElement {
	const wrapper = document.createElement('span');
	const circumference = 2 * Math.PI * 4.5;
	wrapper.innerHTML = `<svg class="progress-ring" width="12" height="12" viewBox="0 0 12 12"><circle cx="6" cy="6" r="4.5" fill="none" stroke="currentColor" stroke-opacity=".25" stroke-width="1.6"/><circle cx="6" cy="6" r="4.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-dasharray="${(fraction * circumference).toFixed(2)} ${circumference.toFixed(2)}" transform="rotate(-90 6 6)" stroke-linecap="round"/></svg>`;
	return wrapper.firstChild as SVGElement;
}

/**
 * A board card. Clicking opens the item; the status, priority and people
 * can be changed right on the card.
 */
export function card(model: Model, item: Item, options: { showStatus?: boolean } = {}): HTMLElement {
	const update = (change: Parameters<Model['update']>[1]) => model.update(item, change).catch(reportError);
	const stop = (handler: (anchor: HTMLElement) => void) => (e: Event) => {
		e.stopPropagation();
		if (model.canEdit) {
			handler(e.currentTarget as HTMLElement);
		}
	};
	const people = model.people(item.assignees);
	const el = h('div', {
		class: { card: true, selected: model.selected === item.id, closed: isClosed(item) },
		tabindex: 0,
		draggable: model.canEdit ? 'true' : undefined,
		'data-id': item.id,
		onclick: () => select(model, item.id),
		onkeydown: (e: KeyboardEvent) => {
			if (e.key === 'Enter') {
				select(model, item.id);
			}
		},
	},
		h('div', { class: 'card-top' },
			options.showStatus ? h('button', { class: 'icon-button status-button', title: statusLabel(item.kind, item.status), onclick: stop(anchor => pickStatus(anchor, item.kind, item.status, status => update({ status }))) }, statusIcon(item.kind, item.status)) : null,
			h('span', { class: 'card-key' }, kindIcon(item.kind, 12), model.key(item)),
			h('button', { class: 'card-people', title: people.length ? people.map(p => p.name).join(', ') : t('Assign'), onclick: stop(anchor => pickPeople(anchor, model, item.assignees, assignees => update({ assignees }))) },
				people.length ? avatarStack(people) : avatar(undefined)),
		),
		h('div', { class: 'card-title' }, item.title),
		item.labels.length ? h('div', { class: 'card-labels' }, item.labels.map(label => labelChip(label))) : null,
		h('div', { class: 'card-meta' },
			h('button', { class: 'icon-button priority-button', title: priorityLabel(item.priority), onclick: stop(anchor => pickPriority(anchor, item.priority, priority => update({ priority }))) }, priorityIcon(item.priority)),
			dueChip(item),
			checklistChip(item),
			timeChip(item),
			item.commentCount ? h('span', { class: 'meta-chip', title: t('{0} comments', item.commentCount) }, icon('comment', 12), String(item.commentCount)) : null,
		),
	);
	return el;
}

export function select(model: Model, itemId: string | null): void {
	model.selected = itemId;
	model.changed();
}
