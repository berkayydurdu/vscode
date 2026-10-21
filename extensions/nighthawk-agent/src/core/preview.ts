/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Live preview: the user's dev server shown in an editor tab through a small
// local proxy that adds a script to its pages. The script lets the user pick
// an element and reports console errors, so the agent can be told "make
// @preview:1 bigger" and know which element, which component and which file.

/** The path the proxy serves the in-page script at. */
export const PICKER_PATH = '/__nighthawk/preview.js';

/** Ports dev servers usually listen on, tried when looking for a running one. */
export const DEV_PORTS = [3000, 3001, 4173, 4200, 4321, 5000, 5173, 5174, 6006, 8000, 8080, 8081];

/** What the in-page script reports about a picked element. */
export interface PickedElement {
	/** The page it was on. */
	url: string;
	selector: string;
	tag: string;
	text: string;
	/** The element's markup, shortened. */
	html: string;
	attributes: Record<string, string>;
	/** A few computed styles that usually matter for a change. */
	styles: Record<string, string>;
	rect: { x: number; y: number; width: number; height: number };
	/** Component names from the framework, innermost first, e.g. ["Button", "Toolbar", "App"]. */
	components: string[];
	/** Where the framework says the element or its component is defined, e.g. "src/Button.tsx:12". */
	source?: string;
}

export interface ConsoleEntry {
	level: 'error' | 'warn';
	text: string;
	time: number;
}

/** Messages between the in-page script and the preview tab, sent with postMessage. */
export type PickerMessage =
	| { type: 'nighthawk:ready'; url: string; title: string }
	| { type: 'nighthawk:picked'; element: PickedElement }
	| { type: 'nighthawk:pickEnded' }
	| { type: 'nighthawk:console'; entry: ConsoleEntry };

/** Messages from the preview tab to the in-page script. */
export type PickerCommand = { type: 'nighthawk:pick'; on: boolean };

/** Messages from the extension to the preview tab. */
export type PreviewHostMessage =
	| { type: 'load'; path: string; url: string; l10n?: Record<string, string> }
	| { type: 'reload' }
	| { type: 'address'; url: string }
	| { type: 'pick'; on: boolean }
	| { type: 'added'; label: string };

/** Messages from the preview tab to the extension. */
export type PreviewPageMessage =
	| { type: 'ready' }
	| { type: 'navigate'; url: string }
	| { type: 'picked'; element: PickedElement }
	| { type: 'console'; entry: ConsoleEntry }
	| { type: 'page'; url: string; title: string }
	| { type: 'sendErrors' }
	| { type: 'openExternal' };

/** Adds the picker script to a page, as early as possible so it sees the page's first errors. */
export function injectScript(html: string): string {
	const tag = `<script src="${PICKER_PATH}"></script>`;
	const head = /<head(?:\s[^>]*)?>/i.exec(html);
	if (head) {
		return html.slice(0, head.index + head[0].length) + tag + html.slice(head.index + head[0].length);
	}
	const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
	return doctype ? doctype[0] + tag + html.slice(doctype[0].length) : tag + html;
}

/** A URL the user typed as one the preview can open: localhost:3000 becomes http://localhost:3000/. */
export function previewUrl(raw: string): URL | undefined {
	const text = raw.trim();
	if (!text) {
		return undefined;
	}
	const withScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(text) ? text : /^\d+$/.test(text) ? `http://localhost:${text}` : `http://${text}`;
	try {
		const url = new URL(withScheme);
		return url.protocol === 'http:' || url.protocol === 'https:' ? url : undefined;
	} catch {
		return undefined;
	}
}

/** The address on the dev server for a request the proxy received, or undefined when it would leave the server. */
export function targetFor(requestPath: string, target: URL): URL | undefined {
	if (!requestPath.startsWith('/') || requestPath.startsWith('//')) {
		return undefined;
	}
	const url = new URL(requestPath, target.origin);
	return url.origin === target.origin ? url : undefined;
}

/** A redirect to the dev server turned into one to the proxy, so the page stays in the preview. */
export function rewriteLocation(location: string, target: URL, proxyOrigin: string): string {
	try {
		const url = new URL(location, target.origin);
		return url.origin === target.origin ? proxyOrigin + url.pathname + url.search + url.hash : location;
	} catch {
		return location;
	}
}

/** The dev server address of a page the proxy shows. */
export function pageUrl(proxied: string, target: URL): string {
	try {
		const url = new URL(proxied);
		return target.origin + url.pathname + url.search + url.hash;
	} catch {
		return proxied;
	}
}

/** A short name for an element, like `button.primary` or `h1#title`. */
export function elementLabel(element: PickedElement): string {
	const id = element.attributes.id ? `#${element.attributes.id}` : '';
	const classes = (element.attributes.class ?? '').split(/\s+/).filter(Boolean).slice(0, 2).map(c => `.${c}`).join('');
	const component = element.components[0] ? `<${element.components[0]}> ` : '';
	return `${component}${element.tag}${id}${classes}`;
}

/** What the agent is told about a picked element. */
export function elementContext(element: PickedElement, errors: ConsoleEntry[]): string {
	const lines = [
		`<element page="${element.url}">`,
		`Selector: ${element.selector}`,
	];
	if (element.components.length) {
		lines.push(`Components (innermost first): ${element.components.join(' < ')}`);
	}
	if (element.source) {
		lines.push(`Defined at: ${element.source}`);
	}
	if (element.text) {
		lines.push(`Text: ${JSON.stringify(element.text)}`);
	}
	lines.push(`Size: ${Math.round(element.rect.width)}x${Math.round(element.rect.height)} at ${Math.round(element.rect.x)},${Math.round(element.rect.y)}`);
	const styles = Object.entries(element.styles).map(([name, value]) => `${name}: ${value}`).join('; ');
	if (styles) {
		lines.push(`Computed styles: ${styles}`);
	}
	lines.push('Markup:', element.html);
	if (errors.length) {
		lines.push('Recent console errors on this page:', ...errors.slice(-5).map(e => `- ${e.text}`));
	}
	lines.push('</element>');
	lines.push(element.source
		? 'The user picked this element in the live preview. Change it in the source file above; find related code with Grep for the component name or text.'
		: 'The user picked this element in the live preview. Find its source with Grep or CodebaseSearch for its text, classes or component names, then change it there.');
	return lines.join('\n');
}

/** What the agent is told about the page's console errors. */
export function errorsContext(url: string, errors: ConsoleEntry[]): string {
	if (!errors.length) {
		return `<console page="${url}">No errors or warnings so far.</console>`;
	}
	return `<console page="${url}">\n${errors.slice(-20).map(e => `[${e.level}] ${e.text}`).join('\n')}\n</console>`;
}
