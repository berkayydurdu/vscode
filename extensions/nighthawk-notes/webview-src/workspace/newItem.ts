/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ItemChange, ItemKind, Priority } from './api';
import { select } from './card';
import { autosize, kindIcon, labelChip, modal, priorityIcon, statusIcon, toast } from './components';
import { RFC_TEMPLATE } from './detail';
import { t } from './l10n';
import { kindLabel, priorityLabel, statusLabel, type Model } from './model';
import { pickDate, pickEstimate, pickLabels, pickPeople, pickPriority, pickStatus } from './pickers';
import { avatarStack, fill, formatMinutes, h, icon, shortDate, type Child } from './util';

/**
 * The "New ticket" dialog: pick the kind, type a title, and set any
 * property from the chips below, like Linear's composer.
 */
export function newItemDialog(model: Model, kind: ItemKind, preset: ItemChange = {}): void {
	const state: Required<Pick<ItemChange, 'priority' | 'assignees' | 'reviewers' | 'labels'>> & ItemChange = {
		priority: 'none' as Priority,
		assignees: [],
		reviewers: [],
		labels: [],
		...preset,
	};
	let currentKind = kind;
	let createMore = false;

	const title = h('input', { class: 'new-title', placeholder: t('Title'), spellcheck: true });
	const body = autosize(h('textarea', { class: 'new-body', rows: 3, placeholder: t('Add a description... (Markdown)') }));
	const kinds = h('div', { class: 'segmented' });
	const chips = h('div', { class: 'chips' });
	const error = h('div', { class: 'form-error' });
	const createButton = h('button', { class: 'button primary', type: 'submit' });

	const renderKinds = () => kinds.replaceChildren(...(['task', 'bug', 'rfc'] as ItemKind[]).map(k => h('button', {
		type: 'button',
		class: { segment: true, active: k === currentKind },
		onclick: () => {
			if (k === currentKind) {
				return;
			}
			const wasRfc = currentKind === 'rfc';
			currentKind = k;
			if (k === 'rfc' && !body.value.trim()) {
				body.value = RFC_TEMPLATE;
				body.dispatchEvent(new Event('input'));
			} else if (wasRfc && body.value === RFC_TEMPLATE) {
				body.value = '';
				body.dispatchEvent(new Event('input'));
			}
			if (wasRfc !== (k === 'rfc')) {
				state.status = undefined;
			}
			renderKinds();
			renderChips();
			title.focus();
		},
	}, kindIcon(k), kindLabel(k))));

	const chip = (content: Child[], onClick: (anchor: HTMLElement) => void, active: boolean) =>
		h('button', { type: 'button', class: { 'chip-button': true, set: active }, onclick: (e: Event) => onClick(e.currentTarget as HTMLElement) }, content);

	const renderChips = () => {
		const isRfc = currentKind === 'rfc';
		const status = state.status ?? (isRfc ? 'draft' : 'todo');
		const people = isRfc ? state.reviewers : state.assignees;
		fill(chips,
			chip([statusIcon(currentKind, status), statusLabel(currentKind, status)], a => pickStatus(a, currentKind, status, s => { state.status = s; renderChips(); }), true),
			chip([priorityIcon(state.priority), priorityLabel(state.priority)], a => pickPriority(a, state.priority, p => { state.priority = p; renderChips(); }), state.priority !== 'none'),
			chip(people.length ? [avatarStack(model.people(people)), isRfc ? t('Reviewers') : model.people(people).map(p => p.name.split(' ')[0]).join(', ')] : [icon('user', 12), isRfc ? t('Reviewers') : t('Assignee')],
				a => pickPeople(a, model, people, ids => { state[isRfc ? 'reviewers' : 'assignees'] = ids; renderChips(); }, isRfc ? t('Ask for review...') : undefined), people.length > 0),
			isRfc ? null : chip([icon('calendar', 12), state.dueDate ? shortDate(state.dueDate) : t('Due date')], a => pickDate(a, state.dueDate ?? null, d => { state.dueDate = d; renderChips(); }), !!state.dueDate),
			isRfc ? null : chip([icon('clock', 12), state.estimateMinutes ? formatMinutes(state.estimateMinutes) : t('Estimate')], a => pickEstimate(a, state.estimateMinutes ?? null, m => { state.estimateMinutes = m; renderChips(); }), !!state.estimateMinutes),
			chip(state.labels.length ? state.labels.map(l => labelChip(l)) : [icon('tag', 12), t('Labels')], a => pickLabels(a, model, state.labels, labels => { state.labels = labels; renderChips(); }), state.labels.length > 0),
		);
		createButton.replaceChildren(isRfc ? t('Create RFC') : currentKind === 'bug' ? t('Report Bug') : t('Create Ticket'));
	};

	const submit = async () => {
		const text = title.value.trim();
		if (!text) {
			error.textContent = t('Give it a title first.');
			title.focus();
			return;
		}
		createButton.disabled = true;
		try {
			const isRfc = currentKind === 'rfc';
			const item = await model.create(currentKind, {
				title: text,
				body: body.value,
				priority: state.priority,
				labels: state.labels,
				...(state.status ? { status: state.status } : {}),
				...(isRfc ? { reviewers: state.reviewers } : { assignees: state.assignees, dueDate: state.dueDate ?? null, estimateMinutes: state.estimateMinutes ?? null }),
			});
			toast(t('Created {0}', model.key(item)), 'info', { label: t('Open'), run: () => select(model, item.id) });
			if (createMore) {
				title.value = '';
				body.value = currentKind === 'rfc' ? RFC_TEMPLATE : '';
				error.textContent = '';
				title.focus();
			} else {
				dialog.close();
				if (isRfc) {
					select(model, item.id);
				}
			}
		} catch (err) {
			error.textContent = err instanceof Error ? err.message : String(err);
		} finally {
			createButton.disabled = false;
		}
	};

	if (kind === 'rfc') {
		body.value = RFC_TEMPLATE;
	}
	renderKinds();
	renderChips();
	const form = h('form', {
		class: 'new-item',
		onsubmit: (e: Event) => { e.preventDefault(); submit(); },
		onkeydown: (e: KeyboardEvent) => {
			if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
				e.preventDefault();
				submit();
			} else if (e.key === 'Enter' && e.target === title) {
				e.preventDefault();
				body.focus();
			}
		},
	},
		h('div', { class: 'new-item-head' },
			h('span', { class: 'team-badge small' }, model.prefix),
			kinds,
			h('span', { class: 'spacer' }),
			h('button', { type: 'button', class: 'icon-button', title: t('Close'), onclick: () => dialog.close() }, icon('close', 14)),
		),
		title,
		body,
		chips,
		error,
		h('div', { class: 'modal-actions' },
			h('label', { class: 'toggle' },
				h('input', { type: 'checkbox', onchange: (e: Event) => createMore = (e.target as HTMLInputElement).checked }),
				t('Create more'),
			),
			h('span', { class: 'spacer' }),
			h('span', { class: 'muted small' }, t('Ctrl+Enter')),
			createButton,
		),
	);
	const dialog = modal(form, 'modal-wide');
	title.focus();
}
