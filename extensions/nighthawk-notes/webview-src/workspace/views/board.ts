/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { Item, ItemChange, Priority } from '../api';
import { card } from '../card';
import { priorityIcon, reportError, statusIcon } from '../components';
import { t } from '../l10n';
import { PRIORITIES, priorityLabel, TICKET_STATUSES, statusLabel, type BoardGrouping, type Model } from '../model';
import { avatar, h, icon } from '../util';

interface Column {
	id: string;
	title: string;
	icon: Node;
	items: Item[];
	/** What dropping a card here, or adding one, sets. */
	change: ItemChange;
}

const PRIORITY_ORDER: Record<Priority, number> = { urgent: 0, high: 1, medium: 2, low: 3, none: 4 };

export function byPriority(a: Item, b: Item): number {
	return PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] || b.number - a.number;
}

function columns(model: Model, grouping: BoardGrouping): Column[] {
	const tickets = model.filtered(item => item.kind !== 'rfc').sort(byPriority);
	switch (grouping) {
		case 'assignee': {
			const members = [...model.members].sort((a, b) => a.userId === model.me.id ? -1 : b.userId === model.me.id ? 1 : a.name.localeCompare(b.name));
			return [
				{ id: 'none', title: t('Unassigned'), icon: avatar(undefined), items: tickets.filter(i => !i.assignees.length), change: { assignees: [] } },
				...members.map(member => ({
					id: member.userId,
					title: member.userId === model.me.id ? t('{0} (you)', member.name) : member.name,
					icon: avatar(member),
					items: tickets.filter(i => i.assignees.includes(member.userId)),
					change: { assignees: [member.userId] },
				})),
			];
		}
		case 'priority':
			return PRIORITIES.map(priority => ({
				id: priority,
				title: priorityLabel(priority),
				icon: priorityIcon(priority),
				items: tickets.filter(i => i.priority === priority),
				change: { priority },
			}));
		default:
			return TICKET_STATUSES.map(status => ({
				id: status,
				title: statusLabel('task', status),
				icon: statusIcon('task', status),
				items: tickets.filter(i => i.status === status),
				change: { status },
			}));
	}
}

/**
 * The Kanban board: one column per status (or person, or priority).
 * Cards are dragged between columns to change them.
 */
export function renderBoard(model: Model, grouping: BoardGrouping, onNew: (change: ItemChange) => void): HTMLElement {
	const board = h('div', { class: 'board' });
	for (const column of columns(model, grouping)) {
		board.appendChild(renderColumn(model, column, grouping, onNew));
	}
	return board;
}

function renderColumn(model: Model, column: Column, grouping: BoardGrouping, onNew: (change: ItemChange) => void): HTMLElement {
	const minutes = column.items.reduce((sum, item) => sum + (item.estimateMinutes ?? 0), 0);
	const list = h('div', { class: 'column-cards' }, column.items.map(item => card(model, item, { showStatus: grouping !== 'status' })));
	const el = h('section', { class: `column column-${column.id}`, 'data-column': column.id },
		h('header', { class: 'column-header' },
			h('span', { class: 'column-icon' }, column.icon),
			h('span', { class: 'column-title' }, column.title),
			h('span', { class: 'column-count' }, String(column.items.length)),
			minutes ? h('span', { class: 'column-estimate', title: t('Estimated work') }, `${Math.round(minutes / 6) / 10}h`) : null,
			h('span', { class: 'spacer' }),
			model.canEdit ? h('button', { class: 'icon-button', title: t('New Ticket'), onclick: () => onNew(column.change) }, icon('plus', 14)) : null,
		),
		list,
		model.canEdit ? quickAdd(model, column) : null,
	);
	if (!column.items.length && !model.canEdit) {
		list.appendChild(h('div', { class: 'column-empty' }, t('Nothing here')));
	}

	// Drag and drop: cards carry their id; the column under the pointer lights up.
	el.addEventListener('dragover', e => {
		if (e.dataTransfer?.types.includes('application/x-nighthawk-item')) {
			e.preventDefault();
			e.dataTransfer.dropEffect = 'move';
			el.classList.add('drop-target');
		}
	});
	el.addEventListener('dragleave', e => {
		if (!el.contains(e.relatedTarget as Node)) {
			el.classList.remove('drop-target');
		}
	});
	el.addEventListener('drop', e => {
		e.preventDefault();
		el.classList.remove('drop-target');
		const item = model.items.get(e.dataTransfer?.getData('application/x-nighthawk-item') ?? '');
		if (item && !column.items.includes(item)) {
			model.update(item, column.change).catch(reportError);
		}
	});
	list.addEventListener('dragstart', e => {
		const target = (e.target as HTMLElement).closest<HTMLElement>('.card');
		if (target && e.dataTransfer) {
			e.dataTransfer.setData('application/x-nighthawk-item', target.dataset.id!);
			e.dataTransfer.effectAllowed = 'move';
			requestAnimationFrame(() => target.classList.add('dragging'));
		}
	});
	list.addEventListener('dragend', e => (e.target as HTMLElement).classList?.remove('dragging'));
	return el;
}

/** "+ New" at the bottom of a column: type a title and press Enter. */
function quickAdd(model: Model, column: Column): HTMLElement {
	const wrapper = h('div', { class: 'quick-add' });
	const showButton = () => wrapper.replaceChildren(h('button', { class: 'quick-add-button', onclick: showInput }, icon('plus', 12), t('New')));
	const showInput = () => {
		const input = h('textarea', { class: 'quick-add-input', rows: 2, placeholder: t('Title, then Enter') });
		input.addEventListener('keydown', async e => {
			if (e.key === 'Enter' && !e.shiftKey) {
				e.preventDefault();
				const title = input.value.trim();
				if (!title) {
					return;
				}
				input.disabled = true;
				try {
					await model.create('task', { title, ...column.change });
					// The board re-renders with the new card; keep adding.
					requestAnimationFrame(() => (document.querySelector(`[data-column="${column.id}"] .quick-add-button`) as HTMLElement | null)?.click());
				} catch (err) {
					input.disabled = false;
					reportError(err);
				}
			} else if (e.key === 'Escape') {
				e.stopPropagation();
				showButton();
			}
		});
		input.addEventListener('blur', () => !input.value.trim() && !input.disabled && showButton());
		wrapper.replaceChildren(h('div', { class: 'card quick-add-card' }, input));
		input.focus();
	};
	showButton();
	return wrapper;
}
