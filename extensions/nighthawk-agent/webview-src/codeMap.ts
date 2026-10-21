/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { CodeMap, CodeMapHostMessage, CodeMapPageMessage, MapItem } from '../src/core/codemap';
import { fill, h, icon } from './dom';
import { setBundle, t } from './l10n';

declare function acquireVsCodeApi(): { postMessage(message: CodeMapPageMessage): void };

const vscode = acquireVsCodeApi();
const post = (message: CodeMapPageMessage) => vscode.postMessage(message);

const SVG_NS = 'http://www.w3.org/2000/svg';
const root = h('div', { class: 'map' });
document.body.append(root);

let map: CodeMap | undefined;
let resizeFrame = 0;

function where(item: MapItem): string {
	return `${item.file}:${item.line}${item.endLine && item.endLine !== item.line ? `-${item.endLine}` : ''}`;
}

function open(item: MapItem): void {
	post({ type: 'open', file: item.file, line: item.line, endLine: item.endLine });
}

/** Lights up an item, its arrows and its outline entry while the pointer is on it. */
function highlight(id: string | undefined): void {
	for (const el of root.querySelectorAll<HTMLElement | SVGElement>('[data-item], [data-from]')) {
		const related = id !== undefined && (el.dataset.item === id || el.dataset.from === id || el.dataset.to === id);
		el.classList.toggle('lit', related);
		el.classList.toggle('dim', id !== undefined && !related);
	}
}

function render(): void {
	if (!map) {
		return;
	}
	const actions = h('div', { class: 'actions' },
		h('button', { class: 'button', onClick: () => post({ type: 'followUp' }) }, icon('agent', 14), t('Ask a Follow-up')),
		h('button', { class: 'button secondary', onClick: () => post({ type: 'copy' }) }, icon('copy', 14), t('Copy as Markdown')),
		h('button', { class: 'button secondary', onClick: () => post({ type: 'regenerate' }) }, icon('refresh', 14), t('Draw Again')),
	);
	const header = h('header', null,
		h('div', { class: 'eyebrow' }, t('Code map')),
		h('h1', null, map.title),
		map.question !== map.title ? h('p', { class: 'question' }, map.question) : null,
		map.summary ? h('p', { class: 'summary' }, map.summary) : null,
		actions,
	);

	const diagram = h('div', { class: 'diagram' });
	const columns = h('div', { class: 'columns' });
	map.sections.forEach((section, index) => {
		columns.append(h('div', { class: 'column' },
			h('div', { class: 'column-title' }, h('span', { class: 'step' }, String(index + 1)), section.title),
			...section.items.map(item => h('button', {
				class: 'node',
				'data-item': item.id,
				title: item.note,
				onClick: () => open(item),
				onMouseenter: () => highlight(item.id),
				onMouseleave: () => highlight(undefined),
			}, h('span', { class: 'node-name' }, item.symbol ?? item.file.split('/').pop() ?? item.file), h('span', { class: 'node-where' }, where(item)))),
		));
	});
	const svg = document.createElementNS(SVG_NS, 'svg');
	svg.setAttribute('class', 'edges');
	svg.setAttribute('aria-hidden', 'true');
	diagram.append(svg, columns);

	const outline = h('div', { class: 'outline' }, ...map.sections.map((section, index) => h('section', null,
		h('h2', null, h('span', { class: 'step' }, String(index + 1)), section.title),
		section.description ? h('p', { class: 'description' }, section.description) : null,
		h('ol', null, ...section.items.map(item => h('li', {
			'data-item': item.id,
			onMouseenter: () => highlight(item.id),
			onMouseleave: () => highlight(undefined),
		},
			h('button', { class: 'location', onClick: () => open(item) }, item.symbol ? h('code', null, item.symbol) : null, h('span', { class: 'where' }, where(item))),
			h('p', null, item.note),
		))),
	)));

	fill(root, header, diagram, outline);
	requestAnimationFrame(drawEdges);
}

/** Draws the arrows between the nodes once the columns are laid out. */
function drawEdges(): void {
	const svg = root.querySelector<SVGSVGElement>('.edges');
	const diagram = root.querySelector<HTMLElement>('.diagram');
	if (!map || !svg || !diagram) {
		return;
	}
	while (svg.firstChild) {
		svg.removeChild(svg.firstChild);
	}
	const box = diagram.getBoundingClientRect();
	svg.setAttribute('width', String(diagram.scrollWidth));
	svg.setAttribute('height', String(diagram.scrollHeight));
	const defs = document.createElementNS(SVG_NS, 'defs');
	const marker = document.createElementNS(SVG_NS, 'marker');
	for (const [name, value] of Object.entries({ id: 'arrow', viewBox: '0 0 8 8', refX: '7', refY: '4', markerWidth: '7', markerHeight: '7', orient: 'auto-start-reverse' })) {
		marker.setAttribute(name, value);
	}
	const tip = document.createElementNS(SVG_NS, 'path');
	tip.setAttribute('d', 'M0 0L8 4L0 8z');
	tip.setAttribute('class', 'arrowhead');
	marker.append(tip);
	defs.append(marker);
	svg.append(defs);
	const rect = (id: string) => {
		const node = diagram.querySelector<HTMLElement>(`.node[data-item="${CSS.escape(id)}"]`);
		if (!node) {
			return undefined;
		}
		const r = node.getBoundingClientRect();
		return { left: r.left - box.left + diagram.scrollLeft, right: r.right - box.left + diagram.scrollLeft, top: r.top - box.top, bottom: r.bottom - box.top, middle: (r.top + r.bottom) / 2 - box.top };
	};
	for (const edge of map.flow) {
		const from = rect(edge.from);
		const to = rect(edge.to);
		if (!from || !to) {
			continue;
		}
		let d: string;
		let labelAt: [number, number];
		if (to.left > from.right) {
			const bend = Math.max(24, (to.left - from.right) / 2);
			d = `M${from.right} ${from.middle} C${from.right + bend} ${from.middle} ${to.left - bend} ${to.middle} ${to.left - 2} ${to.middle}`;
			labelAt = [(from.right + to.left) / 2, (from.middle + to.middle) / 2 - 6];
		} else if (from.left > to.right) {
			const bend = Math.max(24, (from.left - to.right) / 2);
			d = `M${from.left} ${from.middle} C${from.left - bend} ${from.middle} ${to.right + bend} ${to.middle} ${to.right + 2} ${to.middle}`;
			labelAt = [(from.left + to.right) / 2, (from.middle + to.middle) / 2 - 6];
		} else {
			// Same column: loop around its right side.
			const x = Math.max(from.right, to.right);
			d = `M${from.right} ${from.middle} C${x + 36} ${from.middle} ${x + 36} ${to.middle} ${to.right + 2} ${to.middle}`;
			labelAt = [x + 30, (from.middle + to.middle) / 2];
		}
		const path = document.createElementNS(SVG_NS, 'path');
		path.setAttribute('d', d);
		path.setAttribute('class', 'edge');
		path.setAttribute('marker-end', 'url(#arrow)');
		path.dataset.from = edge.from;
		path.dataset.to = edge.to;
		svg.append(path);
		if (edge.label) {
			const label = document.createElementNS(SVG_NS, 'text');
			label.setAttribute('x', String(labelAt[0]));
			label.setAttribute('y', String(labelAt[1]));
			label.setAttribute('class', 'edge-label');
			label.setAttribute('text-anchor', 'middle');
			label.dataset.from = edge.from;
			label.dataset.to = edge.to;
			label.textContent = edge.label;
			svg.append(label);
		}
	}
}

window.addEventListener('resize', () => {
	cancelAnimationFrame(resizeFrame);
	resizeFrame = requestAnimationFrame(drawEdges);
});

window.addEventListener('message', event => {
	const message = event.data as CodeMapHostMessage;
	if (message?.type === 'map') {
		setBundle(message.l10n);
		map = message.map;
		render();
	}
});

post({ type: 'ready' });
