/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { Item } from '../api';
import { select } from '../card';
import { statusIcon } from '../components';
import { t } from '../l10n';
import { statusLabel, type Model } from '../model';
import { avatar, avatarStack, excerpt, h, icon, timeAgo } from '../util';

type RfcTab = 'open' | 'accepted' | 'closed' | 'all';

let tab: RfcTab = 'open';

const TABS: { id: RfcTab; label: () => string; statuses: string[] | null }[] = [
	{ id: 'open', label: () => t('Open'), statuses: ['draft', 'in_review'] },
	{ id: 'accepted', label: () => t('Accepted'), statuses: ['accepted'] },
	{ id: 'closed', label: () => t('Rejected and Withdrawn'), statuses: ['rejected', 'withdrawn'] },
	{ id: 'all', label: () => t('All'), statuses: null },
];

/**
 * Requests for Comments: design documents the team reviews and decides on,
 * shown as a gallery of document cards.
 */
export function renderRfcs(model: Model, onNew: () => void): HTMLElement {
	const all = model.filtered(item => item.kind === 'rfc');
	const current = TABS.find(x => x.id === tab)!;
	const shown = all.filter(item => !current.statuses || current.statuses.includes(item.status)).sort((a, b) => b.updatedAt - a.updatedAt);
	return h('div', { class: 'rfcs' },
		h('div', { class: 'rfc-intro' },
			h('div', null,
				h('h1', null, t('Requests for Comments')),
				h('p', { class: 'muted' }, t('Propose a design, ask for reviews, and record the decision.')),
			),
			model.canEdit ? h('button', { class: 'button primary', onclick: onNew }, icon('plus', 14), t('New RFC')) : null,
		),
		h('div', { class: 'tabs', role: 'tablist' }, TABS.map(x => h('button', {
			class: { tab: true, active: x.id === tab },
			role: 'tab',
			onclick: () => { tab = x.id; model.changed(); },
		}, x.label(), h('span', { class: 'tab-count' }, String(all.filter(item => !x.statuses || x.statuses.includes(item.status)).length))))),
		shown.length
			? h('div', { class: 'rfc-grid' }, shown.map(item => rfcCard(model, item)))
			: h('div', { class: 'empty-state' },
				icon('rfc', 32),
				h('div', { class: 'empty-title' }, all.length ? t('Nothing in this list') : t('No RFCs yet')),
				h('div', { class: 'empty-text' }, t('An RFC describes a change before it is built, so the team can weigh in.')),
				model.canEdit && !all.length ? h('button', { class: 'button primary', onclick: onNew }, icon('plus', 14), t('Write the First RFC')) : null,
			),
	);
}

function rfcCard(model: Model, item: Item): HTMLElement {
	const author = model.member(item.createdBy);
	return h('article', {
		class: { 'rfc-card': true, selected: model.selected === item.id },
		tabindex: 0,
		onclick: () => select(model, item.id),
		onkeydown: (e: KeyboardEvent) => e.key === 'Enter' && select(model, item.id),
	},
		h('div', { class: 'rfc-card-top' },
			h('span', { class: `status-pill status-rfc-${item.status}` }, statusIcon('rfc', item.status, 12), statusLabel('rfc', item.status)),
			h('span', { class: 'row-key' }, model.key(item)),
		),
		h('h3', { class: 'rfc-card-title' }, item.title),
		h('p', { class: 'rfc-card-excerpt' }, excerpt(item.body, 220) || t('No summary yet.')),
		h('div', { class: 'rfc-card-foot' },
			avatar(author),
			h('span', { class: 'small' }, author?.name ?? ''),
			h('span', { class: 'muted small' }, `· ${timeAgo(item.updatedAt)}`),
			h('span', { class: 'spacer' }),
			item.commentCount ? h('span', { class: 'meta-chip' }, icon('comment', 12), String(item.commentCount)) : null,
			item.reviewers.length ? h('span', { class: 'reviewers', title: t('Reviewers') }, avatarStack(model.people(item.reviewers), 4)) : null,
		),
	);
}
