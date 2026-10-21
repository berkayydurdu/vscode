/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { InlineEditHostMessage, InlineEditPageMessage } from '../src/core/inlineEdit';
import { fill, h, icon } from './dom';
import { setBundle, t } from './l10n';

declare function acquireVsCodeApi(): { postMessage(message: InlineEditPageMessage): void };

const vscode = acquireVsCodeApi();
const post = (message: InlineEditPageMessage) => vscode.postMessage(message);

type State = Extract<InlineEditHostMessage, { type: 'state' }>;

/** Lines the edit replaced, shown above the new code in the editor's font. */
interface RemovedMessage {
	type: 'removed';
	lines: string[];
	lineHeight: number;
	fontSize: number;
	tabSize: number;
}

/** The box above the code: the request, then progress, then Accept, Reject and a follow-up. */
class EditBox {
	private state: State = { type: 'state', phase: 'prompt', insert: false };
	private history: string[] = [];
	private historyIndex = -1;
	private keys = { accept: 'Ctrl+Enter', reject: 'Ctrl+Backspace' };
	private readonly input = h('textarea', {
		rows: 1,
		spellcheck: 'false',
		'aria-label': 'Instruction',
		onInput: () => {
			this.historyIndex = -1;
			this.updateButtons();
		},
	});
	private readonly model = h('button', { class: 'model', title: '', onClick: () => post({ type: 'pickModel' }) });
	private readonly actions = h('div', { class: 'actions' });
	private readonly status = h('div', { class: 'status' });
	private readonly root = h('div', { class: 'frame' },
		h('div', { class: 'row' }, icon('sparkle', 16, 'lead'), this.input, this.model, this.actions),
		this.status,
	);

	constructor() {
		document.body.append(this.root);
		// On the whole page, so the keys work when a button has focus too.
		document.addEventListener('keydown', e => this.onKey(e));
		this.render();
	}

	update(state: State): void {
		if (state.l10n) {
			setBundle(state.l10n);
		}
		if (state.history) {
			this.history = state.history;
		}
		if (state.keys) {
			this.keys = state.keys;
		}
		const was = this.state.phase;
		this.state = state;
		if (was !== state.phase && state.phase === 'review') {
			// The box now asks for follow-ups; the instruction moves to the status line.
			this.input.value = '';
		}
		if (was === 'generating' && state.phase === 'prompt' && !this.input.value) {
			this.input.value = state.instruction ?? '';
		}
		this.render();
	}

	focus(): void {
		this.input.focus();
		this.input.setSelectionRange(this.input.value.length, this.input.value.length);
	}

	private render(): void {
		const { phase, insert } = this.state;
		this.root.className = `frame ${phase}`;
		// Read-only rather than disabled, so the box keeps the keyboard focus while the code is written.
		this.input.readOnly = phase === 'generating';
		this.input.placeholder = phase === 'review'
			? t('Ask for a change')
			: insert ? t('Describe the code to write') : t('Describe how to change the selected code');
		if (phase === 'generating') {
			this.input.value = this.state.instruction ?? this.input.value;
		}
		this.input.setAttribute('aria-label', this.input.placeholder);
		fill(this.model, this.state.model ?? t('Connect a model'), icon('chevron', 12, 'down'));
		this.model.title = t('Model for inline edits. Click to change.');
		this.updateButtons();
		this.renderStatus();
	}

	private updateButtons(): void {
		const { phase } = this.state;
		const button = (label: string, title: string, onClick: () => void, className = '') =>
			h('button', { class: `action ${className}`.trim(), title, onClick }, label);
		const hasText = !!this.input.value.trim();
		switch (phase) {
			case 'generating':
				fill(this.actions, button(t('Stop'), t('Stop writing (Escape)'), () => post({ type: 'cancel' })));
				break;
			case 'review':
				fill(this.actions,
					hasText && button(t('Send'), t('Ask for this change (Enter)'), () => this.submit()),
					button(t('Accept'), t('Keep the changes ({0})', this.keys.accept), () => post({ type: 'accept' }), hasText ? '' : 'primary'),
					button(t('Reject'), t('Undo the changes ({0})', this.keys.reject), () => post({ type: 'reject' })),
				);
				break;
			default:
				fill(this.actions,
					button(t('Generate'), t('Send (Enter)'), () => this.submit(), hasText ? 'primary' : 'primary disabled'),
					h('button', { class: 'close', title: t('Close (Escape)'), 'aria-label': t('Close'), onClick: () => post({ type: 'close' }) }, icon('x', 14)),
				);
		}
	}

	private renderStatus(): void {
		const s = this.state;
		const hint = (text: string) => h('span', { class: 'hint' }, text);
		switch (s.phase) {
			case 'generating':
				fill(this.status, h('span', { class: 'spinner' }), s.lines ? t('Writing... {0} lines', s.lines) : t('Thinking...'), hint(t('Escape to stop')));
				break;
			case 'review':
				fill(this.status,
					h('span', { class: 'added' }, `+${s.added ?? 0}`),
					h('span', { class: 'removed' }, `\u2212${s.removed ?? 0}`),
					h('span', { class: 'instruction', title: s.instruction ?? '' }, s.instruction ?? ''),
					s.error ? h('span', { class: 'warn' }, s.error) : hint(s.changes && s.changes > 1 ? t('{0} changes, {1} accepts all', s.changes, this.keys.accept) : t('{0} accept, {1} reject', this.keys.accept, this.keys.reject)),
				);
				break;
			case 'error':
				fill(this.status, icon('error', 13, 'err'), h('span', { class: 'error' }, s.error ?? t('Something went wrong.')), hint(t('Enter to try again')));
				break;
			default:
				fill(this.status, hint(this.history.length ? t('Enter to send, Up for earlier requests, Escape to close') : t('Enter to send, Shift+Enter for a new line, Escape to close')));
		}
	}

	private submit(): void {
		const text = this.input.value.trim();
		if (text && this.state.phase !== 'generating') {
			post({ type: 'submit', text });
		}
	}

	private onKey(e: KeyboardEvent): void {
		const phase = this.state.phase;
		const mod = e.ctrlKey || e.metaKey;
		if (e.key === 'Enter' && mod && phase === 'review') {
			e.preventDefault();
			post({ type: 'accept' });
		} else if (e.key === 'Backspace' && mod && phase === 'review' && !this.input.value) {
			e.preventDefault();
			post({ type: 'reject' });
		} else if (e.key === 'Enter' && !e.shiftKey && !mod && e.target === this.input) {
			e.preventDefault();
			this.submit();
		} else if (e.key === 'Escape') {
			e.preventDefault();
			post(phase === 'generating' ? { type: 'cancel' } : phase === 'review' ? { type: 'focusEditor' } : { type: 'close' });
		} else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && e.target === this.input && phase !== 'review' && phase !== 'generating' && this.history.length && !this.input.value.slice(0, this.input.selectionStart).includes('\n')) {
			const next = this.historyIndex + (e.key === 'ArrowUp' ? 1 : -1);
			if (next >= -1 && next < this.history.length) {
				e.preventDefault();
				this.historyIndex = next;
				this.input.value = next === -1 ? '' : this.history[next];
				this.updateButtons();
			}
		}
	}
}

function showRemoved(message: RemovedMessage): void {
	document.body.style.setProperty('--line-height', `${message.lineHeight}px`);
	document.body.style.setProperty('--code-size', `${message.fontSize}px`);
	document.body.style.setProperty('--tab-size', String(message.tabSize));
	fill(document.body, h('div', { class: 'lines' }, message.lines.map(line => h('div', { class: 'line' }, line || ' '))));
}

const box = document.body.classList.contains('box') ? new EditBox() : undefined;

window.addEventListener('message', event => {
	// The extension's messages are relayed by the webview host, which shares this page's origin.
	if (event.origin !== window.origin) {
		return;
	}
	const message = event.data as InlineEditHostMessage | RemovedMessage;
	switch (message.type) {
		case 'state':
			box?.update(message);
			break;
		case 'focus':
			box?.focus();
			break;
		case 'removed':
			showRemoved(message);
			break;
	}
});

post({ type: 'ready' });
