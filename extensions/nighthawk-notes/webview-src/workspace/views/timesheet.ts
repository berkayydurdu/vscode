/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { extensionRequest, type Item, type Suggestion, type Worklog } from '../api';
import { select } from '../card';
import { kindIcon, modal, reportError, showMenu, statusIcon, toast } from '../components';
import { t } from '../l10n';
import { isClosed, type Model } from '../model';
import { addDays, avatar, formatHours, formatMinutes, h, icon, isoDate, parseDuration, parseIsoDate, startOfWeek } from '../util';
import { invalidateWeek } from './home';

const DAY_TARGET = 8 * 60;
const TEAM = 'team';

/**
 * A Tempo-style weekly timesheet. Rows are tickets, columns are days, and
 * every cell is the time booked on that ticket that day; typing a number
 * books, changes or clears it. "Whole team" shows everyone's totals.
 */
export class Timesheet {

	private weekStart = startOfWeek(new Date());
	private logs: Worklog[] = [];
	private loadedKey = '';
	private loading = false;
	private readonly addedRows = new Map<string, Set<string>>();
	private suggestions: Suggestion[] = [];

	constructor(private readonly model: Model) { }

	private get user(): string {
		const user = this.model.timesheetUser;
		return user && (user === TEAM || this.model.member(user)) ? user : this.model.me.id;
	}

	private get days(): Date[] {
		return [0, 1, 2, 3, 4, 5, 6].map(i => addDays(this.weekStart, i));
	}

	private get canEditCells(): boolean {
		return this.user === this.model.me.id ? this.model.canEdit : this.user !== TEAM && this.model.isAdmin;
	}

	/** Reloads the week's entries, e.g. after time was logged elsewhere. */
	invalidate(): void {
		this.loadedKey = '';
	}

	private ensureLoaded(): void {
		const key = isoDate(this.weekStart);
		if (this.loadedKey === key || this.loading) {
			return;
		}
		this.loading = true;
		const to = isoDate(addDays(this.weekStart, 6));
		this.model.api.worklogs({ from: key, to }).then(async logs => {
			this.logs = logs;
			this.loadedKey = key;
			this.suggestions = await this.loadSuggestions(key, to).catch(() => []);
		}, reportError).finally(() => {
			this.loading = false;
			this.model.changed();
		});
	}

	/** Asks the extension what it saw you work on this week that is not logged yet. */
	private loadSuggestions(from: string, to: string): Promise<Suggestion[]> {
		if (!this.model.canEdit) {
			return Promise.resolve([]);
		}
		const logged: Record<string, number> = {};
		for (const log of this.logs) {
			const item = this.model.items.get(log.itemId);
			if (item && log.userId === this.model.me.id) {
				const key = `${item.number}|${log.date}`;
				logged[key] = (logged[key] ?? 0) + log.minutes;
			}
		}
		return extensionRequest<Suggestion[]>('timeSuggestions', { from, to, logged });
	}

	render(): HTMLElement {
		this.ensureLoaded();
		const days = this.days;
		const today = isoDate(new Date());
		const weekLabel = `${days[0].toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} \u2013 ${days[6].toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`;
		const user = this.user;
		const person = user === TEAM ? undefined : this.model.member(user);

		const toolbar = h('div', { class: 'timesheet-toolbar' },
			h('div', { class: 'week-nav' },
				h('button', { class: 'icon-button', title: t('Previous Week'), onclick: () => this.moveWeek(-7) }, icon('chevronLeft', 14)),
				h('button', { class: 'button ghost', onclick: () => this.moveWeek(0) }, t('This Week')),
				h('button', { class: 'icon-button', title: t('Next Week'), onclick: () => this.moveWeek(7) }, icon('chevronRight', 14)),
				h('span', { class: 'week-label' }, weekLabel),
			),
			h('span', { class: 'spacer' }),
			h('button', {
				class: 'property-button person-picker',
				onclick: (e: Event) => this.pickUser(e.currentTarget as HTMLElement),
			}, user === TEAM ? icon('people', 14) : avatar(person), user === TEAM ? t('Whole team') : person?.userId === this.model.me.id ? t('My timesheet') : person?.name ?? '', icon('chevronRight', 10)),
			this.model.canEdit ? h('button', { class: 'button primary', onclick: () => logTimeDialog(this.model, { date: days.some(d => isoDate(d) === today) ? today : isoDate(days[0]), onDone: () => this.afterLog() }) }, icon('clock', 14), t('Log Time')) : null,
		);

		const grid = user === TEAM ? this.teamGrid(days, today) : this.personGrid(user, days, today);
		const suggested = user === this.model.me.id && this.model.canEdit && this.suggestions.length ? this.suggestionPanel(today) : null;
		return h('div', { class: 'timesheet' }, toolbar, suggested, grid);
	}

	/** "Suggested from your activity": tracked time to log in one click. */
	private suggestionPanel(today: string): HTMLElement {
		const byNumber = new Map(this.model.all().map(item => [item.number, item]));
		const linked = this.suggestions.filter(s => s.number && byNumber.has(s.number));
		const total = linked.reduce((sum, s) => sum + s.minutes, 0);
		const yesterday = isoDate(addDays(parseIsoDate(today), -1));
		const dayLabel = (date: string) => date === today ? t('Today') : date === yesterday ? t('Yesterday') : parseIsoDate(date).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
		const note = (s: Suggestion) => s.files.length ? t('Worked on {0}: {1}', s.branch, s.files.slice(0, 3).join(', ')) : t('Worked on {0}', s.branch);
		const logAll = async () => {
			try {
				await Promise.all(linked.map(s => this.model.api.logTime(byNumber.get(s.number!)!.id, s.minutes, s.date, note(s))));
				toast(t('Logged {0} from your activity', formatMinutes(total)));
			} catch (err) {
				reportError(err);
			}
			this.afterLog();
		};
		const dismiss = async (s: Suggestion) => {
			this.suggestions = this.suggestions.filter(other => other.id !== s.id);
			this.model.changed();
			await extensionRequest('dismissSuggestion', { suggestion: s.id }).catch(reportError);
		};
		const rows = this.suggestions.map(s => {
			const item = s.number ? byNumber.get(s.number) : undefined;
			const what = item
				? h('button', { class: 'ts-suggest-what', onclick: () => select(this.model, item.id), title: item.title }, statusIcon(item.kind, item.status), h('span', { class: 'row-key' }, this.model.key(item)), h('span', { class: 'ellipsis' }, item.title))
				: h('span', { class: 'ts-suggest-what' }, icon('branch', 14), h('span', { class: 'ellipsis' }, s.branch), h('span', { class: 'muted small' }, t('no ticket')));
			const detail = [
				s.logged ? t('{0} active, {1} logged', formatMinutes(s.tracked), formatMinutes(s.logged)) : t('{0} active', formatMinutes(s.tracked)),
				item ? s.branch : s.repo,
				s.files.length > 2 ? t('{0} and {1} more', s.files.slice(0, 2).join(', '), s.files.length - 2) : s.files.join(', '),
			].filter(Boolean).join(' \u00b7 ');
			const edit = () => logTimeDialog(this.model, { itemId: item?.id, date: s.date, minutes: s.minutes, note: note(s), onDone: () => this.afterLog(item?.id) });
			return h('div', { class: 'ts-suggest-row' },
				h('span', { class: 'ts-suggest-day' }, dayLabel(s.date)),
				h('div', { class: 'ts-suggest-main' }, what, h('span', { class: 'ts-suggest-detail' }, detail)),
				item
					? h('button', {
						class: 'button small primary',
						onclick: async () => {
							try {
								await this.model.api.logTime(item.id, s.minutes, s.date, note(s));
								toast(t('Logged {0} on {1}', formatMinutes(s.minutes), this.model.key(item)));
							} catch (err) {
								reportError(err);
							}
							this.afterLog(item.id);
						},
					}, t('Log {0}', formatMinutes(s.minutes)))
					: h('button', { class: 'button small', onclick: edit }, t('Pick Ticket')),
				item ? h('button', { class: 'icon-button', title: t('Change before logging'), 'aria-label': t('Change before logging'), onclick: edit }, icon('edit', 14)) : h('span'),
				h('button', { class: 'icon-button', title: t('Dismiss'), 'aria-label': t('Dismiss'), onclick: () => dismiss(s) }, icon('close', 14)),
			);
		});
		return h('section', { class: 'ts-suggest' },
			h('div', { class: 'ts-suggest-head' },
				h('span', { class: 'ts-suggest-icon' }, icon('sparkle', 14)),
				h('div', null,
					h('div', { class: 'ts-suggest-title' }, t('Suggested from your activity')),
					h('div', { class: 'muted small' }, t('Active time in Nighthawk while a ticket\'s branch was checked out. Nothing is shared until you log it.')),
				),
				h('span', { class: 'spacer' }),
				linked.length > 1 ? h('button', { class: 'button small', onclick: logAll }, icon('check', 14), t('Log All ({0})', formatMinutes(total))) : null,
			),
			rows,
		);
	}

	private moveWeek(delta: number): void {
		this.weekStart = delta ? addDays(this.weekStart, delta) : startOfWeek(new Date());
		this.model.changed();
	}

	private pickUser(anchor: HTMLElement): void {
		const members = [...this.model.members].sort((a, b) => a.userId === this.model.me.id ? -1 : b.userId === this.model.me.id ? 1 : a.name.localeCompare(b.name));
		showMenu(anchor, [
			{ id: TEAM, label: t('Whole team'), icon: icon('people', 14), checked: this.user === TEAM },
			...members.map(m => ({ id: m.userId, label: m.userId === this.model.me.id ? t('{0} (you)', m.name) : m.name, icon: avatar(m), checked: this.user === m.userId })),
		], id => {
			this.model.timesheetUser = id;
			this.model.changed();
		});
	}

	private headerRow(days: Date[], today: string, first: string): HTMLElement {
		return h('div', { class: 'ts-row ts-head' },
			h('div', { class: 'ts-name' }, first),
			days.map(day => h('div', { class: { 'ts-cell': true, today: isoDate(day) === today, weekend: day.getDay() % 6 === 0 } },
				h('span', { class: 'ts-weekday' }, day.toLocaleDateString(undefined, { weekday: 'short' })),
				h('span', { class: 'ts-date' }, String(day.getDate())),
			)),
			h('div', { class: 'ts-total' }, t('Total')),
		);
	}

	private footerRow(days: Date[], today: string, logs: Worklog[], dayTarget: number): HTMLElement {
		const week = logs.reduce((sum, log) => sum + log.minutes, 0);
		return h('div', { class: 'ts-row ts-foot' },
			h('div', { class: 'ts-name' }, t('Total')),
			days.map(day => {
				const minutes = logs.filter(log => log.date === isoDate(day)).reduce((sum, log) => sum + log.minutes, 0);
				const weekend = day.getDay() % 6 === 0;
				return h('div', { class: { 'ts-cell': true, today: isoDate(day) === today, weekend } },
					h('span', null, formatHours(minutes) || '0'),
					weekend ? null : h('span', { class: 'meter thin' }, h('span', { class: { 'meter-fill': true, full: minutes >= dayTarget }, style: `width: ${Math.min(100, minutes / dayTarget * 100)}%` })),
				);
			}),
			h('div', { class: 'ts-total' }, h('strong', null, formatHours(week) || '0'), h('span', { class: 'muted small' }, ` / ${formatHours(dayTarget * 5)}h`)),
		);
	}

	private personGrid(userId: string, days: Date[], today: string): HTMLElement {
		const logs = this.logs.filter(log => log.userId === userId);
		const rowKey = `${userId}:${isoDate(this.weekStart)}`;
		const added = this.addedRows.get(rowKey) ?? new Set<string>();
		const ids = new Set([
			...logs.map(log => log.itemId),
			...added,
			// Work in progress is offered so booking it is one click away.
			...this.model.all().filter(item => item.kind !== 'rfc' && item.status === 'in_progress' && item.assignees.includes(userId)).map(item => item.id),
		]);
		const rows = [...ids].map(id => this.model.items.get(id)).filter((item): item is Item => !!item).sort((a, b) => a.number - b.number);
		const missing = logs.filter(log => !this.model.items.has(log.itemId));

		const grid = h('div', { class: 'ts-grid', role: 'grid' },
			this.headerRow(days, today, t('Ticket')),
			rows.map(item => {
				const itemLogs = logs.filter(log => log.itemId === item.id);
				const total = itemLogs.reduce((sum, log) => sum + log.minutes, 0);
				return h('div', { class: 'ts-row' },
					h('button', { class: 'ts-name ts-item', onclick: () => select(this.model, item.id), title: item.title },
						statusIcon(item.kind, item.status),
						h('span', { class: 'row-key' }, this.model.key(item)),
						h('span', { class: 'ts-title' }, item.title),
					),
					days.map(day => this.cell(item, userId, isoDate(day), itemLogs.filter(log => log.date === isoDate(day)), today)),
					h('div', { class: 'ts-total' }, formatHours(total) || '\u2013'),
				);
			}),
			missing.length ? h('div', { class: 'ts-row muted' },
				h('div', { class: 'ts-name' }, t('Deleted tickets')),
				days.map(day => h('div', { class: 'ts-cell' }, formatHours(missing.filter(log => log.date === isoDate(day)).reduce((s, l) => s + l.minutes, 0)))),
				h('div', { class: 'ts-total' }, formatHours(missing.reduce((s, l) => s + l.minutes, 0))),
			) : null,
			this.canEditCells ? h('div', { class: 'ts-row ts-add' },
				h('button', { class: 'quick-add-button', onclick: (e: Event) => this.addRow(e.currentTarget as HTMLElement, rowKey, ids) }, icon('plus', 12), t('Add Ticket')),
			) : null,
			this.footerRow(days, today, logs, DAY_TARGET),
		);
		if (!rows.length && !missing.length) {
			grid.insertBefore(h('div', { class: 'ts-empty' }, this.loadedKey ? t('No time booked this week.') : t('Loading...')), grid.children[1]);
		}
		return grid;
	}

	private cell(item: Item, userId: string, date: string, logs: Worklog[], today: string): HTMLElement {
		const minutes = logs.reduce((sum, log) => sum + log.minutes, 0);
		const weekend = parseIsoDate(date).getDay() % 6 === 0;
		const className = { 'ts-cell': true, today: date === today, weekend, filled: minutes > 0 };
		if (!this.canEditCells) {
			return h('div', { class: className, title: logs.map(l => l.note).filter(Boolean).join('\n') }, formatHours(minutes));
		}
		const input = h('input', {
			class: 'ts-input',
			value: formatHours(minutes),
			'data-key': `ts:${item.id}:${date}`,
			'aria-label': t('{0} on {1}', this.model.key(item), date),
			title: logs.map(l => l.note).filter(Boolean).join('\n') || t('Hours, e.g. 1.5 or 1h 30m'),
		});
		input.addEventListener('focus', () => input.select());
		input.addEventListener('keydown', e => {
			if (e.key === 'Enter') {
				input.blur();
			} else if (e.key === 'Escape') {
				input.value = formatHours(minutes);
				input.blur();
			}
		});
		input.addEventListener('change', () => this.book(item, userId, date, logs, input));
		return h('div', { class: className }, input);
	}

	/** Makes the booked time on one cell match what was typed. */
	private async book(item: Item, userId: string, date: string, logs: Worklog[], input: HTMLInputElement): Promise<void> {
		const minutes = parseDuration(input.value);
		const current = logs.reduce((sum, log) => sum + log.minutes, 0);
		if (minutes === undefined || minutes > 24 * 60) {
			input.classList.add('invalid');
			toast(t('Enter hours like 2, 1.5, 1h 30m or 90m'), 'error');
			return;
		}
		input.classList.remove('invalid');
		if (minutes === current) {
			return;
		}
		const api = this.model.api;
		try {
			if (!minutes) {
				await Promise.all(logs.map(log => api.deleteWorklog(log.id)));
			} else if (!logs.length) {
				if (userId !== this.model.me.id) {
					toast(t('Time can only be booked for yourself.'), 'error');
					input.value = formatHours(current);
					return;
				}
				await api.logTime(item.id, minutes, date);
			} else {
				// Keep the first entry (and its note); fold the rest into it.
				const [first, ...rest] = logs;
				await Promise.all(rest.map(log => api.deleteWorklog(log.id)));
				await api.updateWorklog(first.id, { minutes });
			}
		} catch (err) {
			reportError(err);
		}
		this.afterLog(item.id);
	}

	private afterLog(itemId?: string): void {
		this.invalidate();
		invalidateWeek();
		if (itemId) {
			this.model.reload(itemId).catch(reportError);
		} else {
			this.model.sync().catch(reportError);
			this.model.changed();
		}
	}

	private addRow(anchor: HTMLElement, rowKey: string, shown: Set<string>): void {
		const candidates = this.model.all().filter(item => !shown.has(item.id) && !item.deleted).sort((a, b) => Number(isClosed(a)) - Number(isClosed(b)) || b.updatedAt - a.updatedAt);
		showMenu(anchor, candidates.map(item => ({ id: item.id, label: `${this.model.key(item)}  ${item.title}`, icon: statusIcon(item.kind, item.status) })), id => {
			const set = this.addedRows.get(rowKey) ?? new Set<string>();
			set.add(id);
			this.addedRows.set(rowKey, set);
			this.model.changed();
			requestAnimationFrame(() => (document.querySelector(`[data-key="ts:${id}:${isoDate(new Date()) >= isoDate(this.weekStart) && isoDate(new Date()) <= isoDate(addDays(this.weekStart, 6)) ? isoDate(new Date()) : isoDate(this.weekStart)}"]`) as HTMLElement | null)?.focus());
		}, { search: true, placeholder: t('Find a ticket...') });
	}

	private teamGrid(days: Date[], today: string): HTMLElement {
		const members = [...this.model.members].sort((a, b) => a.name.localeCompare(b.name));
		return h('div', { class: 'ts-grid', role: 'grid' },
			this.headerRow(days, today, t('Member')),
			members.map(member => {
				const logs = this.logs.filter(log => log.userId === member.userId);
				const total = logs.reduce((sum, log) => sum + log.minutes, 0);
				return h('div', { class: 'ts-row' },
					h('button', { class: 'ts-name ts-item', onclick: () => { this.model.timesheetUser = member.userId; this.model.changed(); } }, avatar(member), h('span', { class: 'ts-title' }, member.name)),
					days.map(day => {
						const minutes = logs.filter(log => log.date === isoDate(day)).reduce((sum, log) => sum + log.minutes, 0);
						return h('div', { class: { 'ts-cell': true, today: isoDate(day) === today, weekend: day.getDay() % 6 === 0, filled: minutes > 0 } }, formatHours(minutes));
					}),
					h('div', { class: 'ts-total' }, h('strong', null, formatHours(total) || '\u2013'), h('span', { class: 'meter thin' }, h('span', { class: 'meter-fill', style: `width: ${Math.min(100, total / (DAY_TARGET * 5) * 100)}%` }))),
				);
			}),
			this.footerRow(days, today, this.logs, DAY_TARGET * Math.max(1, members.length)),
		);
	}
}

/** The "Log time" dialog: ticket, day, duration and what was done. */
export function logTimeDialog(model: Model, options: { itemId?: string; date?: string; minutes?: number; note?: string; onDone?: () => void }): void {
	let itemId = options.itemId;
	const itemButton = h('button', { class: 'property-button wide' });
	const showItem = () => {
		const item = itemId ? model.items.get(itemId) : undefined;
		itemButton.replaceChildren(...(item ? [kindIcon(item.kind), h('span', { class: 'row-key' }, model.key(item)), h('span', { class: 'ellipsis' }, item.title)] : [h('span', { class: 'muted' }, t('Pick a ticket'))]));
	};
	showItem();
	itemButton.addEventListener('click', () => {
		const candidates = model.all().sort((a, b) => Number(isClosed(a)) - Number(isClosed(b)) || b.updatedAt - a.updatedAt);
		showMenu(itemButton, candidates.map(item => ({ id: item.id, label: `${model.key(item)}  ${item.title}`, icon: statusIcon(item.kind, item.status), checked: item.id === itemId })), id => {
			itemId = id;
			showItem();
			duration.focus();
		}, { search: true, placeholder: t('Find a ticket...') });
	});
	const date = h('input', { type: 'date', class: 'text-input', value: options.date ?? isoDate(new Date()) });
	const duration = h('input', { class: 'text-input', placeholder: t('e.g. 1h 30m'), value: options.minutes ? formatMinutes(options.minutes) : undefined });
	const note = h('textarea', { class: 'text-input', rows: 3, placeholder: t('What did you work on? (optional)'), value: options.note });
	const error = h('div', { class: 'form-error' });
	const submit = async () => {
		const minutes = parseDuration(duration.value);
		if (!itemId) {
			error.textContent = t('Pick a ticket to book time on.');
			return;
		}
		if (!minutes || minutes > 24 * 60) {
			error.textContent = t('Enter how long, like 2h, 1.5h, 45m or 1:30.');
			duration.focus();
			return;
		}
		try {
			await model.api.logTime(itemId, minutes, date.value, note.value.trim());
			dialog.close();
			toast(t('Logged {0} on {1}', formatMinutes(minutes), model.key(model.items.get(itemId)!)));
			invalidateWeek();
			await model.reload(itemId);
			options.onDone?.();
		} catch (err) {
			error.textContent = err instanceof Error ? err.message : String(err);
		}
	};
	const form = h('form', { class: 'log-time', onsubmit: (e: Event) => { e.preventDefault(); submit(); } },
		h('h2', null, icon('clock', 18), t('Log Time')),
		h('label', { class: 'field' }, h('span', null, t('Ticket')), itemButton),
		h('div', { class: 'field-row' },
			h('label', { class: 'field' }, h('span', null, t('Date')), date),
			h('label', { class: 'field' }, h('span', null, t('Time spent')), duration),
		),
		h('div', { class: 'duration-presets' }, ['15m', '30m', '1h', '2h', '4h', '8h'].map(preset => h('button', { type: 'button', class: 'chip-button', onclick: () => { duration.value = preset; duration.focus(); } }, preset))),
		h('label', { class: 'field' }, h('span', null, t('Description')), note),
		error,
		h('div', { class: 'modal-actions' },
			h('button', { type: 'button', class: 'button ghost', onclick: () => dialog.close() }, t('Cancel')),
			h('button', { type: 'submit', class: 'button primary' }, t('Log Time')),
		),
	);
	const dialog = modal(form, 'modal-small');
	(itemId ? duration : itemButton).focus();
}
