/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export type Child = Node | string | number | false | null | undefined | Child[];
type Attrs = Record<string, unknown> & { class?: string | Record<string, boolean | undefined>; style?: string };

/**
 * Creates an element. `on*` attributes become event listeners, `class` may
 * be a map of class name to condition, and false/null children are skipped.
 */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs?: Attrs | null, ...children: Child[]): HTMLElementTagNameMap[K] {
	const el = document.createElement(tag);
	for (const [key, value] of Object.entries(attrs ?? {})) {
		if (value === undefined || value === null || value === false) {
			continue;
		}
		if (key.startsWith('on') && typeof value === 'function') {
			el.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
		} else if (key === 'class' && typeof value === 'object') {
			el.className = Object.entries(value as Record<string, boolean>).filter(([, on]) => on).map(([name]) => name).join(' ');
		} else if (key === 'value' && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) {
			// Both, so a field can tell whether it was edited since.
			el.defaultValue = String(value);
			el.value = String(value);
		} else if (key === 'html') {
			el.innerHTML = String(value);
		} else if (Reflect.has(el, key) && key !== 'list' && key !== 'style') {
			(el as unknown as Record<string, unknown>)[key] = value;
		} else {
			el.setAttribute(key, value === true ? '' : String(value));
		}
	}
	append(el, children);
	return el;
}

function append(el: Element, children: Child[]): void {
	for (const child of children) {
		if (Array.isArray(child)) {
			append(el, child);
		} else if (child instanceof Node) {
			el.appendChild(child);
		} else if (child !== false && child !== null && child !== undefined) {
			el.appendChild(document.createTextNode(String(child)));
		}
	}
}

/** Replaces an element's children, skipping false and null like `h` does. */
export function fill(el: Element, ...children: Child[]): void {
	clear(el);
	append(el, children);
}

export function clear(el: Element): void {
	while (el.firstChild) {
		el.removeChild(el.firstChild);
	}
}

/** Inline SVG icons, drawn on a 16px grid with currentColor. */
const ICON_PATHS: Record<string, string> = {
	board: '<rect x="2" y="2.5" width="3.5" height="11" rx="1"/><rect x="6.25" y="2.5" width="3.5" height="7" rx="1"/><rect x="10.5" y="2.5" width="3.5" height="9" rx="1"/>',
	list: '<path d="M5 4h9M5 8h9M5 12h9"/><circle cx="2.5" cy="4" r=".8"/><circle cx="2.5" cy="8" r=".8"/><circle cx="2.5" cy="12" r=".8"/>',
	user: '<circle cx="8" cy="5.5" r="2.75"/><path d="M2.75 14c.6-2.6 2.7-4 5.25-4s4.65 1.4 5.25 4"/>',
	clock: '<circle cx="8" cy="8" r="6"/><path d="M8 4.5V8l2.5 1.5"/>',
	doc: '<path d="M4 1.75h5.25L12.5 5v9.25H4z"/><path d="M9 1.75V5.25h3.5M6 8h4.5M6 10.5h4.5"/>',
	plus: '<path d="M8 3v10M3 8h10"/>',
	close: '<path d="M4 4l8 8M12 4l-8 8"/>',
	search: '<circle cx="7" cy="7" r="4.25"/><path d="M10.25 10.25L14 14"/>',
	check: '<path d="M3 8.5l3 3 7-7"/>',
	trash: '<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 9h5.8l.6-9"/>',
	comment: '<path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z"/>',
	calendar: '<rect x="2.5" y="3.5" width="11" height="10" rx="1.5"/><path d="M2.5 6.5h11M5.5 2v3M10.5 2v3"/>',
	tag: '<path d="M2.5 2.5h5.25l6 6-5.25 5.25-6-6z"/><circle cx="5.25" cy="5.25" r=".9"/>',
	bug: '<rect x="4.5" y="5" width="7" height="8" rx="3.5"/><path d="M8 5v8M2.5 8h2M11.5 8h2M3 4.5l2 1.5M13 4.5l-2 1.5M3 12.5l2-1M13 12.5l-2-1M6 3.5l.75 1.5M10 3.5l-.75 1.5"/>',
	task: '<rect x="2.5" y="2.5" width="11" height="11" rx="2.5"/><path d="M5.25 8.25l2 2 3.5-4"/>',
	rfc: '<path d="M4 1.75h5.25L12.5 5v9.25H4z"/><path d="M9 1.75V5.25h3.5"/><circle cx="8.25" cy="9.5" r="1.75"/>',
	chevronLeft: '<path d="M10 3L5 8l5 5"/>',
	chevronRight: '<path d="M6 3l5 5-5 5"/>',
	approve: '<circle cx="8" cy="8" r="6"/><path d="M5.25 8.25l2 2 3.5-4"/>',
	changes: '<circle cx="8" cy="8" r="6"/><path d="M8 4.75v4M8 11v.25"/>',
	more: '<circle cx="3.5" cy="8" r=".9"/><circle cx="8" cy="8" r=".9"/><circle cx="12.5" cy="8" r=".9"/>',
	sync: '<path d="M13 6.5A5 5 0 0 0 3.6 5M3 9.5A5 5 0 0 0 12.4 11"/><path d="M3.5 2.5V5H6M12.5 13.5V11H10"/>',
	people: '<circle cx="6" cy="5.5" r="2.25"/><path d="M1.75 13.5c.5-2.2 2.2-3.4 4.25-3.4s3.75 1.2 4.25 3.4"/><circle cx="11.5" cy="5" r="1.75"/><path d="M11 9.75c1.7 0 3 .9 3.4 2.75"/>',
};

export function icon(name: keyof typeof ICON_PATHS | string, size = 16): SVGElement {
	const wrapper = document.createElement('span');
	wrapper.innerHTML = `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON_PATHS[name] ?? ''}</svg>`;
	return wrapper.firstChild as SVGElement;
}

// --- people

const AVATAR_HUES = [210, 340, 160, 30, 270, 190, 0, 120, 50, 300];

function hash(value: string): number {
	let result = 0;
	for (let i = 0; i < value.length; i++) {
		result = (result * 31 + value.charCodeAt(i)) | 0;
	}
	return Math.abs(result);
}

export function initials(name: string): string {
	const parts = name.trim().split(/\s+/).filter(Boolean);
	return ((parts[0]?.[0] ?? '?') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

export function avatar(person: { userId: string; name: string } | undefined, size: 'sm' | 'md' | 'lg' = 'sm'): HTMLElement {
	if (!person) {
		return h('span', { class: `avatar avatar-${size} avatar-empty`, title: 'Unassigned' }, icon('user', size === 'lg' ? 16 : 12));
	}
	const hue = AVATAR_HUES[hash(person.userId) % AVATAR_HUES.length];
	return h('span', { class: `avatar avatar-${size}`, title: person.name, style: `--avatar-hue: ${hue}` }, initials(person.name));
}

export function avatarStack(people: { userId: string; name: string }[], max = 3): HTMLElement {
	const shown = people.slice(0, max);
	return h('span', { class: 'avatar-stack' },
		shown.map(p => avatar(p)),
		people.length > max ? h('span', { class: 'avatar avatar-sm avatar-more' }, `+${people.length - max}`) : null,
	);
}

// --- time

/** `90` -> `1h 30m` */
export function formatMinutes(minutes: number): string {
	if (minutes <= 0) {
		return '0m';
	}
	const hours = Math.floor(minutes / 60);
	const rest = minutes % 60;
	return hours && rest ? `${hours}h ${rest}m` : hours ? `${hours}h` : `${rest}m`;
}

/** Hours as a short number for timesheet cells: `90` -> `1.5`. */
export function formatHours(minutes: number): string {
	if (!minutes) {
		return '';
	}
	const hours = minutes / 60;
	return Number.isInteger(hours) ? String(hours) : hours.toFixed(2).replace(/0+$/, '');
}

/**
 * Reads durations the way people type them: `1h 30m`, `1.5h`, `90m`,
 * `1:30`, or a bare number of hours. Returns minutes, or undefined.
 */
export function parseDuration(text: string, bareUnit: 'h' | 'm' = 'h'): number | undefined {
	const value = text.trim().toLowerCase().replace(',', '.');
	if (!value) {
		return 0;
	}
	const clock = /^(\d+):([0-5]?\d)$/.exec(value);
	if (clock) {
		return Number(clock[1]) * 60 + Number(clock[2]);
	}
	if (/^\d+(\.\d+)?$/.test(value)) {
		return Math.round(Number(value) * (bareUnit === 'h' ? 60 : 1));
	}
	const parts = /^(?:(\d+(?:\.\d+)?)\s*(?:h|hr|hrs|hours?))?\s*(?:(\d+)\s*(?:m|min|mins|minutes?))?$/.exec(value);
	if (parts && (parts[1] || parts[2])) {
		return Math.round(Number(parts[1] ?? 0) * 60 + Number(parts[2] ?? 0));
	}
	return undefined;
}

export function isoDate(date: Date): string {
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function parseIsoDate(value: string): Date {
	const [y, m, d] = value.split('-').map(Number);
	return new Date(y, m - 1, d);
}

export function addDays(date: Date, days: number): Date {
	const result = new Date(date);
	result.setDate(result.getDate() + days);
	return result;
}

/** Monday of the week containing `date`. */
export function startOfWeek(date: Date): Date {
	const result = new Date(date.getFullYear(), date.getMonth(), date.getDate());
	result.setDate(result.getDate() - ((result.getDay() + 6) % 7));
	return result;
}

export function shortDate(value: string | number | Date): string {
	const date = typeof value === 'string' ? parseIsoDate(value) : new Date(value);
	return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function timeAgo(timestamp: number): string {
	const seconds = Math.round((Date.now() - timestamp) / 1000);
	if (seconds < 60) {
		return 'just now';
	}
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) {
		return `${minutes}m ago`;
	}
	const hours = Math.round(minutes / 60);
	if (hours < 24) {
		return `${hours}h ago`;
	}
	const days = Math.round(hours / 24);
	return days < 7 ? `${days}d ago` : shortDate(timestamp);
}

// --- markdown

function escapeHtml(text: string): string {
	return text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' })[c]!);
}

function inline(text: string): string {
	return escapeHtml(text)
		.replace(/`([^`]+)`/g, '<code>$1</code>')
		.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
		.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
		.replace(/~~([^~]+)~~/g, '<del>$1</del>')
		.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, target: string, label?: string) => `<a class="wikilink" href="#" data-note="${target}">${label ?? target}</a>`)
		.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>');
}

/**
 * Renders the Markdown people write in descriptions, RFCs and comments:
 * headings, lists, task lists, quotes, code blocks, tables and rules.
 * Everything is escaped first, so the output is safe to insert.
 */
export function renderMarkdown(source: string): string {
	const lines = source.replace(/\r\n/g, '\n').split('\n');
	const out: string[] = [];
	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		if (/^\s*```/.test(line)) {
			const code: string[] = [];
			i++;
			while (i < lines.length && !/^\s*```/.test(lines[i])) {
				code.push(lines[i++]);
			}
			i++;
			out.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
			continue;
		}
		const heading = /^(#{1,4})\s+(.*)$/.exec(line);
		if (heading) {
			out.push(`<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`);
			i++;
			continue;
		}
		if (/^\s*(---|\*\*\*)\s*$/.test(line)) {
			out.push('<hr>');
			i++;
			continue;
		}
		if (/^\s*>/.test(line)) {
			const quote: string[] = [];
			while (i < lines.length && /^\s*>/.test(lines[i])) {
				quote.push(lines[i++].replace(/^\s*>\s?/, ''));
			}
			out.push(`<blockquote>${renderMarkdown(quote.join('\n'))}</blockquote>`);
			continue;
		}
		if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
			const cells = (row: string) => row.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
			const head = cells(line);
			i += 2;
			const rows: string[][] = [];
			while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
				rows.push(cells(lines[i++]));
			}
			out.push(`<table><thead><tr>${head.map(c => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${r.map(c => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
			continue;
		}
		const listMatch = /^\s*([-*+]|\d+\.)\s+/.exec(line);
		if (listMatch) {
			const ordered = /\d/.test(listMatch[1]);
			const items: string[] = [];
			while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i])) {
				const text = lines[i++].replace(/^\s*([-*+]|\d+\.)\s+/, '');
				const task = /^\[( |x|X)\]\s+(.*)$/.exec(text);
				items.push(task
					? `<li class="task"><span class="md-check${task[1] === ' ' ? '' : ' done'}"></span>${inline(task[2])}</li>`
					: `<li>${inline(text)}</li>`);
			}
			out.push(ordered ? `<ol>${items.join('')}</ol>` : `<ul>${items.join('')}</ul>`);
			continue;
		}
		if (!line.trim()) {
			i++;
			continue;
		}
		const paragraph: string[] = [];
		while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|\s*```|\s*>|\s*([-*+]|\d+\.)\s+|\s*\|)/.test(lines[i])) {
			paragraph.push(inline(lines[i++]));
		}
		if (!paragraph.length) {
			paragraph.push(inline(lines[i++]));
		}
		out.push(`<p>${paragraph.join('<br>')}</p>`);
	}
	return out.join('');
}

/** A short plain-text excerpt of Markdown, for cards. */
export function excerpt(source: string, length = 140): string {
	const text = source
		.replace(/```[\s\S]*?```/g, ' ')
		.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, target: string, label?: string) => label ?? target)
		.replace(/^#{1,6}\s+.*$/gm, ' ')
		.replace(/^\s*(?:[-*+]|\d+\.)\s+(?:\[[ xX]\]\s+)?/gm, '')
		.replace(/^\s*>\s?/gm, '')
		.replace(/^\s*\|?[\s:|-]+\|?\s*$/gm, ' ')
		.replace(/\*\*|__|~~|`|\|/g, ' ')
		.replace(/\s+([,.;:!?])/g, '$1')
		.replace(/\s+/g, ' ')
		.trim();
	return text.length > length ? text.slice(0, length).trimEnd() + '…' : text;
}

export function newId(): string {
	return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}
