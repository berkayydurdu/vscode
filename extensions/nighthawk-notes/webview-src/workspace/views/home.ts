/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { Item, Worklog } from '../api';
import { select } from '../card';
import { kindIcon, reportError, statusIcon } from '../components';
import { t } from '../l10n';
import { isClosed, statusLabel, type Model, type ViewId } from '../model';
import { addDays, avatar, avatarStack, formatMinutes, h, isoDate, startOfWeek, timeAgo } from '../util';
import { byPriority } from './board';
import { row } from './tickets';

let weekCache: { key: string; fetchedAt: number; logs: Worklog[] } | undefined;

/** This week's time entries of the signed-in person, fetched in the background. */
function myWeek(model: Model): Worklog[] {
	const from = isoDate(startOfWeek(new Date()));
	const key = `${model.me.id}:${from}`;
	if (!weekCache || weekCache.key !== key || Date.now() - weekCache.fetchedAt > 30_000) {
		const fetchedAt = Date.now();
		weekCache = { key, fetchedAt, logs: weekCache?.key === key ? weekCache.logs : [] };
		model.api.worklogs({ from, to: isoDate(addDays(startOfWeek(new Date()), 6)), userId: model.me.id }).then(logs => {
			weekCache = { key, fetchedAt, logs };
			model.changed();
		}, reportError);
	}
	return weekCache.logs;
}

export function invalidateWeek(): void {
	weekCache = undefined;
}

function greeting(name: string): string {
	const hour = new Date().getHours();
	const first = name.split(/\s+/)[0];
	return hour < 12 ? t('Good morning, {0}', first) : hour < 18 ? t('Good afternoon, {0}', first) : t('Good evening, {0}', first);
}

/**
 * The home page: what is on your plate, your open to-dos, reviews waiting
 * on you, your hours this week, and what the team changed lately.
 */
export function renderHome(model: Model, go: (view: ViewId) => void): HTMLElement {
	const mine = model.all().filter(item => item.kind !== 'rfc' && item.assignees.includes(model.me.id) && !isClosed(item)).sort(byPriority);
	const reviews = model.all().filter(item => item.kind === 'rfc' && item.status === 'in_review' && item.reviewers.includes(model.me.id));
	const today = isoDate(new Date());
	const weekAhead = isoDate(addDays(new Date(), 7));
	const dueSoon = mine.filter(item => item.dueDate && item.dueDate <= weekAhead);
	const overdue = mine.filter(item => item.dueDate && item.dueDate < today);
	const logged = myWeek(model).reduce((sum, log) => sum + log.minutes, 0);
	const target = 40 * 60;

	const stat = (label: string, value: string, detail: string | null, onClick: () => void, extra?: Node) =>
		h('button', { class: 'stat-card', onclick: onClick },
			h('span', { class: 'stat-label' }, label),
			h('span', { class: 'stat-value' }, value),
			extra ?? null,
			detail ? h('span', { class: 'stat-detail' }, detail) : null,
		);

	const todos = mine.flatMap(item => item.checklist.filter(entry => !entry.done).map(entry => ({ item, entry })));

	return h('div', { class: 'home' },
		h('header', { class: 'home-header' },
			h('h1', null, greeting(model.me.name)),
			h('p', { class: 'muted' }, new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })),
		),
		h('div', { class: 'stats' },
			stat(t('Assigned to you'), String(mine.length), overdue.length ? t('{0} overdue', overdue.length) : t('{0} in progress', mine.filter(i => i.status === 'in_progress').length), () => go('tickets')),
			stat(t('Due soon'), String(dueSoon.length), overdue.length ? t('{0} past due', overdue.length) : t('In the next 7 days'), () => go('tickets')),
			stat(t('Logged this week'), formatMinutes(logged), t('of {0}', formatMinutes(target)), () => go('timesheet'),
				h('span', { class: 'meter' }, h('span', { class: 'meter-fill', style: `width: ${Math.min(100, logged / target * 100)}%` }))),
			stat(t('Reviews waiting'), String(reviews.length), reviews.length ? t('RFCs need your review') : t('All caught up'), () => go('rfcs')),
		),
		h('div', { class: 'home-columns' },
			h('div', { class: 'home-main' },
				section(t('Assigned to you'), mine.length ? h('div', { class: 'list-card' }, mine.map(item => row(model, item))) : emptyHint(t('Nothing assigned to you. Pick something from the board.'))),
				reviews.length ? section(t('Waiting for your review'), h('div', { class: 'list-card' }, reviews.map(item => rfcRow(model, item)))) : null,
			),
			h('div', { class: 'home-side' },
				section(t('Your to-dos'), todos.length
					? h('div', { class: 'todo-list' }, todos.slice(0, 12).map(({ item, entry }) => h('div', { class: 'todo' },
						h('button', {
							class: 'checkbox',
							title: t('Mark Done'),
							disabled: !model.canEdit,
							onclick: () => model.update(item, { checklist: item.checklist.map(c => c.id === entry.id ? { ...c, done: true } : c) }, { checkVersion: true }).catch(reportError),
						}),
						h('div', { class: 'todo-text' },
							h('span', null, entry.text),
							h('button', { class: 'todo-item link', onclick: () => select(model, item.id) }, `${model.key(item)} ${item.title}`),
						),
					)))
					: emptyHint(t('No open to-dos. Add them to a ticket\'s checklist.'))),
				section(t('Recent activity'), activity(model)),
			),
		),
	);
}

function section(title: string, body: Node): HTMLElement {
	return h('section', { class: 'home-section' }, h('h2', null, title), body);
}

function emptyHint(text: string): HTMLElement {
	return h('div', { class: 'empty-hint' }, text);
}

function rfcRow(model: Model, item: Item): HTMLElement {
	return h('div', { class: 'list-row', tabindex: 0, onclick: () => select(model, item.id) },
		kindIcon('rfc', 14),
		h('span', { class: 'row-key' }, model.key(item)),
		statusIcon('rfc', item.status),
		h('span', { class: 'row-title' }, item.title),
		h('span', { class: 'spacer' }),
		h('span', { class: 'muted small' }, t('by {0}', model.member(item.createdBy)?.name ?? '')),
		avatarStack(model.people(item.reviewers)),
	);
}

function activity(model: Model): HTMLElement {
	const recent = model.all().sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 8);
	if (!recent.length) {
		return emptyHint(t('Changes from your team show up here.'));
	}
	return h('div', { class: 'activity' }, recent.map(item => {
		const who = model.member(item.updatedBy);
		const created = item.version === 1;
		return h('button', { class: 'activity-row', onclick: () => select(model, item.id) },
			avatar(who),
			h('span', { class: 'activity-text' },
				h('strong', null, who?.name ?? t('Someone')),
				' ',
				created ? t('created') : t('updated'),
				' ',
				h('span', { class: 'activity-item' }, `${model.key(item)} ${item.title}`),
				created ? null : h('span', { class: 'muted' }, ` · ${statusLabel(item.kind, item.status)}`),
			),
			h('span', { class: 'muted small' }, timeAgo(item.updatedAt)),
		);
	}));
}
