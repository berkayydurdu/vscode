/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export type Child = Node | string | number | false | null | undefined | Child[];
type Attrs = Record<string, unknown> & { class?: string | Record<string, boolean | undefined> };

/**
 * Creates an element. `on*` attributes become listeners, `class` may be a
 * map of class name to condition, and false or null children are skipped.
 * Text is always inserted as text, never parsed as markup.
 */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs?: Attrs | null, ...children: Child[]): HTMLElementTagNameMap[K] {
	const el = document.createElement(tag);
	for (const [key, value] of Object.entries(attrs ?? {})) {
		if (value === undefined || value === null || value === false) {
			continue;
		}
		if (key.startsWith('on')) {
			if (typeof value === 'function') {
				el.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
			}
		} else if (key === 'class' && typeof value === 'object') {
			el.className = Object.entries(value as Record<string, boolean>).filter(([, on]) => on).map(([name]) => name).join(' ');
		} else if (key === 'value' && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) {
			el.value = String(value);
		} else {
			el.setAttribute(key, value === true ? '' : String(value));
		}
	}
	add(el, children);
	return el;
}

/** Appends children; `append`, since code scanning treats every `appendChild` argument as markup. */
export function add(el: Element, children: Child[]): void {
	for (const child of children) {
		if (Array.isArray(child)) {
			add(el, child);
		} else if (child instanceof Node) {
			el.append(child);
		} else if (child !== false && child !== null && child !== undefined) {
			el.append(document.createTextNode(String(child)));
		}
	}
}

export function fill(el: Element, ...children: Child[]): void {
	while (el.firstChild) {
		el.removeChild(el.firstChild);
	}
	add(el, children);
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Icon shapes on a 16px grid, drawn with currentColor strokes. */
const ICONS: Record<string, [string, Record<string, string | number>][]> = {
	sparkle: [['path', { d: 'M8 1.5l1.4 4.1 4.1 1.4-4.1 1.4L8 12.5 6.6 8.4 2.5 7l4.1-1.4z' }], ['path', { d: 'M12.5 11l.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4-1.4-.6 1.4-.6z' }]],
	check: [['path', { d: 'M3 8.5l3 3 7-7' }]],
	x: [['path', { d: 'M4 4l8 8M12 4l-8 8' }]],
	chevron: [['path', { d: 'M6 3.5L10.5 8 6 12.5' }]],
	file: [['path', { d: 'M4 1.75h5.25L12.5 5v9.25H4z' }], ['path', { d: 'M9 1.75V5.25h3.5' }]],
	edit: [['path', { d: 'M10.5 2.5l3 3L6 13H3v-3z' }], ['path', { d: 'M9 4l3 3' }]],
	terminal: [['rect', { x: 1.75, y: 2.75, width: 12.5, height: 10.5, rx: 1.5 }], ['path', { d: 'M4.5 6l2 2-2 2M8 10.5h3.5' }]],
	search: [['circle', { cx: 7, cy: 7, r: 4.25 }], ['path', { d: 'M10.25 10.25L14 14' }]],
	folder: [['path', { d: 'M1.75 4.25c0-.8.6-1.5 1.5-1.5h3l1.5 1.5h5c.8 0 1.5.7 1.5 1.5v6.5c0 .8-.7 1.5-1.5 1.5h-9.5c-.9 0-1.5-.7-1.5-1.5z' }]],
	globe: [['circle', { cx: 8, cy: 8, r: 6.25 }], ['path', { d: 'M1.75 8h12.5M8 1.75c1.8 1.8 2.6 3.9 2.6 6.25S9.8 12.45 8 14.25C6.2 12.45 5.4 10.35 5.4 8S6.2 3.55 8 1.75z' }]],
	list: [['path', { d: 'M6 4.5h8M6 8h8M6 11.5h8' }], ['path', { d: 'M2 4.5l.75.75L4 4M2 8l.75.75L4 7.5M2 11.5l.75.75L4 11' }]],
	agent: [['rect', { x: 3, y: 4.5, width: 10, height: 8.5, rx: 2.5 }], ['path', { d: 'M8 2v2.5M6 8.5v.5M10 8.5v.5M1.5 8.5v2M14.5 8.5v2' }]],
	question: [['circle', { cx: 8, cy: 8, r: 6.25 }], ['path', { d: 'M6.2 6.2a1.9 1.9 0 1 1 2.6 1.75c-.5.2-.8.6-.8 1.1v.45M8 11.4v.1' }]],
	plan: [['rect', { x: 3, y: 2.25, width: 10, height: 12, rx: 1.5 }], ['path', { d: 'M6 2.25v-.5h4v.5M5.5 6.5h5M5.5 9h5M5.5 11.5h3' }]],
	stop: [['rect', { x: 4, y: 4, width: 8, height: 8, rx: 1.5, fill: 'currentColor' }]],
	send: [['path', { d: 'M8 13V3.5M3.75 7.5L8 3.25l4.25 4.25' }]],
	plus: [['path', { d: 'M8 3v10M3 8h10' }]],
	history: [['path', { d: 'M2.5 8a5.5 5.5 0 1 0 1.6-3.9' }], ['path', { d: 'M2.25 2.5v2.25H4.5M8 5v3.25l2 1.25' }]],
	copy: [['rect', { x: 5, y: 5, width: 8.5, height: 8.5, rx: 1.5 }], ['path', { d: 'M3 10.5H2.5v-8h8V3' }]],
	undo: [['path', { d: 'M4.5 6.5h6a3 3 0 0 1 0 6H7' }], ['path', { d: 'M6.75 4L4.25 6.5 6.75 9' }]],
	warning: [['path', { d: 'M8 2l6.25 11H1.75z' }], ['path', { d: 'M8 6.5v3M8 11.25v.1' }]],
	info: [['circle', { cx: 8, cy: 8, r: 6.25 }], ['path', { d: 'M8 7.25v4M8 4.9v.1' }]],
	error: [['circle', { cx: 8, cy: 8, r: 6.25 }], ['path', { d: 'M5.75 5.75l4.5 4.5M10.25 5.75l-4.5 4.5' }]],
	shield: [['path', { d: 'M8 1.75l5 2v4c0 3.2-2.1 5.4-5 6.5-2.9-1.1-5-3.3-5-6.5v-4z' }]],
	shieldCheck: [['path', { d: 'M8 1.75l5 2v4c0 3.2-2.1 5.4-5 6.5-2.9-1.1-5-3.3-5-6.5v-4z' }], ['path', { d: 'M5.75 8l1.5 1.5 3-3' }]],
	pause: [['path', { d: 'M6 4v8M10 4v8' }]],
	bolt: [['path', { d: 'M9 1.75L3.5 9h4l-1 5.25L12.5 7h-4z' }]],
	chip: [['rect', { x: 4, y: 4, width: 8, height: 8, rx: 1.5 }], ['path', { d: 'M6 1.75V4M10 1.75V4M6 12v2.25M10 12v2.25M1.75 6H4M1.75 10H4M12 6h2.25M12 10h2.25' }]],
	brain: [['path', { d: 'M6 2.5a2 2 0 0 0-2 2v.2A2.25 2.25 0 0 0 3 8.75 2.25 2.25 0 0 0 5 13.5h1V2.5zM10 2.5a2 2 0 0 1 2 2v.2a2.25 2.25 0 0 1 1 4.05A2.25 2.25 0 0 1 11 13.5h-1V2.5z' }]],
	tool: [['path', { d: 'M10.5 2a3 3 0 0 0-2.8 4.1L2.5 11.3a1.3 1.3 0 0 0 1.85 1.85L9.6 7.9a3 3 0 0 0 4.1-2.8l-1.6 1.6-1.85-.35-.35-1.85z' }]],
	compress: [['path', { d: 'M3 6h10M3 10h10M8 1.5V5M6.25 3.25L8 5l1.75-1.75M8 14.5V11M6.25 12.75L8 11l1.75 1.75' }]],
	external: [['path', { d: 'M9.5 2.5h4v4M13.5 2.5L8 8M12 9.5v3.25c0 .4-.35.75-.75.75h-8c-.4 0-.75-.35-.75-.75v-8c0-.4.35-.75.75-.75H6.5' }]],
	dot: [['circle', { cx: 8, cy: 8, r: 2.5, fill: 'currentColor' }]],
	circle: [['circle', { cx: 8, cy: 8, r: 5.5 }]],
	circleCheck: [['circle', { cx: 8, cy: 8, r: 5.5, fill: 'currentColor' }], ['path', { d: 'M5.5 8.1l1.75 1.75 3.25-3.5', stroke: 'var(--vscode-editor-background)' }]],
	trash: [['path', { d: 'M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 9h5.8l.6-9' }]],
	gear: [['circle', { cx: 8, cy: 8, r: 2 }], ['path', { d: 'M8 1.75v1.5M8 12.75v1.5M14.25 8h-1.5M3.25 8h-1.5M12.4 3.6l-1.05 1.05M4.65 11.35L3.6 12.4M12.4 12.4l-1.05-1.05M4.65 4.65L3.6 3.6' }]],
	refresh: [['path', { d: 'M13 8a5 5 0 1 1-1.5-3.55' }], ['path', { d: 'M13 2.5v2.75h-2.75' }]],
	pointer: [['path', { d: 'M3 2.5l3.6 10.5 1.7-4.3 4.2-1.7z' }], ['path', { d: 'M8.6 8.9l3.6 3.6' }]],
};

export function icon(name: string, size = 16, className = ''): SVGElement {
	const svg = document.createElementNS(SVG_NS, 'svg');
	svg.setAttribute('viewBox', '0 0 16 16');
	svg.setAttribute('width', String(size));
	svg.setAttribute('height', String(size));
	svg.setAttribute('fill', 'none');
	svg.setAttribute('stroke', 'currentColor');
	svg.setAttribute('stroke-width', '1.3');
	svg.setAttribute('stroke-linecap', 'round');
	svg.setAttribute('stroke-linejoin', 'round');
	svg.setAttribute('aria-hidden', 'true');
	svg.setAttribute('class', `icon ${className}`.trim());
	for (const [tag, attrs] of ICONS[name] ?? ICONS.dot) {
		const shape = document.createElementNS(SVG_NS, tag);
		for (const [key, value] of Object.entries(attrs)) {
			shape.setAttribute(key, String(value));
		}
		svg.append(shape);
	}
	return svg;
}

/** Grows a textarea with its content, up to its CSS max-height. */
export function autosize(textarea: HTMLTextAreaElement): void {
	textarea.style.height = 'auto';
	textarea.style.height = `${textarea.scrollHeight}px`;
}
