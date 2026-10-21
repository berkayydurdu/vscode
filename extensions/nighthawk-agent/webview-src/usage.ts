/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { UsageGroup, UsageHostMessage, UsagePageMessage } from '../src/core/usage';
import { fill, h, icon, type Child } from './dom';
import { setBundle, t } from './l10n';

declare function acquireVsCodeApi(): { postMessage(message: UsagePageMessage): void };

const vscode = acquireVsCodeApi();
const post = (message: UsagePageMessage) => vscode.postMessage(message);

type Data = Extract<UsageHostMessage, { type: 'summary' }>;

const SVG_NS = 'http://www.w3.org/2000/svg';

function money(cost: number): string {
	if (cost > 0 && cost < 0.01) {
		return '<$0.01';
	}
	return `$${cost.toFixed(2)}`;
}

function tokens(count: number): string {
	if (count >= 1_000_000) {
		return `${(count / 1_000_000).toFixed(count >= 10_000_000 ? 0 : 1)}M`;
	}
	if (count >= 1_000) {
		return `${(count / 1_000).toFixed(count >= 10_000 ? 0 : 1)}k`;
	}
	return String(count);
}

function monthName(month: string, style: 'long' | 'short' = 'long'): string {
	const [year, index] = month.split('-').map(Number);
	return new Date(year, index - 1, 1).toLocaleDateString(undefined, { month: style, year: 'numeric' });
}

function featureName(key: string): string {
	switch (key) {
		case 'agent': return t('Agent');
		case 'commit': return t('Commit messages');
		case 'terminal': return t('Terminal assistant');
		case 'inline': return t('Inline edits');
		case 'autocomplete': return t('Autocomplete');
		default: return key;
	}
}

function ago(time: number, now: number): string {
	const minutes = Math.round((now - time) / 60_000);
	if (minutes < 1) {
		return t('just now');
	}
	if (minutes < 60) {
		return t('{0}m ago', minutes);
	}
	const hours = Math.round(minutes / 60);
	return hours < 24 ? t('{0}h ago', hours) : new Date(time).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
	const el = document.createElementNS(SVG_NS, tag);
	for (const [key, value] of Object.entries(attrs)) {
		el.setAttribute(key, String(value));
	}
	return el;
}

class UsagePage {
	private data: Data | undefined;
	private readonly root = h('main', { class: 'page' });
	private readonly tooltip = h('div', { class: 'tooltip', role: 'tooltip', hidden: true });

	constructor() {
		document.body.append(this.root, this.tooltip);
		window.addEventListener('message', event => {
			// The extension's messages are relayed by the webview host, which shares this page's origin.
			if (event.origin !== window.origin) {
				return;
			}
			const message = event.data as UsageHostMessage;
			if (message.type === 'summary') {
				if (message.l10n) {
					setBundle(message.l10n);
				}
				this.data = message;
				this.render();
			}
		});
		post({ type: 'ready' });
	}

	private render(): void {
		const data = this.data!;
		const { summary } = data;
		fill(this.root,
			this.header(data),
			this.tiles(data),
			summary.requests ? [
				this.chart(data),
				h('div', { class: 'tables' },
					this.table(t('By Model'), summary.byModel, group => [
						h('span', { class: 'name' }, group.label),
						h('span', { class: 'detail' }, group.detail ?? ''),
					], group => group.unpriced ? h('button', { class: 'link', title: t('This model\'s price is not known, so its cost is not counted. Click to set it.'), onclick: () => post({ type: 'editPrice', model: group.label }) }, icon('warning', 12), t('Set price')) : undefined),
					this.table(t('By Conversation'), summary.byChat, group => [
						h('button', { class: 'name link-row', title: t('Open this conversation'), onclick: () => post({ type: 'openChat', id: group.key }) }, group.label),
						h('span', { class: 'detail' }, ago(group.last, data.now)),
					], undefined, t('Agent conversations show here.')),
					this.table(t('By Feature'), summary.byFeature, group => [h('span', { class: 'name' }, featureName(group.key))]),
				),
			] : h('div', { class: 'empty' },
				icon('sparkle', 22),
				h('div', { class: 'empty-title' }, t('No AI requests in {0}', monthName(summary.month))),
				h('div', { class: 'muted' }, t('Requests from the agent and commit messages are counted here as they finish.')),
			),
			h('p', { class: 'footnote' },
				t('Costs are estimates from list prices, or what the provider reports where it does (OpenRouter). Your provider\'s bill is what counts. Local models such as Ollama and LM Studio are free.'),
				' ',
				h('button', { class: 'link', onclick: () => post({ type: 'settings' }) }, t('Set your own prices')),
			),
		);
	}

	private header(data: Data): HTMLElement {
		const index = data.months.indexOf(data.summary.month);
		const older = data.months[index + 1];
		const newer = index > 0 ? data.months[index - 1] : undefined;
		const select = h('select', { class: 'month', 'aria-label': t('Month') }, data.months.map(month => {
			const option = h('option', { value: month }, monthName(month));
			option.selected = month === data.summary.month;
			return option;
		}));
		select.addEventListener('change', () => post({ type: 'month', month: select.value }));
		return h('header', { class: 'header' },
			h('div', { class: 'title' }, h('h1', null, t('AI Usage')), h('span', { class: 'muted' }, t('Tokens and estimated cost of every model request'))),
			h('div', { class: 'nav' },
				h('button', { class: 'icon-button', title: t('Previous month'), 'aria-label': t('Previous month'), disabled: !older, onclick: () => older && post({ type: 'month', month: older }) }, icon('chevron', 14, 'flip')),
				select,
				h('button', { class: 'icon-button', title: t('Next month'), 'aria-label': t('Next month'), disabled: !newer, onclick: () => newer && post({ type: 'month', month: newer }) }, icon('chevron', 14)),
			),
		);
	}

	private tiles(data: Data): HTMLElement {
		const { summary, limit } = data;
		const days = summary.days.length;
		const elapsed = data.current ? new Date(data.now).getDate() : days;
		const projected = summary.cost / Math.max(1, elapsed) * days;
		const share = limit ? summary.cost / limit : 0;
		const state = !limit ? 'none' : share >= 1 ? 'over' : share >= 0.8 ? 'near' : 'ok';
		return h('section', { class: 'tiles' },
			h('div', { class: `tile hero ${state}` },
				h('div', { class: 'label' }, data.current ? t('Spent this month') : t('Spent in {0}', monthName(summary.month, 'short'))),
				h('div', { class: 'value' }, money(summary.cost)),
				limit ? [
					h('div', { class: 'meter', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': Math.round(Math.min(1, share) * 100) }, h('span', { style: `width:${Math.min(100, share * 100).toFixed(1)}%` })),
					h('div', { class: 'sub' },
						state === 'over'
							? [icon('warning', 12), data.allowedOver && data.current ? t('Over the {0} limit; allowed for the rest of this month', money(limit)) : t('Over the {0} monthly limit', money(limit))]
							: t('{0}% of the {1} monthly limit', Math.round(share * 100), money(limit)),
						' ',
						h('button', { class: 'link', onclick: () => post({ type: 'editLimit' }) }, t('Change')),
					),
				] : h('div', { class: 'sub' }, t('No monthly limit.'), ' ', h('button', { class: 'link', onclick: () => post({ type: 'editLimit' }) }, t('Set a limit'))),
				summary.unpriced > 0 && h('div', { class: 'sub warn' }, icon('warning', 12), t('{0} requests to models without a known price are not counted.', summary.unpriced)),
			),
			h('div', { class: 'tile' },
				h('div', { class: 'label' }, data.current ? t('On pace for') : t('Average per day')),
				h('div', { class: 'value' }, data.current ? money(projected) : money(summary.cost / days)),
				h('div', { class: 'sub' }, data.current ? t('at {0} a day so far', money(summary.cost / Math.max(1, elapsed))) : t('over {0} days', days)),
			),
			h('div', { class: 'tile' },
				h('div', { class: 'label' }, t('Requests')),
				h('div', { class: 'value' }, summary.requests.toLocaleString()),
				h('div', { class: 'sub' }, t('{0} tokens in, {1} out', tokens(summary.input), tokens(summary.output))),
			),
		);
	}

	private chart(data: Data): HTMLElement {
		const { summary } = data;
		const today = data.current ? new Date(data.now).getDate() : summary.days.length + 1;
		const max = Math.max(...summary.days, 0.01);
		// A round top for the axis: 1, 2 or 5 times a power of ten.
		const magnitude = 10 ** Math.floor(Math.log10(max));
		const top = [1, 2, 5, 10].map(m => m * magnitude).find(v => v >= max) ?? max;
		const width = 720;
		const height = 160;
		const left = 44;
		const bottom = 22;
		const plot = height - bottom - 8;
		const slot = (width - left) / summary.days.length;
		const bar = Math.max(3, Math.min(18, slot - 2));
		const chart = svg('svg', { viewBox: `0 0 ${width} ${height}`, class: 'chart', role: 'img', 'aria-label': t('Spending per day in {0}', monthName(summary.month)) });
		for (const fraction of [0, 0.5, 1]) {
			const y = 8 + plot * (1 - fraction);
			chart.append(svg('line', { x1: left, x2: width, y1: y, y2: y, class: fraction ? 'grid' : 'axis' }));
			const label = svg('text', { x: left - 8, y: y + 4, class: 'tick', 'text-anchor': 'end' });
			label.textContent = money(top * fraction).replace('.00', '');
			chart.append(label);
		}
		summary.days.forEach((cost, index) => {
			const day = index + 1;
			const x = left + index * slot + (slot - bar) / 2;
			const barHeight = cost > 0 ? Math.max(2, cost / top * plot) : 0;
			const y = 8 + plot - barHeight;
			const future = day > today;
			if (barHeight) {
				// Rounded at the data end only, square on the baseline.
				const r = Math.min(4, bar / 2, barHeight);
				chart.append(svg('path', { class: day === today ? 'bar today' : 'bar', d: `M${x},${8 + plot}V${y + r}a${r},${r} 0 0 1 ${r},${-r}h${bar - 2 * r}a${r},${r} 0 0 1 ${r},${r}V${8 + plot}Z` }));
			}
			if (day === 1 || day % 5 === 0 || day === today) {
				const label = svg('text', { x: x + bar / 2, y: height - 6, class: future ? 'tick future' : 'tick', 'text-anchor': 'middle' });
				label.textContent = String(day);
				chart.append(label);
			}
			const hit = svg('rect', { x: left + index * slot, y: 0, width: slot, height: height - bottom, class: 'hit' });
			const date = new Date(Number(summary.month.slice(0, 4)), Number(summary.month.slice(5)) - 1, day).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
			hit.addEventListener('mouseenter', () => this.showTooltip(hit, date, future ? '' : money(cost)));
			hit.addEventListener('mouseleave', () => { this.tooltip.hidden = true; });
			chart.append(hit);
		});
		return h('section', { class: 'card' }, h('h2', null, t('Spending per Day')), chart);
	}

	private showTooltip(target: Element, title: string, value: string): void {
		fill(this.tooltip, h('div', { class: 'tooltip-title' }, title), value && h('div', { class: 'tooltip-value' }, value));
		this.tooltip.hidden = false;
		const rect = target.getBoundingClientRect();
		const tip = this.tooltip.getBoundingClientRect();
		const x = Math.min(window.innerWidth - tip.width - 8, Math.max(8, rect.left + rect.width / 2 - tip.width / 2));
		this.tooltip.style.left = `${x + window.scrollX}px`;
		this.tooltip.style.top = `${Math.max(4, rect.top + window.scrollY - tip.height + 12)}px`;
	}

	private table(title: string, groups: UsageGroup[], cells: (group: UsageGroup) => Child[], extra?: (group: UsageGroup) => Child, empty?: string): HTMLElement {
		const total = groups.reduce((sum, g) => sum + g.cost, 0);
		return h('section', { class: 'card' },
			h('h2', null, title),
			groups.length ? h('table', null,
				h('thead', null, h('tr', null,
					h('th', null, ''),
					h('th', { class: 'num' }, t('Requests')),
					h('th', { class: 'num' }, t('Tokens in')),
					h('th', { class: 'num' }, t('Tokens out')),
					h('th', { class: 'num' }, t('Cost')),
				)),
				h('tbody', null, groups.map(group => h('tr', null,
					h('td', null, h('div', { class: 'cell-main' }, cells(group), extra?.(group)), total > 0 && h('div', { class: 'share' }, h('span', { style: `width:${(group.cost / total * 100).toFixed(1)}%` }))),
					h('td', { class: 'num' }, group.requests.toLocaleString()),
					h('td', { class: 'num' }, tokens(group.input)),
					h('td', { class: 'num' }, tokens(group.output)),
					h('td', { class: 'num strong' }, group.unpriced === group.requests ? '—' : money(group.cost)),
				))),
			) : h('div', { class: 'muted' }, empty ?? ''),
		);
	}
}

new UsagePage();
