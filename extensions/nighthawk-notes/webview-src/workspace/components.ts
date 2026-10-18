/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ItemKind, Priority } from './api';
import { t } from './l10n';
import { h, icon, svgElement, svgShapes } from './util';

function svg(markup: string, classNames: string[], size = 14): SVGElement {
	const el = svgElement('svg', { width: size, height: size, viewBox: '0 0 14 14', 'aria-hidden': 'true' }, ...svgShapes(markup));
	el.classList.add(...classNames);
	return el;
}

/** The round workflow icon: empty for to do, filling up as work moves along. */
export function statusIcon(kind: ItemKind, status: string, size = 14): SVGElement {
	const ring = (dash = '') => `<circle cx="7" cy="7" r="5.5" fill="none" stroke="currentColor" stroke-width="1.5"${dash}/>`;
	const pie = (fraction: number) => {
		const angle = fraction * 2 * Math.PI;
		const x = 7 + 3 * Math.sin(angle);
		const y = 7 - 3 * Math.cos(angle);
		return `<path d="M7 7 L7 4 A3 3 0 ${fraction > 0.5 ? 1 : 0} 1 ${x.toFixed(2)} ${y.toFixed(2)} Z" fill="currentColor"/>`;
	};
	const filled = (mark: string) => `<circle cx="7" cy="7" r="6.25" fill="currentColor"/><path d="${mark}" fill="none" stroke="var(--vscode-editor-background)" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>`;
	let markup: string;
	switch (`${kind === 'rfc' ? 'rfc' : 'ticket'}:${status}`) {
		case 'ticket:backlog': markup = ring(' stroke-dasharray="1.6 1.9"'); break;
		case 'ticket:todo': markup = ring(); break;
		case 'ticket:in_progress': markup = ring() + pie(0.5); break;
		case 'ticket:in_review': markup = ring() + pie(0.75); break;
		case 'ticket:done': markup = filled('M4.3 7.2l1.9 1.9 3.6-3.9'); break;
		case 'rfc:draft': markup = ring(' stroke-dasharray="1.6 1.9"'); break;
		case 'rfc:in_review': markup = ring() + pie(0.5); break;
		case 'rfc:accepted': markup = filled('M4.3 7.2l1.9 1.9 3.6-3.9'); break;
		case 'rfc:rejected': markup = filled('M4.9 4.9l4.2 4.2M9.1 4.9l-4.2 4.2'); break;
		default: markup = filled('M4.5 7h5'); break;
	}
	return svg(markup, ['status-icon', `status-${kind === 'rfc' ? 'rfc' : 'ticket'}-${status}`], size);
}

/** Linear-style priority bars; urgent is a filled warning square. */
export function priorityIcon(priority: Priority, size = 14): SVGElement {
	if (priority === 'urgent') {
		return svg('<rect x="1" y="1" width="12" height="12" rx="3" fill="currentColor"/><path d="M7 3.8v4M7 10v.2" stroke="var(--vscode-editor-background)" stroke-width="1.7" stroke-linecap="round"/>', ['priority-icon', 'priority-urgent'], size);
	}
	if (priority === 'none') {
		return svg('<path d="M2.5 7h2M6 7h2M9.5 7h2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>', ['priority-icon', 'priority-none'], size);
	}
	const level = priority === 'high' ? 3 : priority === 'medium' ? 2 : 1;
	const bars = [0, 1, 2].map(i => `<rect x="${2 + i * 3.75}" y="${9 - i * 3}" width="2.5" height="${3 + i * 3}" rx=".6" fill="currentColor" opacity="${i < level ? 1 : 0.28}"/>`).join('');
	return svg(bars, ['priority-icon', `priority-${priority}`], size);
}

export function kindIcon(kind: ItemKind, size = 14): SVGElement {
	const el = icon(kind, size);
	el.classList.add('kind-icon', `kind-${kind}`);
	return el;
}

export function labelChip(label: string, onRemove?: () => void): HTMLElement {
	return h('span', { class: 'label-chip', style: `--label-hue: ${labelHue(label)}` },
		h('span', { class: 'label-dot' }),
		label,
		onRemove ? h('button', { class: 'chip-remove', title: t('Remove'), onclick: (e: Event) => { e.stopPropagation(); onRemove(); } }, icon('close', 10)) : null,
	);
}

export function labelHue(label: string): number {
	let hash = 0;
	for (let i = 0; i < label.length; i++) {
		hash = (hash * 31 + label.charCodeAt(i)) | 0;
	}
	return Math.abs(hash) % 360;
}

// --- popover menus

export interface MenuOption {
	id: string;
	label: string;
	icon?: Node;
	hint?: string;
	checked?: boolean;
	danger?: boolean;
}

export interface MenuConfig {
	/** Keep the menu open and toggle check marks, for picking several. */
	multi?: boolean;
	search?: boolean;
	placeholder?: string;
	/** Offers to create what was typed when nothing matches, e.g. a new label. */
	create?: (text: string) => void;
	createLabel?: (text: string) => string;
	onClose?: () => void;
}

let openMenuClose: (() => void) | undefined;

/** Closes whatever menu or popover is open. Returns whether one was. */
export function closeMenus(): boolean {
	if (openMenuClose) {
		openMenuClose();
		return true;
	}
	return false;
}

/**
 * A searchable dropdown anchored to an element, like Notion's property
 * pickers. Arrow keys move, Enter picks, Escape closes.
 */
export function showMenu(anchor: HTMLElement, options: MenuOption[], onSelect: (id: string) => void, config: MenuConfig = {}): void {
	const panel = popover(anchor, 'menu', config.onClose);
	const input = config.search === true || (config.search !== false && (options.length > 6 || config.create))
		? h('input', { class: 'menu-search', placeholder: config.placeholder ?? t('Search...'), spellcheck: false })
		: null;
	const list = h('div', { class: 'menu-list', role: 'listbox' });
	let active = 0;
	let visible: MenuOption[] = options;

	const render = () => {
		const query = input?.value.trim().toLowerCase() ?? '';
		visible = options.filter(o => !query || o.label.toLowerCase().includes(query));
		list.replaceChildren(...visible.map((option, index) => h('div', {
			class: { 'menu-item': true, active: index === active, danger: !!option.danger },
			role: 'option',
			onmousedown: (e: Event) => e.preventDefault(),
			onclick: () => pick(option),
			onmouseenter: () => { active = index; highlight(); },
		},
			config.multi ? h('span', { class: { 'menu-check': true, checked: !!option.checked } }, option.checked ? icon('check', 12) : null) : null,
			option.icon ? h('span', { class: 'menu-icon' }, option.icon) : null,
			h('span', { class: 'menu-label' }, option.label),
			option.hint ? h('span', { class: 'menu-hint' }, option.hint) : null,
			!config.multi && option.checked ? h('span', { class: 'menu-tick' }, icon('check', 12)) : null,
		)));
		if (config.create && query && !options.some(o => o.label.toLowerCase() === query)) {
			list.appendChild(h('div', {
				class: { 'menu-item': true, 'menu-create': true, active: visible.length === active },
				onmousedown: (e: Event) => e.preventDefault(),
				onclick: () => create(),
			}, h('span', { class: 'menu-icon' }, icon('plus', 12)), h('span', { class: 'menu-label' }, config.createLabel?.(input!.value.trim()) ?? input!.value.trim())));
		}
		if (!list.children.length) {
			list.appendChild(h('div', { class: 'menu-empty' }, t('No matches')));
		}
	};
	const highlight = () => [...list.children].forEach((child, index) => child.classList.toggle('active', index === active));
	const create = () => {
		const text = input!.value.trim();
		config.create!(text);
		if (config.multi) {
			options.push({ id: text, label: text, checked: true });
			input!.value = '';
			render();
		} else {
			close();
		}
	};
	const pick = (option: MenuOption) => {
		onSelect(option.id);
		if (config.multi) {
			option.checked = !option.checked;
			render();
		} else {
			close();
		}
	};
	const close = () => panel.close();

	panel.el.append(...(input ? [input] : []), list);
	panel.el.addEventListener('keydown', e => {
		const count = list.querySelectorAll('.menu-item').length;
		if (e.key === 'ArrowDown') {
			active = Math.min(count - 1, active + 1);
			highlight();
			e.preventDefault();
		} else if (e.key === 'ArrowUp') {
			active = Math.max(0, active - 1);
			highlight();
			e.preventDefault();
		} else if (e.key === 'Enter') {
			e.preventDefault();
			if (active < visible.length) {
				pick(visible[active]);
			} else if (config.create && input?.value.trim()) {
				create();
			}
		}
	});
	input?.addEventListener('input', () => { active = 0; render(); });
	render();
	panel.place();
	(input ?? panel.el).focus({ preventScroll: true });
}

/** A floating panel under `anchor` that closes on outside clicks and Escape. */
export function popover(anchor: HTMLElement, className: string, onClose?: () => void): { el: HTMLElement; place: () => void; close: () => void } {
	closeMenus();
	const el = h('div', { class: `popover ${className}`, tabindex: -1, style: 'top: 0; left: 0; visibility: hidden' });
	document.body.appendChild(el);
	anchor.classList.add('open');
	const outside = (e: MouseEvent) => {
		if (!el.contains(e.target as Node) && !anchor.contains(e.target as Node)) {
			close();
		}
	};
	const key = (e: KeyboardEvent) => {
		if (e.key === 'Escape') {
			e.stopPropagation();
			close();
			anchor.focus();
		}
	};
	const close = () => {
		el.remove();
		anchor.classList.remove('open');
		document.removeEventListener('mousedown', outside, true);
		el.removeEventListener('keydown', key);
		openMenuClose = undefined;
		onClose?.();
	};
	const place = () => {
		const rect = anchor.getBoundingClientRect();
		const width = el.offsetWidth;
		const height = el.offsetHeight;
		const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
		const below = rect.bottom + 4;
		const top = below + height > window.innerHeight - 8 && rect.top - height - 4 > 8 ? rect.top - height - 4 : below;
		el.style.left = `${left}px`;
		el.style.top = `${top}px`;
		el.style.visibility = '';
	};
	document.addEventListener('mousedown', outside, true);
	el.addEventListener('keydown', key);
	openMenuClose = close;
	return { el, place, close };
}

/** Asks for one value in a small popover, e.g. a date or a duration. */
export function showInput(anchor: HTMLElement, config: { type?: string; value: string; placeholder?: string; hint?: string; clearLabel?: string }, onSubmit: (value: string) => boolean | void): void {
	const panel = popover(anchor, 'input-popover');
	const input = h('input', { type: config.type ?? 'text', value: config.value, placeholder: config.placeholder ?? '', class: 'text-input' });
	const submit = () => {
		if (onSubmit(input.value) !== false) {
			panel.close();
		} else {
			input.classList.add('invalid');
		}
	};
	input.addEventListener('keydown', e => {
		if (e.key === 'Enter') {
			e.preventDefault();
			submit();
		}
	});
	input.addEventListener('input', () => input.classList.remove('invalid'));
	panel.el.append(input);
	if (config.hint) {
		panel.el.append(h('div', { class: 'input-hint' }, config.hint));
	}
	panel.el.append(
		h('div', { class: 'input-actions' },
			config.clearLabel ? h('button', { class: 'button ghost', onclick: () => { onSubmit(''); panel.close(); } }, config.clearLabel) : null,
			h('button', { class: 'button primary', onclick: submit }, t('Save')),
		),
	);
	panel.place();
	input.focus({ preventScroll: true });
	input.select?.();
}

// --- toasts

export function toast(message: string, kind: 'info' | 'error' = 'info', action?: { label: string; run: () => void }): void {
	let host = document.getElementById('toasts');
	if (!host) {
		host = h('div', { id: 'toasts', role: 'status', 'aria-live': 'polite' });
		document.body.appendChild(host);
	}
	const el = h('div', { class: `toast toast-${kind}` },
		icon(kind === 'error' ? 'changes' : 'check', 14),
		h('span', { class: 'toast-text' }, message),
		action ? h('button', { class: 'toast-action', onclick: () => { action.run(); el.remove(); } }, action.label) : null,
	);
	host.appendChild(el);
	setTimeout(() => el.classList.add('leaving'), kind === 'error' ? 6000 : 3500);
	setTimeout(() => el.remove(), kind === 'error' ? 6300 : 3800);
}

export function reportError(err: unknown): void {
	toast(err instanceof Error ? err.message : String(err), 'error');
}

// --- modal dialogs

export function modal(content: HTMLElement, className = ''): { close: () => void; el: HTMLElement } {
	closeMenus();
	const backdrop = h('div', { class: 'modal-backdrop' });
	const dialog = h('div', { class: `modal ${className}`, role: 'dialog', 'aria-modal': 'true' }, content);
	backdrop.appendChild(dialog);
	const close = () => {
		backdrop.classList.add('leaving');
		document.removeEventListener('keydown', key, true);
		setTimeout(() => backdrop.remove(), 120);
	};
	const key = (e: KeyboardEvent) => {
		if (e.key === 'Escape' && !closeMenus()) {
			e.stopPropagation();
			close();
		}
	};
	backdrop.addEventListener('mousedown', e => {
		if (e.target === backdrop) {
			close();
		}
	});
	document.addEventListener('keydown', key, true);
	document.body.appendChild(backdrop);
	return { close, el: dialog };
}

/** Asks before something that cannot be undone. */
export function confirmDialog(title: string, message: string, confirmLabel: string): Promise<boolean> {
	return new Promise(resolve => {
		let answered = false;
		const answer = (value: boolean) => {
			if (!answered) {
				answered = true;
				dialog.close();
				resolve(value);
			}
		};
		const confirmButton = h('button', { class: 'button danger', onclick: () => answer(true) }, confirmLabel);
		const dialog = modal(h('div', { class: 'confirm' },
			h('h2', null, title),
			h('p', null, message),
			h('div', { class: 'modal-actions' },
				h('button', { class: 'button ghost', onclick: () => answer(false) }, t('Cancel')),
				confirmButton,
			),
		), 'modal-small');
		dialog.el.parentElement!.addEventListener('mousedown', e => {
			if (e.target === dialog.el.parentElement) {
				answer(false);
			}
		});
		confirmButton.focus();
	});
}

/** A textarea that grows with its content. */
export function autosize(textarea: HTMLTextAreaElement): HTMLTextAreaElement {
	const resize = () => {
		textarea.style.height = 'auto';
		textarea.style.height = `${textarea.scrollHeight}px`;
	};
	textarea.addEventListener('input', resize);
	requestAnimationFrame(resize);
	return textarea;
}

/**
 * Rebuilds part of the page without losing the caret: the focused field is
 * found again by its `data-key` and focused at the same position.
 */
export function preservingFocus(render: () => void): void {
	const active = document.activeElement;
	const field = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement ? active : undefined;
	const key = (active as HTMLElement | null)?.dataset?.key;
	const selection = key && field ? [field.selectionStart, field.selectionEnd] as const : undefined;
	// Keep what was typed but not yet saved.
	const typed = key && field && field.value !== field.defaultValue ? field.value : undefined;
	render();
	if (key) {
		const next = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[data-key="${CSS.escape(key)}"]`);
		if (next && next !== active) {
			if (typed !== undefined) {
				next.value = typed;
			}
			next.focus({ preventScroll: true });
			if (selection && selection[0] !== null) {
				try {
					next.setSelectionRange(selection[0], selection[1]);
				} catch {
					// Not a text field.
				}
			}
		}
	}
}
