/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { CodeStream, editHunks, editStats, fitCode, inlineEditRequest, type EditRound, type InlineEditHostMessage, type InlineEditPageMessage, type InlineEditPhase } from '../core/inlineEdit';
import { modelStream } from '../core/providers';
import type { Endpoints, ModelChoice } from './endpoints';
import { isBudgetError, type UsageMeter } from './usage';

const HISTORY_KEY = 'nighthawk.inlineEdit.history';
const MAX_HISTORY = 50;
const MAX_PROBLEMS = 20;
/** Height of the edit box in pixels; the inset is sized in editor lines. */
const BOX_HEIGHT = 74;
/** Wait between document updates while code streams in. */
const STREAM_FLUSH_MS = 50;

const regionDecoration = vscode.window.createTextEditorDecorationType({
	isWholeLine: true,
	backgroundColor: new vscode.ThemeColor('editor.rangeHighlightBackground'),
});
const addedDecoration = vscode.window.createTextEditorDecorationType({
	isWholeLine: true,
	backgroundColor: new vscode.ThemeColor('diffEditor.insertedLineBackground'),
	overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.addedForeground'),
	overviewRulerLane: vscode.OverviewRulerLane.Full,
});
const pendingDecoration = vscode.window.createTextEditorDecorationType({
	isWholeLine: true,
	opacity: '0.4',
});
const removedMarkerDecoration = vscode.window.createTextEditorDecorationType({
	overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.deletedForeground'),
	overviewRulerLane: vscode.OverviewRulerLane.Full,
});

interface Hunk {
	id: number;
	/** First line of the new code in the document. */
	start: number;
	added: number;
	removed: string[];
	inset?: vscode.WebviewEditorInset;
}

function nonce(): string {
	return [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, '0')).join('');
}

function lineHeight(): number {
	const config = vscode.workspace.getConfiguration('editor');
	const fontSize = config.get<number>('fontSize') || 14;
	const configured = config.get<number>('lineHeight') || 0;
	if (configured >= 8) {
		return configured;
	}
	// The editor's own rule: a multiple of the font size, 1.35 times it when not set.
	return Math.round(fontSize * (configured > 0 ? configured : process.platform === 'darwin' ? 1.5 : 1.35));
}

/** The text and range that replace `count` whole lines from `from` with `lines`. */
function linesEdit(document: vscode.TextDocument, from: number, count: number, lines: string[]): { range: vscode.Range; text: string } {
	const eol = document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
	if (from + count < document.lineCount) {
		return { range: new vscode.Range(from, 0, from + count, 0), text: lines.map(l => l + eol).join('') };
	}
	const last = document.lineAt(document.lineCount - 1).range.end;
	if (from >= document.lineCount) {
		return { range: new vscode.Range(last, last), text: lines.map(l => eol + l).join('') };
	}
	// The block runs to the end of the file, which has no line break after its last line.
	const start = from > 0 && !lines.length ? document.lineAt(from - 1).range.end : new vscode.Position(from, 0);
	return { range: new vscode.Range(start, last), text: lines.join(eol) };
}

/**
 * One inline edit in one document: the box above the code, the request
 * and its streamed answer, and the changes waiting to be accepted.
 */
class InlineEditSession implements vscode.Disposable {
	phase: InlineEditPhase = 'prompt';
	/** First line of the edited block. */
	start: number;
	/** Lines the block has in the document now. */
	lineCount: number;
	/** The block's lines when the request was sent. */
	private original: string[] = [];
	private readonly rounds: EditRound[] = [];
	/** The code the model wrote in the last round, before it was fitted into the file. */
	private lastCode: string[] = [];
	/** How many changes the last round made, to tell whether some were accepted since. */
	private roundHunks = 0;
	private instruction = '';
	hunks: Hunk[] = [];
	private nextHunkId = 1;
	private box: vscode.WebviewEditorInset | undefined;
	private boxReady = false;
	private wantsFocus = true;
	private abort: AbortController | undefined;
	/** Edits this session makes, so the document listener can tell them from the user's. */
	private applying = 0;
	private written = 0;
	private oldRemaining = 0;
	private streamedLines = 0;
	private error: string | undefined;
	private disposed = false;
	private readonly disposables: vscode.Disposable[] = [];

	constructor(
		private readonly controller: InlineEditController,
		readonly document: vscode.TextDocument,
		private editor: vscode.TextEditor,
		start: number,
		lineCount: number,
		/** True when writing new code at the cursor rather than changing lines. */
		readonly insert: boolean,
		private readonly cursorIndent: string,
	) {
		this.start = start;
		this.lineCount = lineCount;
		this.disposables.push(vscode.workspace.onDidChangeTextDocument(e => {
			if (e.document === this.document && !this.applying) {
				this.onForeignChange(e.contentChanges);
			}
		}));
	}

	get model(): ModelChoice | undefined {
		return this.controller.model();
	}

	/** Shows the box and the decorations in the editor that has the document, after a tab switch too. */
	render(editor?: vscode.TextEditor): void {
		if (this.disposed) {
			return;
		}
		if (editor && editor !== this.editor) {
			this.editor = editor;
			this.disposeBox();
			this.hunks.forEach(h => this.disposeInset(h));
		}
		if (!this.isVisible()) {
			return;
		}
		if (!this.box) {
			this.createBox();
		}
		for (const hunk of this.hunks) {
			// Blank lines that made way for new code are not worth a box of their own.
			if (!hunk.inset && hunk.removed.some(line => line.trim())) {
				hunk.inset = this.createRemovedInset(hunk);
			}
		}
		this.decorate();
	}

	private isVisible(): boolean {
		return vscode.window.visibleTextEditors.includes(this.editor);
	}

	private createBox(): void {
		try {
			const inset = vscode.window.createWebviewTextEditorInset(this.editor, this.start - 1, Math.max(2, Math.ceil(BOX_HEIGHT / lineHeight())), {
				enableScripts: true,
				localResourceRoots: [this.controller.media],
			});
			this.box = inset;
			this.boxReady = false;
			inset.webview.html = this.controller.html(inset.webview, 'box');
			inset.webview.onDidReceiveMessage(message => this.onMessage(message as InlineEditPageMessage));
			inset.onDidDispose(() => {
				if (this.box === inset) {
					this.box = undefined;
				}
			});
		} catch {
			// Some editors, such as notebook cells, cannot show insets; fall back to an input box.
			this.box = undefined;
			if (this.phase === 'prompt' && this.wantsFocus) {
				this.wantsFocus = false;
				void this.askInQuickInput();
			}
		}
	}

	private async askInQuickInput(): Promise<void> {
		const text = await vscode.window.showInputBox({
			title: this.insert ? vscode.l10n.t('Generate Code') : vscode.l10n.t('Edit Selection'),
			prompt: this.model ? vscode.l10n.t('Using {0}', this.model.model) : undefined,
			placeHolder: this.insert ? vscode.l10n.t('Describe the code to write') : vscode.l10n.t('Describe the change'),
			ignoreFocusOut: true,
		});
		if (text?.trim()) {
			await this.submit(text.trim());
		} else if (this.phase === 'prompt') {
			this.controller.end(this);
		}
	}

	private createRemovedInset(hunk: Hunk): vscode.WebviewEditorInset | undefined {
		try {
			const inset = vscode.window.createWebviewTextEditorInset(this.editor, hunk.start - 1, hunk.removed.length, {
				enableScripts: true,
				localResourceRoots: [this.controller.media],
			});
			inset.webview.html = this.controller.html(inset.webview, 'removed');
			inset.webview.onDidReceiveMessage(message => {
				if ((message as InlineEditPageMessage).type === 'ready') {
					const config = vscode.workspace.getConfiguration('editor', this.document);
					this.send(inset, {
						type: 'removed',
						lines: hunk.removed,
						lineHeight: lineHeight(),
						fontSize: config.get<number>('fontSize') || 14,
						tabSize: typeof this.editor.options.tabSize === 'number' ? this.editor.options.tabSize : 4,
					});
				}
			});
			inset.onDidDispose(() => {
				if (hunk.inset === inset) {
					hunk.inset = undefined;
				}
			});
			return inset;
		} catch {
			return undefined;
		}
	}

	private disposeBox(): void {
		const box = this.box;
		this.box = undefined;
		box?.dispose();
	}

	private disposeInset(hunk: Hunk): void {
		const inset = hunk.inset;
		hunk.inset = undefined;
		inset?.dispose();
	}

	focus(): void {
		this.wantsFocus = true;
		this.render();
		if (this.box && this.boxReady) {
			this.wantsFocus = false;
			this.send(this.box, { type: 'focus' });
		}
	}

	private onMessage(message: InlineEditPageMessage): void {
		switch (message.type) {
			case 'ready':
				this.boxReady = true;
				this.post(true);
				if (this.wantsFocus) {
					this.focus();
				}
				return;
			case 'submit':
				if (message.text.trim() && (this.phase === 'prompt' || this.phase === 'review' || this.phase === 'error')) {
					void this.submit(message.text.trim());
				}
				return;
			case 'cancel':
				return this.cancel();
			case 'close':
				return this.close();
			case 'accept':
				return void this.controller.acceptAll(this);
			case 'reject':
				return void this.controller.rejectAll(this);
			case 'pickModel':
				return void this.controller.pickModel();
			case 'focusEditor':
				void vscode.window.showTextDocument(this.document, this.editor.viewColumn);
				return;
		}
	}

	post(withSetup = false): void {
		if (!this.box || !this.boxReady) {
			return;
		}
		const stats = editStats(this.hunks);
		const message: InlineEditHostMessage = {
			type: 'state',
			phase: this.phase,
			model: this.model?.model,
			insert: this.insert,
			instruction: this.instruction || undefined,
			lines: this.streamedLines,
			added: stats.added,
			removed: stats.removed,
			changes: this.hunks.length,
			error: this.error,
			history: withSetup ? this.controller.history() : undefined,
			l10n: withSetup ? vscode.l10n.bundle : undefined,
			keys: withSetup ? {
				accept: process.platform === 'darwin' ? '⌘⏎' : 'Ctrl+Enter',
				// allow-any-unicode-next-line
				reject: process.platform === 'darwin' ? '⌘⌫' : 'Ctrl+Backspace',
			} : undefined,
		};
		this.send(this.box, message);
	}

	/** Posts to an inset; the editor may have closed it already, for example on a tab switch. */
	private send(inset: vscode.WebviewEditorInset, message: unknown): void {
		inset.webview.postMessage(message).then(undefined, () => undefined);
	}

	private setPhase(phase: InlineEditPhase): void {
		if (this.disposed) {
			return;
		}
		this.phase = phase;
		this.post();
		this.decorate();
		this.controller.updateContext();
	}

	private decorate(): void {
		if (this.disposed || !this.isVisible()) {
			return;
		}
		const line = (n: number) => new vscode.Range(n, 0, n, 0);
		const lines = (from: number, count: number) => Array.from({ length: Math.max(0, count) }, (_, i) => line(from + i));
		const region = this.phase === 'prompt' || this.phase === 'error' ? lines(this.start, this.lineCount) : [];
		const added = this.phase === 'generating' ? lines(this.start, this.written) : this.phase === 'review' ? this.hunks.flatMap(h => lines(h.start, h.added)) : [];
		const pending = this.phase === 'generating' ? lines(this.start + this.written, this.oldRemaining) : [];
		const removed = this.phase === 'review' ? this.hunks.filter(h => h.removed.some(l => l.trim())).map(h => line(Math.min(h.start, this.document.lineCount - 1))) : [];
		this.editor.setDecorations(regionDecoration, region);
		this.editor.setDecorations(addedDecoration, added);
		this.editor.setDecorations(pendingDecoration, pending);
		this.editor.setDecorations(removedMarkerDecoration, removed);
	}

	private clearDecorations(): void {
		if (this.isVisible()) {
			for (const type of [regionDecoration, addedDecoration, pendingDecoration, removedMarkerDecoration]) {
				this.editor.setDecorations(type, []);
			}
		}
	}

	/** Replaces lines of the document, as one undo step with the session's other edits when the editor is open. */
	private async replace(from: number, count: number, lines: string[], undoStop: { before: boolean; after: boolean } = { before: false, after: false }): Promise<boolean> {
		const { range, text } = linesEdit(this.document, from, count, lines);
		this.applying++;
		try {
			if (this.isVisible()) {
				return await this.editor.edit(builder => builder.replace(range, text), { undoStopBefore: undoStop.before, undoStopAfter: undoStop.after });
			}
			const edit = new vscode.WorkspaceEdit();
			edit.replace(this.document.uri, range, text);
			return await vscode.workspace.applyEdit(edit);
		} finally {
			this.applying--;
		}
	}

	private readLines(from: number, count: number): string[] {
		return Array.from({ length: count }, (_, i) => this.document.lineAt(from + i).text);
	}

	async submit(instruction: string): Promise<void> {
		const choice = this.model;
		if (!choice) {
			await this.controller.offerSetup();
			return;
		}
		this.controller.remember(instruction);
		if (this.phase === 'review') {
			// A follow-up: take back this round's changes and ask again with what was said so far.
			const partlyAccepted = this.hunks.length !== this.roundHunks;
			this.phase = 'generating';
			await this.rejectHunks(this.hunks);
			if (partlyAccepted) {
				this.rounds.length = 0;
			} else {
				this.rounds.push({ instruction: this.instruction, code: this.lastCode.join('\n') });
			}
		}
		if (!this.rounds.length) {
			this.original = this.readLines(this.start, this.lineCount);
		}
		this.instruction = instruction;
		this.error = undefined;
		if (this.isVisible() && !this.editor.selection.isEmpty) {
			// The selection would hide the new code's highlight.
			const at = new vscode.Position(this.start, 0);
			this.editor.selection = new vscode.Selection(at, at);
		}
		this.written = 0;
		this.oldRemaining = this.lineCount;
		this.streamedLines = 0;
		this.setPhase('generating');
		await this.generate(choice);
	}

	private target() {
		const all = this.readLines(0, this.document.lineCount);
		// The original block is read before streaming starts, so the lines around it are still as they were.
		const before = all.slice(0, this.start);
		const after = all.slice(this.start + this.lineCount);
		const problems = vscode.languages.getDiagnostics(this.document.uri)
			.filter(d => d.severity <= vscode.DiagnosticSeverity.Warning)
			.filter(d => this.insert
				? Math.abs(d.range.start.line - this.start) <= 3
				: d.range.end.line >= this.start && d.range.start.line < this.start + Math.max(1, this.lineCount))
			.slice(0, MAX_PROBLEMS)
			.map(d => `line ${d.range.start.line + 1}: ${d.message}`);
		return {
			path: vscode.workspace.asRelativePath(this.document.uri),
			languageId: this.document.languageId,
			before,
			selected: this.insert ? [] : this.original,
			after,
			problems,
		};
	}

	private async generate(choice: ModelChoice): Promise<void> {
		const key = await this.controller.endpoints.apiKey(choice.endpoint);
		const stream = this.controller.usage.track(modelStream(choice.endpoint, choice.model, key, { thinking: false }), { endpoint: choice.endpoint, model: choice.model, feature: 'inline' });
		const request = inlineEditRequest(this.target(), this.instruction, this.rounds, choice.endpoint.maxOutputTokens ?? 8192);
		const abort = new AbortController();
		this.abort = abort;
		const code = new CodeStream();
		let pending: string[] = [];
		let flushing: Promise<void> = Promise.resolve();
		let lastFlush = 0;
		let first = true;
		const wanted = this.insert ? this.cursorIndent : /^[ \t]*/.exec(this.original.find(l => l.trim()) ?? '')![0];
		let prefix: string | undefined;
		const flush = () => {
			if (!pending.length) {
				return flushing;
			}
			const lines = pending;
			pending = [];
			lastFlush = Date.now();
			flushing = flushing.then(async () => {
				if (abort.signal.aborted) {
					return;
				}
				const consumed = Math.min(lines.length, this.oldRemaining);
				const ok = await this.replace(this.start + this.written, consumed, lines, { before: first, after: false });
				first = false;
				if (!ok) {
					abort.abort();
					return;
				}
				this.written += lines.length;
				this.oldRemaining -= consumed;
				this.streamedLines = this.written;
				this.lineCount = this.written + this.oldRemaining;
				this.decorate();
				this.post();
			});
			return flushing;
		};
		const take = (lines: string[]) => {
			for (const line of lines) {
				if (prefix === undefined && line.trim()) {
					// Models often write the code flush left; indent it like the block it replaces.
					prefix = wanted && !/^[ \t]/.test(line) ? wanted : '';
				}
				pending.push(line.trim() && prefix ? prefix + line : line);
			}
			if (Date.now() - lastFlush >= STREAM_FLUSH_MS) {
				void flush();
			}
		};
		try {
			for await (const event of stream(request, abort.signal)) {
				if (event.type === 'text') {
					take(code.push(event.text));
				} else if (event.type === 'done' && event.stopReason === 'max_tokens') {
					this.error = vscode.l10n.t('The answer was cut off at the model\'s output limit.');
				}
			}
			take(code.end());
			await flush();
			if (abort.signal.aborted) {
				throw new Error(vscode.l10n.t('The code changed while the edit was being written.'));
			}
			this.lastCode = code.code;
			await this.finish(fitCode(code.code, this.insert ? [] : this.original, this.cursorIndent));
		} catch (err) {
			await flushing;
			const cancelled = abort.signal.aborted && this.abort !== abort;
			await this.restore();
			if (isBudgetError(err)) {
				this.error = err.message;
				this.setPhase('error');
				await this.controller.usage.offerToRaiseLimit(err);
			} else if (cancelled || this.disposed) {
				this.setPhase('prompt');
			} else {
				this.error = err instanceof Error ? err.message : String(err);
				this.setPhase('error');
			}
		} finally {
			if (this.abort === abort) {
				this.abort = undefined;
			}
		}
	}

	/** Puts the original block back after a cancelled or failed request. */
	private async restore(): Promise<void> {
		if (this.disposed) {
			return;
		}
		const now = this.readLines(this.start, Math.min(this.lineCount, this.document.lineCount - this.start));
		if (now.join('\n') !== this.original.join('\n')) {
			await this.replace(this.start, this.lineCount, this.original, { before: false, after: true });
		}
		this.lineCount = this.original.length;
		this.written = 0;
		this.oldRemaining = 0;
	}

	private async finish(code: string[]): Promise<void> {
		// Swap the streamed lines for the fitted code; usually they are the same.
		const streamed = this.readLines(this.start, this.lineCount);
		if (streamed.join('\n') !== code.join('\n')) {
			await this.replace(this.start, this.lineCount, code, { before: false, after: true });
		}
		this.lineCount = code.length;
		this.written = 0;
		this.oldRemaining = 0;
		this.hunks = editHunks(this.original, code).map(h => ({ id: this.nextHunkId++, start: this.start + h.start, added: h.added, removed: h.removed }));
		this.roundHunks = this.hunks.length;
		if (!this.hunks.length) {
			this.error = this.error ?? vscode.l10n.t('The model made no changes. Try saying it differently.');
			this.setPhase('error');
			return;
		}
		this.setPhase('review');
		this.render();
		this.controller.refreshLenses();
	}

	cancel(): void {
		if (this.phase === 'generating') {
			const abort = this.abort;
			this.abort = undefined;
			abort?.abort();
		} else {
			this.close();
		}
	}

	/** Closes the box; changes still waiting are rejected first. */
	close(): void {
		if (this.phase === 'review') {
			void this.controller.rejectAll(this);
		} else if (this.phase === 'generating') {
			this.cancel();
		} else {
			this.controller.end(this);
		}
	}

	async acceptHunks(hunks: Hunk[]): Promise<void> {
		for (const hunk of hunks) {
			this.disposeInset(hunk);
		}
		this.hunks = this.hunks.filter(h => !hunks.includes(h));
		this.afterHunkChange();
	}

	async rejectHunks(hunks: Hunk[]): Promise<void> {
		// From the bottom up, so the line numbers of the ones above stay right.
		for (const hunk of [...hunks].sort((a, b) => b.start - a.start)) {
			this.disposeInset(hunk);
			await this.replace(hunk.start, hunk.added, hunk.removed, { before: false, after: true });
			const delta = hunk.removed.length - hunk.added;
			for (const other of this.hunks) {
				if (other.start > hunk.start) {
					other.start += delta;
				}
			}
			this.lineCount += delta;
		}
		this.hunks = this.hunks.filter(h => !hunks.includes(h));
		this.afterHunkChange();
	}

	private afterHunkChange(): void {
		this.controller.refreshLenses();
		if (this.phase !== 'review') {
			return;
		}
		if (!this.hunks.length) {
			this.controller.end(this);
		} else {
			this.post();
			this.decorate();
		}
	}

	/** Follows edits the user makes while the box is open, so the block and its changes stay on the right lines. */
	private onForeignChange(changes: readonly vscode.TextDocumentContentChangeEvent[]): void {
		for (const change of changes) {
			const from = change.range.start.line;
			const to = change.range.end.line;
			const delta = (change.text.match(/\n/g)?.length ?? 0) - (to - from);
			const end = this.start + this.lineCount;
			if (to < this.start || (to === this.start && change.range.end.character === 0 && from < this.start)) {
				this.start += delta;
				this.hunks.forEach(h => h.start += delta);
				continue;
			}
			if (from >= end && !(this.lineCount === 0 && from === this.start)) {
				continue;
			}
			if (this.phase === 'generating') {
				// The streamed lines can no longer be placed safely.
				const abort = this.abort;
				this.abort = undefined;
				abort?.abort();
				this.controller.end(this);
				vscode.window.showWarningMessage(vscode.l10n.t('Stopped the inline edit because the code it was changing was edited.'));
				return;
			}
			this.lineCount = Math.max(0, this.lineCount + delta);
			for (const hunk of this.hunks) {
				if (to < hunk.start) {
					hunk.start += delta;
				} else if (from < hunk.start + Math.max(1, hunk.added)) {
					hunk.added = Math.max(0, hunk.added + delta);
				}
			}
		}
		this.decorate();
		this.controller.refreshLenses();
	}

	dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		this.abort?.abort();
		this.clearDecorations();
		this.disposeBox();
		this.hunks.forEach(h => this.disposeInset(h));
		this.disposables.forEach(d => d.dispose());
	}
}

/**
 * Inline edit: select code, press Ctrl+I, say what to change, and the new
 * code streams into the file. Each change can then be accepted or rejected,
 * or refined with a follow-up.
 */
export class InlineEditController implements vscode.Disposable, vscode.CodeLensProvider {
	private readonly sessions = new Map<vscode.TextDocument, InlineEditSession>();
	private readonly lensesChanged = new vscode.EventEmitter<void>();
	readonly onDidChangeCodeLenses = this.lensesChanged.event;
	private readonly disposables: vscode.Disposable[] = [this.lensesChanged];
	readonly media: vscode.Uri;

	constructor(
		private readonly context: vscode.ExtensionContext,
		readonly endpoints: Endpoints,
		readonly usage: UsageMeter,
	) {
		this.media = vscode.Uri.joinPath(context.extensionUri, 'media');
		this.disposables.push(
			vscode.languages.registerCodeLensProvider({ scheme: '*' }, this),
			vscode.window.onDidChangeVisibleTextEditors(editors => {
				for (const editor of editors) {
					this.sessions.get(editor.document)?.render(editor);
				}
			}),
			vscode.window.onDidChangeActiveTextEditor(() => this.updateContext()),
			vscode.workspace.onDidCloseTextDocument(document => {
				const session = this.sessions.get(document);
				if (session) {
					this.end(session);
				}
			}),
			endpoints.onDidChange(() => this.sessions.forEach(s => s.post())),
			vscode.workspace.onDidChangeConfiguration(e => {
				if (e.affectsConfiguration('nighthawk.inlineEdit.model')) {
					this.sessions.forEach(s => s.post());
				}
			}),
		);
	}

	/** The model for inline edits: `nighthawk.inlineEdit.model`, else the agent's. */
	model(): ModelChoice | undefined {
		const setting = vscode.workspace.getConfiguration('nighthawk.inlineEdit').get<string>('model') ?? '';
		return this.endpoints.resolve(setting) ?? this.endpoints.current();
	}

	async pickModel(): Promise<void> {
		const setting = vscode.workspace.getConfiguration('nighthawk.inlineEdit').get<string>('model') ?? '';
		const agent = this.endpoints.current();
		type Item = vscode.QuickPickItem & { ref?: string; add?: boolean };
		const items: Item[] = [
			{ label: vscode.l10n.t('Same as the Agent'), description: agent?.model, ref: '', picked: !setting },
			...this.endpoints.list().flatMap(endpoint => endpoint.models.map<Item>(model => ({
				label: model,
				description: endpoint.name,
				ref: `${endpoint.name}/${model}`,
			}))),
			{ label: `$(add) ${vscode.l10n.t('Add Model Endpoint...')}`, add: true },
		];
		const pick = await vscode.window.showQuickPick(items, { title: vscode.l10n.t('Model for Inline Edits'), placeHolder: vscode.l10n.t('A fast model makes inline edits feel instant') });
		if (pick?.add) {
			await vscode.commands.executeCommand('nighthawk.ai.addEndpoint');
		} else if (pick && pick.ref !== undefined) {
			await vscode.workspace.getConfiguration('nighthawk.inlineEdit').update('model', pick.ref, vscode.ConfigurationTarget.Global);
		}
		this.sessions.forEach(s => s.focus());
	}

	async offerSetup(): Promise<void> {
		const add = vscode.l10n.t('Add Model Endpoint');
		if (await vscode.window.showInformationMessage(vscode.l10n.t('Connect a model to edit code with AI.'), add) === add) {
			await vscode.commands.executeCommand('nighthawk.ai.addEndpoint');
		}
	}

	history(): string[] {
		return this.context.globalState.get<string[]>(HISTORY_KEY) ?? [];
	}

	remember(instruction: string): void {
		const history = [instruction, ...this.history().filter(h => h !== instruction)].slice(0, MAX_HISTORY);
		void this.context.globalState.update(HISTORY_KEY, history);
	}

	/** Opens the edit box for the selection, or for new code at the cursor. */
	async start(editor = vscode.window.activeTextEditor): Promise<void> {
		if (!editor) {
			return;
		}
		const existing = this.sessions.get(editor.document);
		if (existing) {
			// One edit per file at a time: go back to the open one.
			existing.render(editor);
			existing.focus();
			if (existing.phase === 'review') {
				editor.revealRange(new vscode.Range(existing.start, 0, existing.start, 0), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
			}
			return;
		}
		if (!this.model()) {
			await this.offerSetup();
			if (!this.model()) {
				return;
			}
		}
		const document = editor.document;
		const selection = editor.selection;
		let session: InlineEditSession;
		if (selection.isEmpty) {
			const line = document.lineAt(selection.active.line);
			const indent = line.text.slice(0, line.firstNonWhitespaceCharacterIndex);
			if (line.isEmptyOrWhitespace) {
				// Write into the empty line, at the indentation the editor put the cursor at.
				const cursorIndent = line.text.length ? line.text : this.indentAround(document, line.lineNumber);
				session = new InlineEditSession(this, document, editor, line.lineNumber, 1, true, cursorIndent);
			} else {
				session = new InlineEditSession(this, document, editor, line.lineNumber + 1, 0, true, indent);
			}
		} else {
			const last = selection.end.line > selection.start.line && selection.end.character === 0 ? selection.end.line - 1 : selection.end.line;
			session = new InlineEditSession(this, document, editor, selection.start.line, last - selection.start.line + 1, false, '');
		}
		this.sessions.set(document, session);
		session.render();
		session.focus();
		this.updateContext();
	}

	/** The indentation of the nearest line above that has code. */
	private indentAround(document: vscode.TextDocument, line: number): string {
		for (let n = line - 1; n >= 0; n--) {
			const text = document.lineAt(n);
			if (!text.isEmptyOrWhitespace) {
				return text.text.slice(0, text.firstNonWhitespaceCharacterIndex);
			}
		}
		return '';
	}

	private sessionFor(target?: vscode.Uri | InlineEditSession): InlineEditSession | undefined {
		if (target instanceof InlineEditSession) {
			return target;
		}
		const document = target ? vscode.workspace.textDocuments.find(d => d.uri.toString() === target.toString()) : vscode.window.activeTextEditor?.document;
		return document ? this.sessions.get(document) : undefined;
	}

	async acceptAll(target?: vscode.Uri | InlineEditSession): Promise<void> {
		const session = this.sessionFor(target);
		if (session?.phase === 'review') {
			await session.acceptHunks(session.hunks);
			this.focusEditor(session);
		}
	}

	async rejectAll(target?: vscode.Uri | InlineEditSession): Promise<void> {
		const session = this.sessionFor(target);
		if (session?.phase === 'review') {
			await session.rejectHunks(session.hunks);
			this.focusEditor(session);
		}
	}

	async acceptHunk(uri: vscode.Uri, id: number): Promise<void> {
		const session = this.sessionFor(uri);
		const hunk = session?.hunks.find(h => h.id === id);
		if (session && hunk) {
			await session.acceptHunks([hunk]);
		}
	}

	async rejectHunk(uri: vscode.Uri, id: number): Promise<void> {
		const session = this.sessionFor(uri);
		const hunk = session?.hunks.find(h => h.id === id);
		if (session && hunk) {
			await session.rejectHunks([hunk]);
		}
	}

	cancel(): void {
		this.sessionFor()?.cancel();
	}

	private focusEditor(session: InlineEditSession): void {
		const editor = vscode.window.visibleTextEditors.find(e => e.document === session.document);
		if (editor) {
			void vscode.window.showTextDocument(editor.document, editor.viewColumn);
		}
	}

	end(session: InlineEditSession): void {
		if (this.sessions.get(session.document) === session) {
			this.sessions.delete(session.document);
		}
		const hadFocus = session.phase !== 'review';
		session.dispose();
		this.refreshLenses();
		this.updateContext();
		if (hadFocus) {
			this.focusEditor(session);
		}
	}

	updateContext(): void {
		const session = this.sessionFor();
		void vscode.commands.executeCommand('setContext', 'nighthawk.inlineEdit.reviewing', session?.phase === 'review');
		void vscode.commands.executeCommand('setContext', 'nighthawk.inlineEdit.generating', session?.phase === 'generating');
	}

	refreshLenses(): void {
		this.lensesChanged.fire();
	}

	provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
		const session = this.sessions.get(document);
		if (session?.phase !== 'review') {
			return [];
		}
		return session.hunks.flatMap(hunk => {
			const line = Math.min(hunk.start, document.lineCount - 1);
			const range = new vscode.Range(line, 0, line, 0);
			return [
				new vscode.CodeLens(range, { title: `$(check) ${vscode.l10n.t('Accept')}`, command: 'nighthawk.inlineEdit.acceptChange', arguments: [document.uri, hunk.id] }),
				new vscode.CodeLens(range, { title: `$(close) ${vscode.l10n.t('Reject')}`, command: 'nighthawk.inlineEdit.rejectChange', arguments: [document.uri, hunk.id] }),
			];
		});
	}

	html(webview: vscode.Webview, mode: 'box' | 'removed'): string {
		const once = nonce();
		const script = webview.asWebviewUri(vscode.Uri.joinPath(this.media, 'inlineEdit.js'));
		const style = webview.asWebviewUri(vscode.Uri.joinPath(this.media, 'inlineEdit.css'));
		return `<!DOCTYPE html>
<html lang="${vscode.env.language}">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${once}';">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<link rel="stylesheet" href="${style}">
</head>
<body class="${mode}">
	<script type="module" nonce="${once}" src="${script}"></script>
</body>
</html>`;
	}

	dispose(): void {
		this.sessions.forEach(s => s.dispose());
		this.sessions.clear();
		this.disposables.forEach(d => d.dispose());
	}
}
