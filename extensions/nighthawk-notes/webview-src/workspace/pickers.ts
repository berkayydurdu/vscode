/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ItemKind, Priority } from './api';
import { labelChip, priorityIcon, showInput, showMenu, statusIcon } from './components';
import { t } from './l10n';
import { PRIORITIES, priorityLabel, statusesOf, statusLabel, type Model } from './model';
import { avatar, formatMinutes, parseDuration } from './util';

// Pickers shared by cards, the detail panel and the new item dialog. Each
// takes the current value and reports the new one.

export function pickStatus(anchor: HTMLElement, kind: ItemKind, current: string, onPick: (status: string) => void): void {
	showMenu(anchor, statusesOf(kind).map((status, index) => ({
		id: status,
		label: statusLabel(kind, status),
		icon: statusIcon(kind, status),
		hint: String(index + 1),
		checked: status === current,
	})), id => id !== current && onPick(id), { search: false });
}

export function pickPriority(anchor: HTMLElement, current: Priority, onPick: (priority: Priority) => void): void {
	showMenu(anchor, PRIORITIES.map(priority => ({
		id: priority,
		label: priorityLabel(priority),
		icon: priorityIcon(priority),
		checked: priority === current,
	})), id => id !== current && onPick(id as Priority), { search: false });
}

/** Picks several people; each toggle is reported right away. */
export function pickPeople(anchor: HTMLElement, model: Model, current: string[], onChange: (userIds: string[]) => void, placeholder = t('Assign to...')): void {
	const selected = new Set(current);
	const mine = model.members.find(m => m.userId === model.me.id);
	const others = model.members.filter(m => m.userId !== model.me.id).sort((a, b) => a.name.localeCompare(b.name));
	showMenu(anchor, [...(mine ? [mine] : []), ...others].map(member => ({
		id: member.userId,
		label: member.userId === model.me.id ? t('{0} (you)', member.name) : member.name,
		icon: avatar(member),
		hint: member.email,
		checked: selected.has(member.userId),
	})), id => {
		if (!selected.delete(id)) {
			selected.add(id);
		}
		onChange([...selected]);
	}, { multi: true, search: true, placeholder });
}

export function pickLabels(anchor: HTMLElement, model: Model, current: string[], onChange: (labels: string[]) => void): void {
	const selected = new Set(current);
	const known = [...new Set([...model.labels(), ...current])].sort((a, b) => a.localeCompare(b));
	showMenu(anchor, known.map(label => ({ id: label, label, icon: labelChip(label).firstChild!.cloneNode(), checked: selected.has(label) })), id => {
		if (!selected.delete(id)) {
			selected.add(id);
		}
		onChange([...selected]);
	}, {
		multi: true,
		search: true,
		placeholder: t('Add labels...'),
		create: text => {
			selected.add(text.slice(0, 40));
			onChange([...selected]);
		},
		createLabel: text => t('Create label "{0}"', text),
	});
}

export function pickDate(anchor: HTMLElement, current: string | null, onPick: (date: string | null) => void): void {
	showInput(anchor, { type: 'date', value: current ?? '', clearLabel: current ? t('Clear') : undefined }, value => {
		if (value !== (current ?? '')) {
			onPick(value || null);
		}
	});
}

export function pickEstimate(anchor: HTMLElement, current: number | null, onPick: (minutes: number | null) => void): void {
	showInput(anchor, {
		value: current ? formatMinutes(current) : '',
		placeholder: t('e.g. 4h or 1h 30m'),
		hint: t('Hours and minutes, like 2h, 1.5h, 90m or 1:30.'),
		clearLabel: current ? t('Clear') : undefined,
	}, value => {
		const minutes = parseDuration(value);
		if (minutes === undefined) {
			return false;
		}
		if ((minutes || null) !== current) {
			onPick(minutes || null);
		}
		return true;
	});
}
