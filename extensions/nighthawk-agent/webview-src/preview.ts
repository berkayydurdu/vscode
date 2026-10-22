/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { PickerCommand, PickerMessage, PreviewHostMessage, PreviewPageMessage } from '../src/core/preview';
import { fill, h, icon } from './dom';
import { setBundle, t } from './l10n';

declare function acquireVsCodeApi(): { postMessage(message: PreviewPageMessage): void };

const vscode = acquireVsCodeApi();
const post = (message: PreviewPageMessage) => vscode.postMessage(message);

/** The preview's proxy, set by the extension in the page itself; the frame only ever shows pages from it. */
const proxyOrigin = document.body.dataset.proxy ?? '';
let picking = false;
let errors = 0;
let toastTimer: ReturnType<typeof setTimeout> | undefined;
let current = '/';

const frame = h('iframe', { class: 'page', title: 'Preview', allow: 'clipboard-read; clipboard-write; fullscreen' });
const address = h('input', {
	class: 'address',
	spellcheck: 'false',
	'aria-label': 'Address',
	onKeydown: (event: KeyboardEvent) => {
		if (event.key === 'Enter') {
			post({ type: 'navigate', url: address.value });
		}
	},
});
const reload = h('button', { class: 'tool', onClick: () => load(current) });
const pick = h('button', { class: 'tool pick', onClick: () => setPicking(!picking) });
const errorButton = h('button', { class: 'tool errors', hidden: true, onClick: () => post({ type: 'sendErrors' }) });
const external = h('button', { class: 'tool', onClick: () => post({ type: 'openExternal' }) });
const toast = h('div', { class: 'toast', role: 'status' });
const hint = h('div', { class: 'hint', hidden: true });

/** Shows a page of the dev server, by its path on the proxy. */
function load(pagePath: string): void {
	if (!pagePath.startsWith('/') || pagePath.startsWith('//')) {
		return;
	}
	current = pagePath;
	errors = 0;
	renderErrors();
	setPicking(false);
	frame.src = 'about:blank';
	frame.src = `${proxyOrigin}${pagePath}`;
}

function command(message: PickerCommand): void {
	frame.contentWindow?.postMessage(message, proxyOrigin || '*');
}

function setPicking(on: boolean): void {
	picking = on;
	pick.classList.toggle('active', on);
	pick.setAttribute('aria-pressed', String(on));
	hint.hidden = !on;
	command({ type: 'nighthawk:pick', on });
}

function renderErrors(): void {
	errorButton.hidden = errors === 0;
	fill(errorButton, icon('error', 14), String(errors));
	errorButton.title = t('{0} console errors. Click to send them to the agent.', errors);
}

function showToast(text: string): void {
	toast.textContent = text;
	toast.classList.add('shown');
	clearTimeout(toastTimer);
	toastTimer = setTimeout(() => toast.classList.remove('shown'), 2600);
}

function labels(): void {
	fill(reload, icon('refresh'));
	reload.title = t('Reload');
	fill(pick, icon('pointer'), h('span', null, t('Pick Element')));
	pick.title = t('Pick an element on the page to tell the agent about it');
	fill(external, icon('external'));
	external.title = t('Open in Browser');
	fill(hint, t('Click an element to add it to the agent. Escape cancels.'));
	address.setAttribute('aria-label', t('Address'));
}

window.addEventListener('message', event => {
	// From the page in the frame: only that window, from the proxy.
	if (event.source === frame.contentWindow) {
		if (!proxyOrigin || event.origin !== proxyOrigin) {
			return;
		}
		const message = event.data as PickerMessage;
		switch (message?.type) {
			case 'nighthawk:ready':
				post({ type: 'page', url: message.url, title: message.title });
				if (picking) {
					command({ type: 'nighthawk:pick', on: true });
				}
				return;
			case 'nighthawk:picked':
				post({ type: 'picked', element: message.element });
				return;
			case 'nighthawk:pickEnded':
				picking = false;
				pick.classList.remove('active');
				hint.hidden = true;
				return;
			case 'nighthawk:console':
				if (message.entry.level === 'error') {
					errors++;
					renderErrors();
				}
				post({ type: 'console', entry: message.entry });
				return;
		}
		return;
	}
	// From the extension, relayed by the webview host, which shares this page's origin.
	if (event.origin !== window.origin) {
		return;
	}
	const message = event.data as PreviewHostMessage;
	switch (message?.type) {
		case 'load':
			setBundle(message.l10n ?? undefined);
			labels();
			address.value = message.url;
			load(message.path);
			return;
		case 'reload':
			load(current);
			return;
		case 'address':
			if (document.activeElement !== address) {
				address.value = message.url;
			}
			return;
		case 'pick':
			setPicking(message.on);
			return;
		case 'added':
			showToast(t('Added {0} to the agent', message.label));
			return;
	}
});

labels();
document.body.append(
	h('div', { class: 'bar' }, reload, address, errorButton, pick, external),
	h('div', { class: 'stage' }, frame, hint, toast),
);
post({ type: 'ready' });
