/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { HostMessage, MentionResult, PageMessage, PermissionModeId, SessionSummary, SlashCommandInfo, ToolDisplay, TranscriptItem, ViewState } from '../src/core/protocol';
import { autosize, fill, h, icon, type Child } from './dom';
import { setBundle, t } from './l10n';
import { renderMarkdown } from './markdown';

declare function acquireVsCodeApi(): { postMessage(message: PageMessage): void; getState(): unknown; setState(state: unknown): void };

const vscode = acquireVsCodeApi();
const post = (message: PageMessage) => vscode.postMessage(message);

type ToolItem = Extract<TranscriptItem, { kind: 'tool' }>;

const MODES: { id: PermissionModeId; label: () => string; icon: string; hint: () => string }[] = [
	{ id: 'default', label: () => t('Ask before edits'), icon: 'shield', hint: () => t('Edits and commands ask for approval first.') },
	{ id: 'acceptEdits', label: () => t('Auto-accept edits'), icon: 'shieldCheck', hint: () => t('Edits run without asking; commands still ask.') },
	{ id: 'plan', label: () => t('Plan mode'), icon: 'plan', hint: () => t('Read only: researches and proposes a plan first.') },
	{ id: 'bypassPermissions', label: () => t('Full auto'), icon: 'bolt', hint: () => t('Everything runs without asking.') },
];

const TOOL_ICONS: Record<string, string> = {
	Read: 'file', Write: 'edit', Edit: 'edit', MultiEdit: 'edit', LS: 'folder', Glob: 'search', Grep: 'search',
	Bash: 'terminal', BashOutput: 'terminal', KillBash: 'terminal', TodoWrite: 'list', WebFetch: 'globe',
	Task: 'agent', Skill: 'sparkle', AskUserQuestion: 'question', ExitPlanMode: 'plan', Diagnostics: 'warning',
};

const WORKING_WORDS = ['Working', 'Thinking', 'Reasoning', 'Pondering', 'Crafting', 'Tinkering', 'Figuring it out', 'Connecting the dots'];

interface PageState {
	expanded: string[];
	draft: string;
	sent: string[];
}

class App {
	private state: ViewState = { configured: false, mode: 'default', running: false, todos: [], commands: [], queued: 0, title: '' };
	private items: TranscriptItem[] = [];
	private readonly elements = new Map<string, HTMLElement>();
	private readonly expanded: Set<string>;
	private readonly collapsedByUser = new Set<string>();
	private sent: string[];
	private historyIndex = -1;
	private sessions: SessionSummary[] = [];

	private readonly transcript = h('div', { class: 'transcript', role: 'log', 'aria-live': 'polite' });
	private readonly scroller = h('div', { class: 'scroller' }, this.transcript);
	private readonly working = h('div', { class: 'working' });
	private readonly todos = h('div', { class: 'todos' });
	private readonly input = h('textarea', { class: 'input', rows: 1, spellcheck: 'true', 'aria-label': t('Message the agent') });
	private readonly popup = h('div', { class: 'popup', role: 'listbox', hidden: true });
	private readonly toolbar = h('div', { class: 'toolbar' });
	private readonly composer = h('div', { class: 'composer' }, this.popup, h('div', { class: 'input-box' }, this.input, this.toolbar));
	private stickToBottom = true;
	private renderQueued = new Set<string>();
	private frame = 0;
	private runStarted = 0;
	private workingTimer = 0;
	private popupItems: { label: string; detail?: string; apply: () => void }[] = [];
	private popupIndex = 0;
	private mentionRequest = 0;
	private mentionTimer = 0;

	constructor() {
		const saved = (vscode.getState() ?? {}) as Partial<PageState>;
		this.expanded = new Set(saved.expanded ?? []);
		this.sent = saved.sent ?? [];
		this.input.value = saved.draft ?? '';
		document.body.append(h('div', { class: 'app' }, this.scroller, h('div', { class: 'bottom' }, this.todos, this.composer)));
		this.scroller.addEventListener('scroll', () => {
			this.stickToBottom = this.scroller.scrollHeight - this.scroller.scrollTop - this.scroller.clientHeight < 40;
		});
		this.input.addEventListener('input', () => {
			autosize(this.input);
			this.historyIndex = -1;
			this.updatePopup();
			this.saveState();
			this.renderToolbar();
		});
		this.input.addEventListener('keydown', e => this.onKey(e));
		this.input.addEventListener('blur', () => setTimeout(() => this.closePopup(), 150));
		document.addEventListener('click', e => this.onDocumentClick(e));
		document.addEventListener('keydown', e => {
			if (e.key === 'Escape' && this.state.running && document.activeElement !== this.input) {
				post({ type: 'stop' });
			}
		});
		window.addEventListener('message', e => {
			// The extension's messages are relayed by the webview host, which shares this page's origin.
			if (e.origin === window.origin) {
				this.onMessage(e.data as HostMessage);
			}
		});
		this.render();
		post({ type: 'ready' });
	}

	private saveState(): void {
		vscode.setState({ expanded: [...this.expanded].slice(-200), draft: this.input.value, sent: this.sent.slice(-50) } satisfies PageState);
	}

	// --- messages from the extension

	private onMessage(message: HostMessage): void {
		switch (message.type) {
			case 'init':
				setBundle(message.l10n);
				this.state = message.state;
				this.items = message.items;
				this.render();
				this.scrollToBottom(true);
				if (!this.items.length) {
					post({ type: 'history' });
				}
				break;
			case 'state': {
				const wasRunning = this.state.running;
				this.state = message.state;
				if (this.state.running && !wasRunning) {
					this.runStarted = Date.now();
				}
				if (this.state.running !== wasRunning) {
					// Message actions such as restoring a checkpoint only work while the agent is idle.
					this.render();
				} else {
					this.renderChrome();
				}
				break;
			}
			case 'items':
				this.items = message.items;
				this.render();
				break;
			case 'upsert':
				this.upsert(message.item);
				break;
			case 'append':
				this.append(message.id, message.field, message.text);
				break;
			case 'sessions':
				this.sessions = message.sessions;
				if (!this.items.length) {
					this.render();
				}
				break;
			case 'mentions':
				if (message.requestId === this.mentionRequest) {
					this.showMentions(message.results);
				}
				break;
			case 'prefill':
				this.input.value = message.append && this.input.value.trim() ? `${this.input.value.replace(/\s*$/, ' ')}${message.text}` : message.text;
				autosize(this.input);
				this.input.focus();
				this.input.setSelectionRange(this.input.value.length, this.input.value.length);
				this.saveState();
				break;
			case 'focus':
				this.input.focus();
				break;
		}
	}

	private upsert(item: TranscriptItem): void {
		const index = this.items.findIndex(i => i.id === item.id);
		if (index >= 0) {
			this.items[index] = item;
		} else {
			this.items.push(item);
		}
		const parent = item.kind === 'tool' ? item.parent : undefined;
		if (parent) {
			this.scheduleRender(parent);
			return;
		}
		if (index < 0) {
			if (this.items.length === 1) {
				this.render();
				return;
			}
			const el = this.renderItem(item);
			this.elements.set(item.id, el);
			this.transcript.append(el);
			this.scrollToBottom();
		} else {
			this.scheduleRender(item.id);
		}
		if (item.kind === 'tool' && item.status === 'awaiting') {
			this.renderWorking();
		}
	}

	private append(id: string, field: 'text' | 'output', text: string): void {
		const item = this.items.find(i => i.id === id) as Record<string, unknown> | undefined;
		if (!item || (field !== 'text' && field !== 'output')) {
			return;
		}
		item[field] = String(item[field] ?? '') + text;
		const parent = (item as { parent?: string }).parent;
		this.scheduleRender(parent ?? id);
	}

	/** Re-renders items at most once per frame, which keeps streaming smooth. */
	private scheduleRender(id: string): void {
		this.renderQueued.add(id);
		if (!this.frame) {
			this.frame = requestAnimationFrame(() => {
				this.frame = 0;
				const ids = [...this.renderQueued];
				this.renderQueued.clear();
				for (const queued of ids) {
					const item = this.items.find(i => i.id === queued);
					const old = this.elements.get(queued);
					if (item && old) {
						const el = this.renderItem(item);
						this.elements.set(queued, el);
						old.replaceWith(el);
					}
				}
				this.scrollToBottom();
			});
		}
	}

	private scrollToBottom(force = false): void {
		if (force || this.stickToBottom) {
			this.scroller.scrollTop = this.scroller.scrollHeight;
		}
	}

	// --- rendering

	private render(): void {
		this.elements.clear();
		const top = this.items.filter(i => !(i.kind === 'tool' && i.parent));
		if (!top.length) {
			fill(this.transcript, this.renderEmpty());
		} else {
			fill(this.transcript, top.map(item => {
				const el = this.renderItem(item);
				this.elements.set(item.id, el);
				return el;
			}));
		}
		this.renderChrome();
		this.scrollToBottom();
	}

	private renderChrome(): void {
		this.renderWorking();
		this.renderTodos();
		this.renderToolbar();
		const empty = this.transcript.querySelector('.empty');
		if (empty && !this.items.length) {
			empty.replaceWith(this.renderEmpty());
		}
	}

	private renderEmpty(): HTMLElement {
		const suggestions: { label: string; text: string }[] = [
			{ label: t('Explain how this project is put together'), text: t('Give me a tour of this codebase: what it does, how it is structured and where to start.') },
			{ label: t('Find and fix a bug'), text: t('There is a bug: ') },
			{ label: t('/init: write project instructions'), text: '/init' },
			{ label: t('/review: review my changes'), text: '/review' },
		];
		const recent = this.sessions.slice(0, 5);
		return h('div', { class: 'empty' },
			h('div', { class: 'empty-logo' }, icon('sparkle', 28)),
			h('h1', null, t('What should we build?')),
			h('p', { class: 'muted' }, t('Describe a change, a bug or a question. The agent reads your code, edits files and runs commands, and asks before anything risky.')),
			!this.state.configured && h('div', { class: 'connect' },
				h('div', { class: 'connect-title' }, icon('chip', 16), t('Connect a model to get started')),
				h('p', { class: 'muted' }, t('Use Anthropic, OpenAI, OpenRouter, Gemini, DeepSeek, Groq, a local Ollama or LM Studio, or any OpenAI-compatible API. Keys stay in your OS keychain.')),
				h('button', { class: 'button primary', onclick: () => post({ type: 'action', action: 'addEndpoint' }) }, t('Add Model Endpoint'))),
			this.state.configured && h('div', { class: 'suggestions' }, suggestions.map(s => h('button', {
				class: 'suggestion',
				onclick: () => {
					if (s.text.startsWith('/')) {
						this.submit(s.text);
						return;
					}
					this.input.value = s.text;
					autosize(this.input);
					this.input.focus();
					this.renderToolbar();
				},
			}, s.label))),
			recent.length > 0 && h('div', { class: 'recent' },
				h('div', { class: 'section-label' }, icon('history', 14), t('Recent conversations')),
				recent.map(s => h('div', { class: 'recent-row' },
					h('button', { class: 'recent-item', title: s.title, onclick: () => post({ type: 'openSession', id: s.id }) },
						h('span', { class: 'recent-title' }, s.title),
						h('span', { class: 'recent-time' }, timeAgo(s.updated))),
					h('button', { class: 'icon-button recent-delete', title: t('Delete'), 'aria-label': t('Delete'), onclick: () => post({ type: 'deleteSession', id: s.id }) }, icon('trash', 13))))),
			h('div', { class: 'tips muted' },
				h('span', null, h('kbd', null, 'Shift+Tab'), ' ', t('modes')),
				h('span', null, h('kbd', null, '@'), ' ', t('files')),
				h('span', null, h('kbd', null, '/'), ' ', t('commands')),
				h('span', null, h('kbd', null, 'Esc'), ' ', t('stop'))));
	}

	private renderItem(item: TranscriptItem): HTMLElement {
		switch (item.kind) {
			case 'user':
				return this.renderUser(item);
			case 'assistant': {
				const el = h('div', { class: 'assistant markdown' });
				renderMarkdown(item.text, el);
				return el;
			}
			case 'thinking':
				return this.renderThinking(item);
			case 'tool':
				return this.renderTool(item);
			case 'question':
				return this.renderQuestion(item);
			case 'plan':
				return this.renderPlan(item);
			case 'notice':
				return this.renderNotice(item);
			case 'compacted':
				return this.renderCompacted(item);
		}
	}

	private renderUser(item: Extract<TranscriptItem, { kind: 'user' }>): HTMLElement {
		const bubble = this.renderUserBubble(item);
		if (!item.checkpoint) {
			return bubble;
		}
		const time = new Date(item.checkpoint.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
		return h('div', { class: 'user-turn' },
			h('div', { class: 'checkpoint' },
				h('span', { class: 'checkpoint-line' }),
				h('button', {
					class: 'checkpoint-button',
					disabled: this.state.running,
					title: this.state.running
						? t('Checkpoint from {0}. Stop the agent to restore it.', time)
						: t('Take your files back to how they were at {0} ({1}), when you sent this message', time, timeAgo(item.checkpoint.at)),
					onclick: () => post({ type: 'rewind', id: item.id }),
				}, icon('history', 12), h('span', {}, t('Checkpoint {0}', time)), h('span', { class: 'checkpoint-restore' }, t('Restore'))),
				h('span', { class: 'checkpoint-line' })),
			bubble);
	}

	private renderUserBubble(item: Extract<TranscriptItem, { kind: 'user' }>): HTMLElement {
		return h('div', { class: { user: true, queued: !!item.queued } },
			h('div', { class: 'user-text' }, highlightMentions(item.text)),
			h('div', { class: 'user-actions' },
				item.queued && h('span', { class: 'badge' }, t('queued')),
				!item.checkpoint && item.canRewind && !this.state.running && h('button', {
					class: 'icon-button', title: t('Go back to before this message (restores files the agent changed)'), 'aria-label': t('Rewind'),
					onclick: () => post({ type: 'rewind', id: item.id }),
				}, icon('undo', 14)),
				h('button', {
					class: 'icon-button', title: t('Copy'), 'aria-label': t('Copy'),
					onclick: () => navigator.clipboard.writeText(item.text),
				}, icon('copy', 14))));
	}

	private renderThinking(item: Extract<TranscriptItem, { kind: 'thinking' }>): HTMLElement {
		const open = this.expanded.has(item.id);
		const body = open ? h('div', { class: 'thinking-body markdown' }) : undefined;
		if (body) {
			renderMarkdown(item.text, body);
		}
		const preview = item.text.trim().split('\n').filter(Boolean).pop() ?? '';
		return h('div', { class: { thinking: true, live: !item.done } },
			h('button', { class: 'thinking-head', onclick: () => this.toggle(item.id), 'aria-expanded': String(open) },
				icon('brain', 14),
				h('span', { class: 'thinking-label' }, item.done ? t('Thought') : t('Thinking')),
				!open && !item.done && preview && h('span', { class: 'thinking-preview' }, preview.slice(-140)),
				icon('chevron', 12, open ? 'chevron open' : 'chevron')),
			body);
	}

	private toggle(id: string): void {
		const item = this.items.find(i => i.id === id);
		const open = this.isExpanded(item);
		if (open) {
			this.expanded.delete(id);
			this.collapsedByUser.add(id);
		} else {
			this.expanded.add(id);
			this.collapsedByUser.delete(id);
		}
		this.saveState();
		this.scheduleRender(id);
	}

	private isExpanded(item: TranscriptItem | undefined): boolean {
		if (!item) {
			return false;
		}
		if (this.expanded.has(item.id)) {
			return true;
		}
		if (this.collapsedByUser.has(item.id)) {
			return false;
		}
		if (item.kind !== 'tool') {
			return false;
		}
		// Changes, failures and questions for the user open by default.
		return item.status === 'awaiting'
			|| (item.display?.kind === 'diff' && item.status !== 'denied')
			|| (item.status === 'running' && (item.name === 'Bash' || item.name === 'Task'))
			|| (item.status === 'error' && item.name === 'Bash');
	}

	private renderTool(item: ToolItem): HTMLElement {
		const open = this.isExpanded(item);
		const children = this.items.filter((i): i is ToolItem => i.kind === 'tool' && i.parent === item.id);
		const [verb, ...rest] = item.title.split(' ');
		const statusIcon = item.status === 'running' ? h('span', { class: 'spinner', 'aria-label': t('Running') })
			: item.status === 'awaiting' ? icon('pause', 14, 'status-awaiting')
				: item.status === 'done' ? icon('check', 14, 'status-done')
					: icon('x', 14, item.status === 'denied' ? 'status-denied' : 'status-error');
		const head = h('button', { class: 'tool-head', onclick: () => this.toggle(item.id), 'aria-expanded': String(open) },
			h('span', { class: 'tool-status' }, statusIcon),
			icon(TOOL_ICONS[item.name] ?? (item.name.startsWith('mcp__') ? 'tool' : 'tool'), 14, 'tool-icon'),
			h('span', { class: 'tool-title' }, h('strong', null, verb), rest.length ? ` ${rest.join(' ')}` : ''),
			item.summary && h('span', { class: { 'tool-summary': true, bad: item.status === 'error' || item.status === 'denied' } }, item.summary),
			icon('chevron', 12, open ? 'chevron open' : 'chevron'));
		const sub = item.name === 'Bash' && item.detail ? h('div', { class: 'tool-command', title: item.detail }, h('span', { class: 'prompt' }, '$'), item.detail.split('\n')[0]) : undefined;
		const body: Child[] = [];
		if (open) {
			if (item.detail && item.name !== 'Bash' && item.name !== 'Task') {
				body.push(h('pre', { class: 'tool-detail' }, item.detail));
			}
			if (item.name === 'Bash' && item.detail?.includes('\n')) {
				body.push(h('pre', { class: 'tool-detail' }, item.detail));
			}
			if (item.name === 'Task' && item.detail) {
				body.push(h('div', { class: 'task-prompt' }, item.detail));
			}
			if (children.length) {
				body.push(h('div', { class: 'children' }, children.map(c => this.renderChild(c))));
			}
			if (item.display) {
				body.push(this.renderDisplay(item, item.display));
			} else if (item.output) {
				body.push(h('pre', { class: 'tool-output' }, item.output));
			}
		} else if (children.length && item.status === 'running') {
			const last = children[children.length - 1];
			body.push(h('div', { class: 'children' }, this.renderChild(last)));
		}
		if (item.approval) {
			body.push(this.renderApproval(item));
		}
		return h('div', { class: { tool: true, [`status-${item.status}`]: true, open } },
			head, sub, body.length > 0 && h('div', { class: 'tool-body' }, body));
	}

	private renderChild(item: ToolItem): HTMLElement {
		const statusIcon = item.status === 'running' ? h('span', { class: 'spinner small' })
			: item.status === 'awaiting' ? icon('pause', 12, 'status-awaiting')
				: item.status === 'done' ? icon('check', 12, 'status-done') : icon('x', 12, 'status-error');
		const row = h('div', { class: 'child' }, statusIcon, icon(TOOL_ICONS[item.name] ?? 'tool', 12, 'tool-icon'), h('span', { class: 'child-title' }, item.title), item.summary && h('span', { class: 'tool-summary' }, item.summary));
		return item.approval || item.status === 'awaiting'
			? h('div', { class: 'child-wrap' }, row, item.display && this.renderDisplay(item, item.display), item.name === 'Bash' && item.detail && h('pre', { class: 'tool-detail' }, item.detail), this.renderApproval(item))
			: row;
	}

	private renderDisplay(item: ToolItem, display: ToolDisplay): HTMLElement {
		switch (display.kind) {
			case 'diff':
				return this.renderDiff(item, display);
			case 'output':
				return h('pre', { class: { 'tool-output': true, error: display.exitCode !== 0 && display.exitCode !== undefined } }, display.text || t('(no output)'));
			case 'files':
				return h('div', { class: 'files' }, display.files.slice(0, 50).map(f => h('button', { class: 'file-row', onclick: () => post({ type: 'openFile', path: f }) }, icon('file', 12), f)),
					display.files.length > 50 && h('div', { class: 'muted' }, t('{0} more', display.files.length - 50)));
			case 'text': {
				const el = h('div', { class: 'tool-text markdown' });
				renderMarkdown(display.text, el);
				return el;
			}
		}
	}

	private renderDiff(item: ToolItem, display: Extract<ToolDisplay, { kind: 'diff' }>): HTMLElement {
		const rows: HTMLElement[] = [];
		display.diff.hunks.forEach((hunk, index) => {
			if (index > 0) {
				rows.push(h('div', { class: 'diff-gap' }, '\u22ef'));
			}
			for (const line of hunk.lines) {
				rows.push(h('div', { class: `diff-line ${line.kind === '+' ? 'add' : line.kind === '-' ? 'del' : 'ctx'}` },
					h('span', { class: 'diff-num' }, String(line.line)),
					h('span', { class: 'diff-sign' }, line.kind === ' ' ? '' : line.kind),
					h('span', { class: 'diff-text' }, line.text || ' ')));
			}
		});
		return h('div', { class: 'diff' },
			h('div', { class: 'diff-head' },
				h('button', { class: 'link', onclick: () => post({ type: 'openFile', path: display.path }) }, display.path),
				display.created && h('span', { class: 'badge' }, t('new file')),
				h('span', { class: 'diff-stats' }, h('span', { class: 'add' }, `+${display.diff.added}`), ' ', h('span', { class: 'del' }, `-${display.diff.removed}`)),
				item.canOpenDiff && h('button', { class: 'icon-button', title: t('Open in diff editor'), 'aria-label': t('Open in diff editor'), onclick: () => post({ type: 'openDiff', id: item.id }) }, icon('external', 13))),
			rows.length ? h('div', { class: 'diff-body' }, rows) : h('div', { class: 'muted diff-empty' }, t('(empty file)')));
	}

	private renderApproval(item: ToolItem): HTMLElement {
		const question = item.name === 'Bash' ? t('Run this command?')
			: ['Edit', 'MultiEdit'].includes(item.name) ? t('Make this edit?')
				: item.name === 'Write' ? t('Write this file?')
					: item.name === 'WebFetch' ? t('Fetch this page?')
						: item.name.startsWith('mcp__') ? t('Use this tool?')
							: item.approval?.outside ? t('Access files outside the workspace?') : t('Allow this?');
		const feedback = h('input', { class: 'feedback', type: 'text', placeholder: t('Or tell the agent what to do instead, then press Enter') });
		feedback.addEventListener('keydown', e => {
			if (e.key === 'Enter' && feedback.value.trim()) {
				post({ type: 'approve', id: item.id, decision: 'deny', feedback: feedback.value.trim() });
			}
		});
		return h('div', { class: 'approval' },
			h('div', { class: 'approval-question' }, question),
			item.approval?.outside && h('div', { class: 'approval-warning' }, icon('warning', 14), t('This touches files outside the workspace.')),
			h('div', { class: 'approval-actions' },
				h('button', { class: 'button primary', onclick: () => post({ type: 'approve', id: item.id, decision: 'allow' }) }, t('Allow')),
				h('button', { class: 'button', onclick: () => post({ type: 'approve', id: item.id, decision: 'always' }) }, t('Always allow {0}', item.approval?.always ?? '')),
				h('button', { class: 'button subtle', onclick: () => post({ type: 'approve', id: item.id, decision: 'deny' }) }, t('Deny'))),
			feedback);
	}

	private renderQuestion(item: Extract<TranscriptItem, { kind: 'question' }>): HTMLElement {
		const answered = item.answer !== undefined;
		const choices = new Map<number, Set<string>>();
		const other = new Map<number, HTMLInputElement>();
		const submit = () => {
			const lines = item.questions.map((q, i) => {
				const picked = [...(choices.get(i) ?? [])];
				const typed = other.get(i)?.value.trim();
				if (typed) {
					picked.push(typed);
				}
				return `${q.question} ${picked.length ? picked.join(', ') : t('(no answer)')}`;
			});
			post({ type: 'answer', id: item.id, answer: lines.join('\n') });
		};
		const single = item.questions.length === 1 && !item.questions[0].multiSelect;
		return h('div', { class: { card: true, question: true, answered } },
			h('div', { class: 'card-title' }, icon('question', 15), t('The agent has a question')),
			item.questions.map((q, i) => h('div', { class: 'q' },
				q.header && h('div', { class: 'q-header' }, q.header),
				h('div', { class: 'q-text' }, q.question),
				!answered && h('div', { class: 'q-options' }, q.options.map(o => {
					const button = h('button', { class: 'option', title: o.description ?? '' },
						h('span', { class: 'option-label' }, o.label),
						o.description && h('span', { class: 'option-desc' }, o.description));
					button.addEventListener('click', () => {
						const set = choices.get(i) ?? new Set<string>();
						if (q.multiSelect) {
							if (set.has(o.label)) {
								set.delete(o.label);
							} else {
								set.add(o.label);
							}
							button.classList.toggle('selected', set.has(o.label));
						} else {
							set.clear();
							set.add(o.label);
							button.parentElement?.querySelectorAll('.option').forEach(b => b.classList.remove('selected'));
							button.classList.add('selected');
						}
						choices.set(i, set);
						if (single) {
							submit();
						}
					});
					return button;
				})),
				!answered && (() => {
					const input = h('input', { class: 'feedback', type: 'text', placeholder: t('Other answer...') });
					input.addEventListener('keydown', e => {
						if (e.key === 'Enter' && input.value.trim()) {
							submit();
						}
					});
					other.set(i, input);
					return input;
				})())),
			!answered && !single && h('div', { class: 'approval-actions' }, h('button', { class: 'button primary', onclick: submit }, t('Submit'))),
			answered && h('div', { class: 'answer' }, icon('check', 13), item.answer!));
	}

	private renderPlan(item: Extract<TranscriptItem, { kind: 'plan' }>): HTMLElement {
		const body = h('div', { class: 'markdown plan-body' });
		renderMarkdown(item.text, body);
		return h('div', { class: `card plan ${item.status}` },
			h('div', { class: 'card-title' }, icon('plan', 15), item.status === 'awaiting' ? t('Ready to start with this plan?') : item.status === 'approved' ? t('Plan approved') : t('Plan not approved')),
			body,
			item.status === 'awaiting' && h('div', { class: 'approval-actions' },
				h('button', { class: 'button primary', onclick: () => post({ type: 'plan', id: item.id, approve: true, mode: 'acceptEdits' }) }, t('Yes, and auto-accept edits')),
				h('button', { class: 'button', onclick: () => post({ type: 'plan', id: item.id, approve: true, mode: 'default' }) }, t('Yes, ask before edits')),
				h('button', { class: 'button subtle', onclick: () => post({ type: 'plan', id: item.id, approve: false }) }, t('Keep planning'))));
	}

	private renderNotice(item: Extract<TranscriptItem, { kind: 'notice' }>): HTMLElement {
		const body = h('div', { class: 'markdown notice-body' });
		renderMarkdown(item.text, body);
		return h('div', { class: `notice ${item.level}` },
			icon(item.level === 'error' ? 'error' : item.level === 'warning' ? 'warning' : 'info', 15, 'notice-icon'),
			h('div', { class: 'notice-main' }, body,
				item.actions?.length && h('div', { class: 'notice-actions' }, item.actions.map(a => h('button', { class: 'button small', onclick: () => post({ type: 'action', action: a.action }) }, a.label)))));
	}

	private renderCompacted(item: Extract<TranscriptItem, { kind: 'compacted' }>): HTMLElement {
		const open = this.expanded.has(item.id);
		const body = open ? h('div', { class: 'markdown compact-body' }) : undefined;
		if (body) {
			renderMarkdown(item.summary, body);
		}
		return h('div', { class: 'compacted' },
			h('button', { class: 'compacted-head', onclick: () => this.toggle(item.id) }, h('span', { class: 'rule' }), icon('compress', 13), t('Conversation compacted'), icon('chevron', 11, open ? 'chevron open' : 'chevron'), h('span', { class: 'rule' })),
			body);
	}

	private renderWorking(): void {
		clearInterval(this.workingTimer);
		if (!this.state.running) {
			this.working.remove();
			return;
		}
		const waiting = this.items.some(i => (i.kind === 'tool' && i.status === 'awaiting') || (i.kind === 'question' && i.answer === undefined) || (i.kind === 'plan' && i.status === 'awaiting'));
		const update = () => {
			const seconds = Math.max(0, Math.round((Date.now() - (this.runStarted || Date.now())) / 1000));
			const word = WORKING_WORDS[Math.floor(seconds / 6) % WORKING_WORDS.length];
			fill(this.working,
				waiting ? icon('pause', 14, 'status-awaiting') : h('span', { class: 'pulse' }, icon('sparkle', 14)),
				h('span', { class: 'working-word' }, waiting ? t('Waiting for you') : `${t(word)}\u2026`),
				h('span', { class: 'muted' }, `${formatDuration(seconds)}${this.state.tokens ? ` \u00b7 ${formatTokens(this.state.tokens)} ${t('tokens')}` : ''} \u00b7 `, h('kbd', null, 'Esc'), ` ${t('to stop')}`));
		};
		update();
		this.workingTimer = window.setInterval(update, 1000);
		if (this.working.parentElement !== this.transcript || this.transcript.lastElementChild !== this.working) {
			this.transcript.append(this.working);
		}
		this.scrollToBottom();
	}

	private renderTodos(): void {
		const todos = this.state.todos;
		if (!todos.length || todos.every(t => t.status === 'completed') && !this.state.running) {
			fill(this.todos);
			this.todos.hidden = true;
			return;
		}
		this.todos.hidden = false;
		const done = todos.filter(t => t.status === 'completed').length;
		const open = !this.expanded.has('__todos_closed');
		fill(this.todos,
			h('button', {
				class: 'todos-head', onclick: () => {
					if (open) {
						this.expanded.add('__todos_closed');
					} else {
						this.expanded.delete('__todos_closed');
					}
					this.renderTodos();
				},
			}, icon('list', 14), h('span', null, t('Tasks')), h('span', { class: 'muted' }, `${done}/${todos.length}`),
				h('span', { class: 'progress' }, h('span', { class: 'progress-bar', style: `width:${Math.round(done / todos.length * 100)}%` })),
				icon('chevron', 11, open ? 'chevron open' : 'chevron')),
			open && h('ul', { class: 'todo-list' }, todos.map(todo => h('li', { class: `todo ${todo.status}` },
				todo.status === 'completed' ? icon('circleCheck', 14) : todo.status === 'in_progress' ? h('span', { class: 'spinner small' }) : icon('circle', 14),
				h('span', null, todo.status === 'in_progress' && todo.activeForm ? todo.activeForm : todo.content)))));
	}

	private renderToolbar(): void {
		const mode = MODES.find(m => m.id === this.state.mode) ?? MODES[0];
		const context = this.state.context;
		const hasText = !!this.input.value.trim();
		this.input.placeholder = this.state.running
			? t('Add to the conversation; it is sent at the next step')
			: this.state.mode === 'plan' ? t('Describe what you want planned...') : t('Ask the agent to build, fix or explain... (@ files, / commands)');
		fill(this.toolbar,
			h('button', {
				class: `chip mode mode-${mode.id}`, title: `${mode.hint()} (${t('Shift+Tab to switch')})`,
				onclick: () => this.cycleMode(),
			}, icon(mode.icon, 13), h('span', { class: 'chip-label' }, mode.label())),
			h('button', {
				class: 'chip model', title: this.state.configured ? t('Switch model') : t('Connect a model'),
				onclick: () => post(this.state.configured ? { type: 'pickModel' } : { type: 'action', action: 'addEndpoint' }),
			}, icon('chip', 13), h('span', { class: 'chip-label' }, this.state.model ?? t('Connect a model'))),
			h('span', { class: 'spacer' }),
			this.state.queued > 0 && h('span', { class: 'badge' }, t('{0} queued', this.state.queued)),
			this.state.cost !== undefined && h('button', { class: 'cost', title: t('Estimated cost of this conversation. Click for usage this month.'), onclick: () => post({ type: 'action', action: 'showUsage' }) }, this.state.cost < 0.01 ? '<$0.01' : `$${this.state.cost.toFixed(2)}`),
			context !== undefined && contextRing(context, this.state.tokens ?? 0),
			this.state.running && !hasText
				? h('button', { class: 'send stop', title: t('Stop (Esc)'), 'aria-label': t('Stop'), onclick: () => post({ type: 'stop' }) }, icon('stop', 14))
				: h('button', { class: 'send', title: this.state.running ? t('Queue message') : t('Send (Enter)'), 'aria-label': t('Send'), disabled: !hasText, onclick: () => this.submit() }, icon('send', 15)));
	}

	private cycleMode(): void {
		const index = MODES.findIndex(m => m.id === this.state.mode);
		const next = MODES[(index + 1) % MODES.length];
		this.state.mode = next.id;
		post({ type: 'setMode', mode: next.id });
		this.renderToolbar();
	}

	// --- input

	private submit(text = this.input.value): void {
		const value = text.trim();
		if (!value) {
			return;
		}
		post({ type: 'send', text: value });
		if (this.sent.at(-1) !== value) {
			this.sent.push(value);
		}
		this.historyIndex = -1;
		if (text === this.input.value) {
			this.input.value = '';
			autosize(this.input);
		}
		this.closePopup();
		this.stickToBottom = true;
		this.saveState();
		this.renderToolbar();
	}

	private onKey(e: KeyboardEvent): void {
		const popupOpen = !this.popup.hidden && this.popupItems.length > 0;
		if (popupOpen && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
			e.preventDefault();
			this.popupIndex = (this.popupIndex + (e.key === 'ArrowDown' ? 1 : -1) + this.popupItems.length) % this.popupItems.length;
			this.renderPopup();
			return;
		}
		if (popupOpen && (e.key === 'Enter' || e.key === 'Tab') && !e.shiftKey) {
			e.preventDefault();
			this.popupItems[this.popupIndex]?.apply();
			return;
		}
		if (e.key === 'Escape') {
			if (popupOpen) {
				e.preventDefault();
				this.closePopup();
			} else if (this.state.running) {
				e.preventDefault();
				post({ type: 'stop' });
			}
			return;
		}
		if (e.key === 'Tab' && e.shiftKey) {
			e.preventDefault();
			this.cycleMode();
			return;
		}
		if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
			e.preventDefault();
			this.submit();
			return;
		}
		if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && this.sent.length && (!this.input.value || this.historyIndex >= 0)) {
			const atStart = this.input.selectionStart === 0 || this.historyIndex >= 0;
			if (!atStart) {
				return;
			}
			e.preventDefault();
			if (e.key === 'ArrowUp') {
				this.historyIndex = this.historyIndex < 0 ? this.sent.length - 1 : Math.max(0, this.historyIndex - 1);
			} else {
				this.historyIndex = this.historyIndex < 0 ? -1 : this.historyIndex + 1;
				if (this.historyIndex >= this.sent.length) {
					this.historyIndex = -1;
				}
			}
			this.input.value = this.historyIndex >= 0 ? this.sent[this.historyIndex] : '';
			autosize(this.input);
			this.renderToolbar();
		}
	}

	private updatePopup(): void {
		const value = this.input.value;
		const caret = this.input.selectionStart ?? value.length;
		const before = value.slice(0, caret);
		const slash = /^\/([\w:.-]*)$/.exec(before);
		if (slash) {
			const query = slash[1].toLowerCase();
			const matches = this.state.commands
				.filter(c => c.name.toLowerCase().includes(query))
				.sort((a, b) => Number(!a.name.toLowerCase().startsWith(query)) - Number(!b.name.toLowerCase().startsWith(query)))
				.slice(0, 12);
			this.openPopup(matches.map((c: SlashCommandInfo) => ({
				label: `/${c.name}${c.hint ? ` ${c.hint}` : ''}`,
				detail: c.description,
				apply: () => {
					this.input.value = `/${c.name} `;
					autosize(this.input);
					this.closePopup();
					this.renderToolbar();
				},
			})));
			return;
		}
		const mention = /(?:^|\s)@([^\s@]*)$/.exec(before);
		if (mention) {
			clearTimeout(this.mentionTimer);
			this.mentionTimer = window.setTimeout(() => {
				this.mentionRequest++;
				post({ type: 'mention', requestId: this.mentionRequest, query: mention[1] });
			}, 80);
			return;
		}
		this.closePopup();
	}

	private showMentions(results: MentionResult[]): void {
		const caret = this.input.selectionStart ?? this.input.value.length;
		const before = this.input.value.slice(0, caret);
		const match = /(?:^|\s)@([^\s@]*)$/.exec(before);
		if (!match) {
			return;
		}
		const start = caret - match[1].length;
		this.openPopup(results.map(r => ({
			label: r.label,
			detail: r.detail,
			apply: () => {
				const after = this.input.value.slice(caret);
				this.input.value = `${this.input.value.slice(0, start)}${r.insert} ${after.replace(/^\s+/, '')}`;
				const position = start + r.insert.length + 1;
				this.input.setSelectionRange(position, position);
				autosize(this.input);
				this.closePopup();
				this.renderToolbar();
			},
		})));
	}

	private openPopup(items: { label: string; detail?: string; apply: () => void }[]): void {
		this.popupItems = items;
		this.popupIndex = 0;
		if (!items.length) {
			this.closePopup();
			return;
		}
		this.popup.hidden = false;
		this.renderPopup();
	}

	private renderPopup(): void {
		fill(this.popup, this.popupItems.map((item, index) => {
			const row = h('div', { class: { 'popup-item': true, active: index === this.popupIndex }, role: 'option', 'aria-selected': String(index === this.popupIndex) },
				h('span', { class: 'popup-label' }, item.label),
				item.detail && h('span', { class: 'popup-detail' }, item.detail));
			row.addEventListener('mousedown', e => {
				e.preventDefault();
				item.apply();
			});
			return row;
		}));
		this.popup.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
	}

	private closePopup(): void {
		this.popup.hidden = true;
		this.popupItems = [];
	}

	private onDocumentClick(e: MouseEvent): void {
		const target = e.target as HTMLElement;
		const link = target.closest<HTMLElement>('.file-link');
		if (link?.dataset.path) {
			e.preventDefault();
			post({ type: 'openFile', path: link.dataset.path, line: link.dataset.line ? Number(link.dataset.line) : undefined });
		}
	}
}

function highlightMentions(text: string): Child[] {
	const out: Child[] = [];
	let last = 0;
	for (const match of text.matchAll(/(^|\s)(@[^\s]+)/g)) {
		const start = match.index + match[1].length;
		out.push(text.slice(last, start));
		const ref = match[2].slice(1).replace(/#L.*$/, '');
		const mention = h('span', { class: 'mention file-link', 'data-path': ref }, match[2]);
		out.push(mention);
		last = start + match[2].length;
	}
	out.push(text.slice(last));
	return out;
}

function contextRing(share: number, tokens: number): HTMLElement {
	const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
	svg.setAttribute('viewBox', '0 0 20 20');
	svg.setAttribute('width', '18');
	svg.setAttribute('height', '18');
	const track = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
	const bar = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
	for (const c of [track, bar]) {
		c.setAttribute('cx', '10');
		c.setAttribute('cy', '10');
		c.setAttribute('r', '7');
		c.setAttribute('fill', 'none');
		c.setAttribute('stroke-width', '2.5');
	}
	track.setAttribute('class', 'ring-track');
	bar.setAttribute('class', share > 0.8 ? 'ring-bar high' : 'ring-bar');
	const circumference = 2 * Math.PI * 7;
	bar.setAttribute('stroke-dasharray', `${circumference * share} ${circumference}`);
	bar.setAttribute('transform', 'rotate(-90 10 10)');
	svg.append(track, bar);
	return h('span', { class: 'context', title: t('{0}% of the context window used ({1} tokens). It is compacted automatically near the limit; /compact does it now.', Math.round(share * 100), tokens.toLocaleString()) }, svg, `${Math.round(share * 100)}%`);
}

function formatDuration(seconds: number): string {
	return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function formatTokens(tokens: number): string {
	return tokens >= 1000 ? `${(tokens / 1000).toFixed(tokens >= 10_000 ? 0 : 1)}k` : String(tokens);
}

function timeAgo(timestamp: number): string {
	const minutes = Math.round((Date.now() - timestamp) / 60_000);
	if (minutes < 1) {
		return t('just now');
	}
	if (minutes < 60) {
		return t('{0}m ago', minutes);
	}
	const hours = Math.round(minutes / 60);
	if (hours < 24) {
		return t('{0}h ago', hours);
	}
	return new Date(timestamp).toLocaleDateString();
}

new App();
