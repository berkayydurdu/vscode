/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import { LiveDocumentState, parseEvents } from '../core/liveClient';
import { apply, diffOperation, replacementsOperation, transform, transformOffset, type TextOperation } from '../core/textOperation';
import { config } from '../vault';
import type { Account } from './account';
import { NotesServerError, ROLE_RANK } from './client';
import { TEAM_SCHEME, type TeamFileSystem } from './teamFileSystem';

/** How long a teammate's name stays next to their cursor after they move it. */
const NAME_VISIBLE_MS = 3000;
const RETRY_DELAYS_MS = [1000, 2000, 5000, 10_000, 30_000];

interface Peer {
	client: string;
	userId: string;
	name: string;
	color: string;
	canEdit: boolean;
	/** Offsets into the editor's text. */
	selections: [number, number][];
	movedAt: number;
}

/** `unavailable`: the server has no live editing, or no access; the note is edited as before. */
type Status = 'connecting' | 'live' | 'offline' | 'unavailable';

/** An edit from the server being put into the editor. */
interface Applying {
	/** The server's edit, or undefined when lining the editor up after joining. */
	op: TextOperation | undefined;
	/** The editor's text once the edit is in. */
	expected: string;
	landed: boolean;
}

/**
 * One team note open in an editor and edited live with everyone else who
 * has it open: their edits appear as they type, with their cursors.
 */
class LiveSession implements vscode.Disposable {
	readonly client = randomUUID();
	status: Status = 'connecting';
	readonly peers = new Map<string, Peer>();
	private state: LiveDocumentState | undefined;
	private abort: AbortController | undefined;
	private retries = 0;
	private retryTimer: ReturnType<typeof setTimeout> | undefined;
	/** Server events are handled one after another, as edits may need to wait for the editor. */
	private queue: Promise<void> = Promise.resolve();
	private applying: Applying | undefined;
	private selectionTimer: ReturnType<typeof setTimeout> | undefined;
	private disposed = false;

	constructor(
		readonly document: vscode.TextDocument,
		readonly noteId: string,
		private readonly canEdit: boolean,
		private readonly account: Account,
		private readonly teamFs: TeamFileSystem,
		private readonly changed: () => void,
	) {
		teamFs.setLive(document.uri, { connected: false });
		this.connect();
	}

	get teamId(): string {
		return this.document.uri.authority;
	}

	dispose(): void {
		this.disposed = true;
		clearTimeout(this.retryTimer);
		clearTimeout(this.selectionTimer);
		this.abort?.abort();
		this.teamFs.setLive(this.document.uri, undefined);
	}

	private setStatus(status: Status): void {
		this.status = status;
		this.teamFs.setLive(this.document.uri, { connected: status === 'live' });
		this.changed();
	}

	private async connect(): Promise<void> {
		this.abort?.abort();
		const abort = this.abort = new AbortController();
		this.setStatus('connecting');
		try {
			const body = await this.account.client.liveStream(this.teamId, this.noteId, this.client, abort.signal);
			const decoder = new TextDecoder();
			let rest = '';
			for await (const chunk of body) {
				const parsed = parseEvents(rest + decoder.decode(chunk, { stream: true }));
				rest = parsed.rest;
				for (const { event, data } of parsed.events) {
					this.enqueue(() => this.handle(event, JSON.parse(data)));
				}
			}
		} catch (err) {
			if (abort.signal.aborted || this.disposed) {
				return;
			}
			if (err instanceof NotesServerError && (err.status === 404 || err.status === 403 || err.status === 401)) {
				// An older server without live editing, or no access: edit as before.
				this.peers.clear();
				this.teamFs.setLive(this.document.uri, undefined);
				this.status = 'unavailable';
				this.changed();
				return;
			}
		}
		if (!abort.signal.aborted && !this.disposed) {
			this.reconnectLater();
		}
	}

	private reconnectLater(): void {
		this.abort?.abort();
		this.peers.clear();
		this.setStatus('offline');
		clearTimeout(this.retryTimer);
		this.retryTimer = setTimeout(() => this.connect(), RETRY_DELAYS_MS[Math.min(this.retries++, RETRY_DELAYS_MS.length - 1)]);
	}

	private enqueue(task: () => Promise<void> | void): void {
		this.queue = this.queue.then(task).catch(err => {
			console.error('[nighthawk-notes] live editing', err);
			if (!this.disposed) {
				this.reconnectLater();
			}
		});
	}

	private async handle(event: string, data: any): Promise<void> {
		if (this.disposed) {
			return;
		}
		switch (event) {
			case 'init':
				return this.joined(data);
			case 'op':
				if (data.client === this.client) {
					this.send(this.state?.acknowledged());
				} else if (this.state) {
					await this.remote(data.op);
				}
				return;
			case 'presence': {
				const peer = this.peers.get(data.client);
				if (peer && this.state) {
					peer.selections = (data.selections as [number, number][]).map(selection => selection.map(offset => this.pendingOffset(offset)) as [number, number]);
					peer.movedAt = Date.now();
					this.changed();
				}
				return;
			}
			case 'join':
				this.peers.set(data.client, { ...data, movedAt: 0 });
				this.changed();
				return;
			case 'leave':
				this.peers.delete(data.client);
				this.changed();
				return;
			case 'saved':
				return this.saved(data);
			case 'deleted':
				this.dispose();
				this.changed();
				return;
		}
	}

	/** Where a server offset is in the editor, which also has our unconfirmed edits. */
	private pendingOffset(offset: number): number {
		const state = this.state!;
		for (const op of [state.outstanding, state.buffer]) {
			if (op) {
				offset = transformOffset(offset, op);
			}
		}
		return offset;
	}

	private async joined(data: { revision: number; content: string; peers: Omit<Peer, 'movedAt'>[] }): Promise<void> {
		const text = this.document.getText();
		const previous = this.state;
		this.state = new LiveDocumentState(data.revision, data.content);
		this.peers.clear();
		for (const peer of data.peers) {
			this.peers.set(peer.client, { ...peer, movedAt: 0 });
		}
		this.retries = 0;
		let editorOp: TextOperation;
		let mine: TextOperation | undefined;
		if (previous && this.canEdit) {
			// Back after losing the connection: keep what was typed here
			// meanwhile and take in what others did.
			const [ours, theirs] = transform(diffOperation(previous.confirmed, text), diffOperation(previous.confirmed, data.content));
			editorOp = theirs;
			mine = ours;
		} else if (this.document.isDirty && this.canEdit) {
			// Unsaved changes from before the session become our first edit.
			editorOp = [];
			mine = diffOperation(data.content, text);
		} else {
			editorOp = diffOperation(text, data.content);
		}
		if (!await this.applyToEditor(editorOp, undefined)) {
			throw new Error('Could not line up the note with the server');
		}
		this.setStatus('live');
		if (mine && mine.some(part => typeof part !== 'number' || part < 0)) {
			this.send(this.state.local(mine));
		}
		this.shareSelection();
	}

	private async remote(op: TextOperation): Promise<void> {
		for (let attempt = 0; ; attempt++) {
			const editorOp = this.state!.incoming(op);
			if (await this.applyToEditor(editorOp, op)) {
				for (const peer of this.peers.values()) {
					peer.selections = peer.selections.map(([anchor, head]) => [transformOffset(anchor, editorOp), transformOffset(head, editorOp)]);
				}
				this.changed();
				return;
			}
			if (attempt > 20) {
				throw new Error('The editor kept changing while a teammate\'s edit was put in');
			}
			// The user typed first; their edit is now unconfirmed, so try again.
			await new Promise(resolve => setTimeout(resolve, 10));
		}
	}

	/**
	 * Puts an edit into the editor. When the user types at the same moment
	 * the edit is refused (the document changed), and the caller tries
	 * again after the typing has been recorded.
	 */
	private async applyToEditor(editorOp: TextOperation, op: TextOperation | undefined): Promise<boolean> {
		const before = this.document.getText();
		const expected = apply(before, editorOp);
		if (expected === before) {
			if (op) {
				this.state!.remote(op);
			}
			return true;
		}
		const edit = new vscode.WorkspaceEdit();
		let offset = 0;
		for (const part of editorOp) {
			if (typeof part === 'string') {
				edit.insert(this.document.uri, this.document.positionAt(offset), part);
			} else if (part > 0) {
				offset += part;
			} else {
				edit.delete(this.document.uri, new vscode.Range(this.document.positionAt(offset), this.document.positionAt(offset - part)));
				offset -= part;
			}
		}
		const applying: Applying = this.applying = { op, expected, landed: false };
		try {
			await vscode.workspace.applyEdit(edit);
		} catch {
			// Refused; handled below.
		}
		this.applying = undefined;
		if (!applying.landed && this.document.getText() === expected) {
			this.landed(applying);
		}
		return applying.landed;
	}

	private landed(applying: Applying): void {
		applying.landed = true;
		if (applying.op) {
			this.state!.remote(applying.op);
		}
	}

	/** Called for every change to the document. */
	onDidChange(e: vscode.TextDocumentChangeEvent): void {
		if (!e.contentChanges.length) {
			return;
		}
		const applying = this.applying;
		if (applying && !applying.landed && e.document.getText() === applying.expected) {
			this.landed(applying);
			return;
		}
		if (!this.state || this.status !== 'live' || !this.canEdit) {
			// Offline: the change is picked up when the session comes back.
			return;
		}
		const op = replacementsOperation(e.contentChanges.map(change => ({ offset: change.rangeOffset, deleteLength: change.rangeLength, text: change.text })));
		for (const peer of this.peers.values()) {
			peer.selections = peer.selections.map(([anchor, head]) => [transformOffset(anchor, op), transformOffset(head, op)]);
		}
		this.send(this.state.local(op));
		this.changed();
	}

	private send(op: TextOperation | undefined): void {
		if (!op || !this.state) {
			return;
		}
		this.account.client.liveEdit(this.teamId, this.noteId, this.client, this.state.revision, op).catch(() => {
			if (!this.disposed) {
				this.reconnectLater();
			}
		});
	}

	private saved(data: { revision: number; version: number; updatedAt: number }): void {
		const state = this.state;
		if (!state || state.revision !== data.revision) {
			return;
		}
		this.teamFs.liveSaved(this.document.uri, data.version, state.confirmed, data.updatedAt);
		// Everything here is on the server: clear the unsaved marker.
		if (!state.pending && this.document.isDirty && this.document.getText() === state.confirmed) {
			this.document.save();
		}
	}

	/** Tells the others where our cursors are, shortly after they stop moving. */
	shareSelection(): void {
		clearTimeout(this.selectionTimer);
		this.selectionTimer = setTimeout(() => {
			const editor = vscode.window.visibleTextEditors.find(e => e.document === this.document);
			if (!editor || !this.state || this.status !== 'live') {
				return;
			}
			const state = this.state;
			// Our unconfirmed edits are not on the server yet; leave them out.
			const pending = [state.outstanding, state.buffer].filter((op): op is TextOperation => !!op);
			const toServer = (position: vscode.Position) => {
				let offset = this.document.offsetAt(position);
				for (const op of pending.reverse()) {
					offset = transformOffset(offset, invertInserts(op));
				}
				return Math.min(offset, state.confirmed.length);
			};
			const selections = editor.selections.map(s => [toServer(s.anchor), toServer(s.active)] as [number, number]);
			this.account.client.liveSelect(this.teamId, this.noteId, this.client, state.revision, selections).catch(() => undefined);
		}, 150);
	}
}

/**
 * Roughly undoes an edit's effect on offsets: what it inserted is removed.
 * Good enough for showing a cursor; edits are never transformed this way.
 */
function invertInserts(op: TextOperation): TextOperation {
	return op.filter(part => typeof part === 'string' || part > 0).map(part => typeof part === 'string' ? -part.length : part);
}

/**
 * Starts a live session for every team note open in an editor, shows where
 * teammates are typing, and says in the status bar who else is there.
 */
export class LiveEditing implements vscode.Disposable {
	private readonly sessions = new Map<string, LiveSession>();
	private readonly cursorTypes = new Map<string, { caret: vscode.TextEditorDecorationType; selection: vscode.TextEditorDecorationType }>();
	private readonly status = vscode.window.createStatusBarItem('nighthawk.notes.live', vscode.StatusBarAlignment.Right, 101);
	private readonly disposables: vscode.Disposable[] = [this.status];
	private renderTimer: ReturnType<typeof setTimeout> | undefined;
	private nameTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(private readonly account: Account, private readonly teamFs: TeamFileSystem) {
		this.status.name = vscode.l10n.t('Live Note Editing');
		this.status.command = 'nighthawk.notes.live.showPeople';
		this.disposables.push(
			vscode.workspace.onDidOpenTextDocument(document => this.open(document)),
			vscode.workspace.onDidCloseTextDocument(document => this.close(document)),
			vscode.workspace.onDidChangeTextDocument(e => this.sessions.get(e.document.uri.toString())?.onDidChange(e)),
			vscode.window.onDidChangeTextEditorSelection(e => this.sessions.get(e.textEditor.document.uri.toString())?.shareSelection()),
			vscode.window.onDidChangeVisibleTextEditors(() => this.render()),
			vscode.window.onDidChangeActiveTextEditor(() => this.render()),
			// A new note, or teams loaded after the editor opened.
			teamFs.onDidChangeTeams(() => this.openAll()),
			account.onDidChange(() => this.restart()),
			vscode.workspace.onDidChangeConfiguration(e => {
				if (e.affectsConfiguration('nighthawk.notes.teams.liveEditing')) {
					this.restart();
				}
			}),
			vscode.commands.registerCommand('nighthawk.notes.live.showPeople', () => this.showPeople()),
		);
		this.openAll();
	}

	dispose(): void {
		clearTimeout(this.renderTimer);
		clearTimeout(this.nameTimer);
		this.sessions.forEach(session => session.dispose());
		this.cursorTypes.forEach(types => {
			types.caret.dispose();
			types.selection.dispose();
		});
		this.disposables.forEach(d => d.dispose());
	}

	private restart(): void {
		this.sessions.forEach(session => session.dispose());
		this.sessions.clear();
		this.openAll();
		this.render();
	}

	private openAll(): void {
		vscode.workspace.textDocuments.forEach(document => this.open(document));
	}

	private open(document: vscode.TextDocument): void {
		const key = document.uri.toString();
		if (document.uri.scheme !== TEAM_SCHEME || this.sessions.has(key) || !this.account.user || !config().get<boolean>('teams.liveEditing', true)) {
			return;
		}
		const note = this.teamFs.noteAt(document.uri);
		const team = this.teamFs.getTeam(document.uri.authority);
		if (!note || !team) {
			return;
		}
		this.sessions.set(key, new LiveSession(document, note.id, ROLE_RANK[team.role] >= ROLE_RANK.editor, this.account, this.teamFs, () => this.render()));
	}

	private close(document: vscode.TextDocument): void {
		const key = document.uri.toString();
		this.sessions.get(key)?.dispose();
		this.sessions.delete(key);
		this.render();
	}

	/** Redraws cursors and the status bar soon, once for several changes. */
	private render(): void {
		clearTimeout(this.renderTimer);
		this.renderTimer = setTimeout(() => this.renderNow(), 16);
	}

	private renderNow(): void {
		const now = Date.now();
		let nextNameChange = Infinity;
		for (const editor of vscode.window.visibleTextEditors) {
			const session = this.sessions.get(editor.document.uri.toString());
			const byColor = new Map<string, { carets: vscode.DecorationOptions[]; selections: vscode.Range[] }>();
			for (const peer of session?.status === 'live' ? session.peers.values() : []) {
				const entry = byColor.get(peer.color) ?? { carets: [], selections: [] };
				byColor.set(peer.color, entry);
				const showName = now - peer.movedAt < NAME_VISIBLE_MS;
				if (showName) {
					nextNameChange = Math.min(nextNameChange, peer.movedAt + NAME_VISIBLE_MS);
				}
				peer.selections.forEach(([anchor, head], index) => {
					const length = editor.document.getText().length;
					const start = editor.document.positionAt(Math.min(anchor, head, length));
					const end = editor.document.positionAt(Math.min(Math.max(anchor, head), length));
					const caret = editor.document.positionAt(Math.min(head, length));
					if (!start.isEqual(end)) {
						entry.selections.push(new vscode.Range(start, end));
					}
					entry.carets.push({
						range: new vscode.Range(caret, caret),
						hoverMessage: vscode.l10n.t('{0} is here', peer.name),
						renderOptions: showName && index === 0 ? { after: { contentText: peer.name } } : undefined,
					});
				});
			}
			for (const [color, types] of this.cursorTypes) {
				editor.setDecorations(types.caret, byColor.get(color)?.carets ?? []);
				editor.setDecorations(types.selection, byColor.get(color)?.selections ?? []);
			}
			for (const [color, entry] of byColor) {
				if (!this.cursorTypes.has(color)) {
					const types = this.createCursorTypes(color);
					editor.setDecorations(types.caret, entry.carets);
					editor.setDecorations(types.selection, entry.selections);
				}
			}
		}
		clearTimeout(this.nameTimer);
		if (nextNameChange !== Infinity) {
			this.nameTimer = setTimeout(() => this.render(), nextNameChange - now + 50);
		}
		this.renderStatus();
	}

	private createCursorTypes(color: string) {
		const types = {
			caret: vscode.window.createTextEditorDecorationType({
				rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
				before: {
					contentText: '\u200b',
					border: `solid ${color}`,
					// A 2px line the height of the text, taking no space.
					textDecoration: 'none; border-width: 0 0 0 2px; margin-left: -1px; margin-right: -1px; position: relative; z-index: 1',
				},
				after: {
					backgroundColor: color,
					color: '#ffffff',
					fontWeight: '600',
					// A small name tag above the cursor, out of the text's way.
					textDecoration: 'none; position: absolute; transform: translate(-2px, -100%); font-size: 0.75em; line-height: 1.4; padding: 0 4px; border-radius: 3px 3px 3px 0; white-space: nowrap; pointer-events: none; z-index: 2',
				},
				overviewRulerColor: color,
				overviewRulerLane: vscode.OverviewRulerLane.Center,
			}),
			selection: vscode.window.createTextEditorDecorationType({
				backgroundColor: `${color}33`,
				rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
			}),
		};
		this.cursorTypes.set(color, types);
		return types;
	}

	private activeSession(): LiveSession | undefined {
		const document = vscode.window.activeTextEditor?.document;
		return document && this.sessions.get(document.uri.toString());
	}

	private renderStatus(): void {
		const session = this.activeSession();
		if (!session || session.status === 'unavailable') {
			this.status.hide();
			return;
		}
		const names = [...session.peers.values()].map(peer => peer.name);
		const tooltip = new vscode.MarkdownString(undefined, true);
		this.status.backgroundColor = undefined;
		switch (session.status) {
			case 'connecting':
				this.status.text = `$(sync~spin) ${vscode.l10n.t('Connecting')}`;
				tooltip.appendText(vscode.l10n.t('Joining this note\'s live session...'));
				break;
			case 'offline':
				this.status.text = `$(debug-disconnect) ${vscode.l10n.t('Offline')}`;
				this.status.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
				tooltip.appendText(vscode.l10n.t('Not connected to the notes server. Your changes stay here and are merged when the connection is back.'));
				break;
			case 'live':
				this.status.text = names.length ? `$(broadcast) ${names.length + 1}` : `$(broadcast) ${vscode.l10n.t('Live')}`;
				tooltip.appendMarkdown(`**${vscode.l10n.t('Live editing')}**\n\n`);
				if (names.length) {
					tooltip.appendText(vscode.l10n.t('Also here: {0}', names.join(', ')));
				} else {
					tooltip.appendText(vscode.l10n.t('Teammates who open this note see your changes as you type.'));
				}
				break;
		}
		this.status.tooltip = tooltip;
		this.status.accessibilityInformation = { label: session.status === 'live' && names.length ? vscode.l10n.t('Live editing with {0}', names.join(', ')) : this.status.text.replace(/\$\([^)]*\)\s*/, '') };
		this.status.show();
	}

	/** Lists who else is in the active note and jumps to the one picked. */
	private async showPeople(): Promise<void> {
		const session = this.activeSession();
		const editor = vscode.window.activeTextEditor;
		if (!session || !editor) {
			return;
		}
		const peers = [...session.peers.values()];
		if (!peers.length) {
			vscode.window.showInformationMessage(vscode.l10n.t('Nobody else has this note open right now.'));
			return;
		}
		const pick = await vscode.window.showQuickPick(peers.map(peer => ({
			label: `$(account) ${peer.name}`,
			description: peer.canEdit ? undefined : vscode.l10n.t('viewing'),
			peer,
		})), { placeHolder: vscode.l10n.t('Go to where a teammate is') });
		const offset = pick?.peer.selections[0]?.[1];
		if (offset !== undefined) {
			const position = editor.document.positionAt(offset);
			editor.selection = new vscode.Selection(position, position);
			editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
		}
	}
}
