/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Renders the Markdown models write straight into DOM nodes. Text always
// stays text: nothing here is ever parsed as HTML.

import { h, icon, type Child } from './dom';
import { t } from './l10n';

const INLINE = /`(?<code>[^`\n]+)`|\*\*(?<strong>[^*\n]+?)\*\*|__(?<strong2>[^_\n]+?)__|(?<![\w*])\*(?<em>[^*\n]+?)\*(?!\w)|(?<![\w_])_(?<em2>[^_\n]+?)_(?![\w_])|~~(?<del>[^~\n]+)~~|\[(?<text>[^\]\n]+)\]\((?<url>[^)\s]+)\)|(?<auto>https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g;

/** Inline code that names a file, like `src/app.ts` or `src/app.ts:42`, becomes a link. */
const FILE_REF = /^(?<path>(?:[A-Za-z]:[\\/])?[\w.@~-]*(?:[\\/][\w.@~ -]+)*\.[A-Za-z0-9]{1,10})(?::(?<line>\d+)(?::\d+)?)?$/;

function inline(text: string): Child[] {
	const out: Child[] = [];
	let last = 0;
	for (const match of text.matchAll(INLINE)) {
		if (match.index > last) {
			out.push(text.slice(last, match.index));
		}
		const g = match.groups!;
		if (g.code !== undefined) {
			const ref = FILE_REF.exec(g.code);
			if (ref && (g.code.includes('/') || g.code.includes('\\') || ref.groups!.line)) {
				out.push(h('code', { class: 'file-link', 'data-path': ref.groups!.path, 'data-line': ref.groups!.line ?? '', title: t('Open {0}', g.code) }, g.code));
			} else {
				out.push(h('code', null, g.code));
			}
		} else if (g.strong !== undefined || g.strong2 !== undefined) {
			out.push(h('strong', null, inline(g.strong ?? g.strong2)));
		} else if (g.em !== undefined || g.em2 !== undefined) {
			out.push(h('em', null, inline(g.em ?? g.em2)));
		} else if (g.del !== undefined) {
			out.push(h('del', null, inline(g.del)));
		} else if (g.text !== undefined) {
			out.push(/^https?:\/\//.test(g.url) ? h('a', { href: g.url, title: g.url }, inline(g.text)) : linkOrText(g.text, g.url));
		} else if (g.auto !== undefined) {
			out.push(h('a', { href: g.auto }, g.auto));
		}
		last = match.index + match[0].length;
	}
	if (last < text.length) {
		out.push(text.slice(last));
	}
	return out;
}

/** A relative link in Markdown usually points at a file in the workspace. */
function linkOrText(text: string, url: string): Child {
	const ref = /^(?<path>[^#]+?)(?:#L?(?<line>\d+))?$/.exec(url);
	if (ref) {
		return h('a', { class: 'file-link', href: '#', 'data-path': decodeURIComponent(ref.groups!.path), 'data-line': ref.groups!.line ?? '' }, inline(text));
	}
	return text;
}

function codeBlock(code: string, language: string): HTMLElement {
	const copy = h('button', { class: 'icon-button code-copy', title: t('Copy'), 'aria-label': t('Copy') }, icon('copy', 14));
	copy.addEventListener('click', () => {
		navigator.clipboard.writeText(code).then(() => {
			copy.classList.add('done');
			setTimeout(() => copy.classList.remove('done'), 1200);
		});
	});
	return h('div', { class: 'code-block' },
		h('div', { class: 'code-head' }, h('span', { class: 'code-lang' }, language || t('text')), copy),
		h('pre', null, h('code', null, code)));
}

interface ListItem {
	indent: number;
	ordered: boolean;
	text: string;
	start?: number;
}

function buildList(items: ListItem[]): HTMLElement {
	const first = items[0];
	const list = first.ordered ? h('ol', first.start && first.start !== 1 ? { start: first.start } : null) : h('ul');
	let i = 0;
	while (i < items.length) {
		const item = items[i];
		const nested: ListItem[] = [];
		let j = i + 1;
		while (j < items.length && items[j].indent > item.indent) {
			nested.push(items[j++]);
		}
		const task = /^\[(?<mark> |x|X)\]\s+(?<text>.*)$/.exec(item.text);
		const li = task
			? h('li', { class: 'task' }, icon(task.groups!.mark === ' ' ? 'circle' : 'circleCheck', 14, 'task-mark'), inline(task.groups!.text))
			: h('li', null, inline(item.text));
		if (nested.length) {
			li.append(buildList(nested));
		}
		list.append(li);
		i = j;
	}
	return list;
}

const LIST_ITEM = /^(?<indent>\s*)(?<marker>[-*+]|(?<num>\d+)[.)])\s+(?<text>.*)$/;
const BLOCK_START = /^(#{1,6}\s|\s*```|\s*~~~|\s*>|\s*([-*+]|\d+[.)])\s+|\s*\|.*\|\s*$|\s*(---|\*\*\*|___)\s*$)/;

/** Renders Markdown into `container`. Unclosed code fences (still streaming) render as code. */
export function renderMarkdown(source: string, container: HTMLElement): void {
	const lines = source.replace(/\r\n/g, '\n').split('\n');
	const out: Node[] = [];
	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		const fence = /^\s*(```|~~~)\s*([\w+#.-]*)/.exec(line);
		if (fence) {
			const code: string[] = [];
			i++;
			while (i < lines.length && !new RegExp(`^\\s*${fence[1]}\\s*$`).test(lines[i])) {
				code.push(lines[i++]);
			}
			i++;
			out.push(codeBlock(code.join('\n'), fence[2]));
			continue;
		}
		const heading = /^(?<hashes>#{1,6})\s+(?<text>.*?)\s*#*$/.exec(line);
		if (heading) {
			const level = Math.min(heading.groups!.hashes.length + 1, 6);
			out.push(h(`h${level}` as 'h2', null, inline(heading.groups!.text)));
			i++;
			continue;
		}
		if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) {
			out.push(h('hr'));
			i++;
			continue;
		}
		if (/^\s*>/.test(line)) {
			const quote: string[] = [];
			while (i < lines.length && /^\s*>/.test(lines[i])) {
				quote.push(lines[i++].replace(/^\s*>\s?/, ''));
			}
			const block = h('blockquote');
			renderMarkdown(quote.join('\n'), block);
			out.push(block);
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
			out.push(h('div', { class: 'table-wrap' }, h('table', null,
				h('thead', null, h('tr', null, head.map(c => h('th', null, inline(c))))),
				h('tbody', null, rows.map(r => h('tr', null, r.map(c => h('td', null, inline(c)))))))));
			continue;
		}
		if (LIST_ITEM.test(line)) {
			const items: ListItem[] = [];
			while (i < lines.length) {
				const match = LIST_ITEM.exec(lines[i]);
				if (match) {
					const g = match.groups!;
					items.push({ indent: g.indent.replace(/\t/g, '    ').length, ordered: g.num !== undefined, text: g.text, start: g.num ? Number(g.num) : undefined });
					i++;
				} else if (lines[i].trim() && /^\s{2,}\S/.test(lines[i]) && items.length) {
					// A wrapped continuation of the previous item.
					items[items.length - 1].text += ` ${lines[i++].trim()}`;
				} else {
					break;
				}
			}
			out.push(buildList(items));
			continue;
		}
		if (!line.trim()) {
			i++;
			continue;
		}
		const paragraph: Child[] = [];
		while (i < lines.length && lines[i].trim() && (!paragraph.length || !BLOCK_START.test(lines[i]))) {
			if (paragraph.length) {
				paragraph.push(h('br'));
			}
			paragraph.push(inline(lines[i++]));
		}
		out.push(h('p', null, paragraph));
	}
	container.replaceChildren();
	for (const node of out) {
		container.append(node);
	}
}
