/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { NoteIndex } from '../noteIndex';
import { config } from '../vault';
import { Account } from './account';
import { NotesServerError, ROLE_RANK, type NoteMeta, type Team } from './client';

export const TEAM_SCHEME = 'nighthawk-team';

export function teamCollection(teamId: string): string {
	return `team:${teamId}`;
}

/** `nighthawk-team://<teamId>/<path>` */
export function teamNoteUri(teamId: string, path = ''): vscode.Uri {
	return vscode.Uri.from({ scheme: TEAM_SCHEME, authority: teamId, path: '/' + path });
}

export function teamPathOf(uri: vscode.Uri): string {
	return uri.path.replace(/^\/+/, '').replace(/\/+$/, '');
}

interface TeamState {
	team: Team;
	notes: Map<string, NoteMeta & { content: string }>;
	/** Folders created in the editor that have no notes yet. */
	emptyFolders: Set<string>;
	cursor: number;
	loaded: Promise<void> | undefined;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Shows each team's shared notes as a folder of Markdown files, so they open
 * in normal editors. Saving writes to the server with the version the editor
 * started from, so concurrent edits are caught instead of lost.
 */
export class TeamFileSystem implements vscode.FileSystemProvider, vscode.Disposable {

	private readonly teams = new Map<string, TeamState>();
	private readonly onDidChangeFileEmitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
	readonly onDidChangeFile = this.onDidChangeFileEmitter.event;
	private readonly onDidChangeTeamsEmitter = new vscode.EventEmitter<void>();
	/** Fires when the team list or any team's notes change. */
	readonly onDidChangeTeams = this.onDidChangeTeamsEmitter.event;
	private pollTimer: ReturnType<typeof setInterval> | undefined;
	private readonly disposables: vscode.Disposable[] = [];

	constructor(private readonly account: Account, private readonly index: NoteIndex) {
		this.disposables.push(
			account.onDidChange(() => this.reloadTeams()),
			vscode.workspace.onDidChangeConfiguration(e => {
				if (e.affectsConfiguration('nighthawk.notes.teams.syncInterval')) {
					this.schedulePolling();
				}
			}),
			// Keep links and backlinks current while a team note is being edited.
			vscode.workspace.onDidChangeTextDocument(e => {
				if (e.document.uri.scheme === TEAM_SCHEME) {
					this.index.set(teamCollection(e.document.uri.authority), e.document.uri, teamPathOf(e.document.uri), e.document.getText());
				}
			}),
		);
		this.schedulePolling();
	}

	dispose(): void {
		clearInterval(this.pollTimer);
		this.disposables.forEach(d => d.dispose());
		this.onDidChangeFileEmitter.dispose();
		this.onDidChangeTeamsEmitter.dispose();
	}

	allTeams(): Team[] {
		return [...this.teams.values()].map(state => state.team);
	}

	getTeam(teamId: string): Team | undefined {
		return this.teams.get(teamId)?.team;
	}

	notesOf(teamId: string): NoteMeta[] {
		return [...this.teams.get(teamId)?.notes.values() ?? []];
	}

	async reloadTeams(): Promise<void> {
		for (const teamId of this.teams.keys()) {
			this.index.clearCollection(teamCollection(teamId));
		}
		this.teams.clear();
		if (this.account.user) {
			try {
				for (const team of await this.account.client.teams()) {
					this.teams.set(team.id, { team, notes: new Map(), emptyFolders: new Set(), cursor: 0, loaded: undefined });
				}
			} catch (err) {
				vscode.window.showWarningMessage(vscode.l10n.t('Could not load your teams: {0}', err.message));
			}
		}
		await vscode.commands.executeCommand('setContext', 'nighthawk.notes.hasTeams', this.teams.size > 0);
		this.onDidChangeTeamsEmitter.fire();
		await Promise.all([...this.teams.keys()].map(teamId => this.ensureLoaded(teamId).catch(() => undefined)));
	}

	private schedulePolling(): void {
		clearInterval(this.pollTimer);
		const seconds = config().get<number>('teams.syncInterval', 15);
		if (seconds > 0) {
			this.pollTimer = setInterval(() => this.syncAll(), Math.max(5, seconds) * 1000);
		}
	}

	async syncAll(): Promise<void> {
		if (!this.account.user) {
			return;
		}
		await Promise.all([...this.teams.keys()].map(teamId => this.sync(teamId).catch(() => undefined)));
	}

	private ensureLoaded(teamId: string): Promise<void> {
		const state = this.teams.get(teamId);
		if (!state) {
			return Promise.reject(vscode.FileSystemError.FileNotFound(teamNoteUri(teamId)));
		}
		state.loaded ??= this.sync(teamId).catch(err => {
			state.loaded = undefined;
			throw err;
		});
		return state.loaded;
	}

	/** Pulls changes since the last sync and tells open editors about them. */
	async sync(teamId: string): Promise<void> {
		const state = this.teams.get(teamId);
		if (!state) {
			return;
		}
		let result;
		try {
			result = await this.account.client.notes(teamId, state.cursor);
		} catch (err) {
			if (err instanceof NotesServerError && err.status === 404) {
				// Removed from the team, or the team was deleted.
				await this.reloadTeams();
				return;
			}
			throw err;
		}
		const events: vscode.FileChangeEvent[] = [];
		for (const note of result.notes) {
			const previous = [...state.notes.values()].find(n => n.id === note.id);
			if (previous && previous.path !== note.path) {
				state.notes.delete(previous.path);
				this.index.delete(teamNoteUri(teamId, previous.path));
				events.push({ type: vscode.FileChangeType.Deleted, uri: teamNoteUri(teamId, previous.path) });
			}
			const uri = teamNoteUri(teamId, note.path);
			if (note.deleted) {
				if (state.notes.delete(note.path)) {
					this.index.delete(uri);
					events.push({ type: vscode.FileChangeType.Deleted, uri });
				}
				continue;
			}
			const known = state.notes.get(note.path);
			if (known?.version === note.version) {
				continue;
			}
			state.notes.set(note.path, { ...note, content: note.content ?? '' });
			this.indexNote(teamId, note.path, note.content ?? '');
			events.push({ type: known ? vscode.FileChangeType.Changed : vscode.FileChangeType.Created, uri });
		}
		state.cursor = result.cursor;
		if (events.length) {
			this.onDidChangeFileEmitter.fire(events);
			this.onDidChangeTeamsEmitter.fire();
		}
	}

	private indexNote(teamId: string, path: string, content: string): void {
		const uri = teamNoteUri(teamId, path);
		// An open editor with unsaved changes is newer than the server copy.
		const open = vscode.workspace.textDocuments.find(doc => doc.uri.toString() === uri.toString() && doc.isDirty);
		this.index.set(teamCollection(teamId), uri, path, open ? open.getText() : content);
	}

	private async state(uri: vscode.Uri): Promise<TeamState> {
		await this.ensureLoaded(uri.authority);
		return this.teams.get(uri.authority)!;
	}

	private canEdit(state: TeamState): boolean {
		return ROLE_RANK[state.team.role] >= ROLE_RANK.editor;
	}

	private assertCanEdit(state: TeamState): void {
		if (!this.canEdit(state)) {
			throw vscode.FileSystemError.NoPermissions(vscode.l10n.t('You are a viewer in {0} and cannot change its notes', state.team.name));
		}
	}

	// --- FileSystemProvider

	watch(): vscode.Disposable {
		// Changes are pushed from sync() for every loaded team.
		return new vscode.Disposable(() => { });
	}

	async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
		const state = await this.state(uri);
		const path = teamPathOf(uri);
		const permissions = this.canEdit(state) ? undefined : vscode.FilePermission.Readonly;
		const note = state.notes.get(path);
		if (note) {
			return { type: vscode.FileType.File, ctime: note.updatedAt, mtime: note.updatedAt, size: encoder.encode(note.content).byteLength, permissions };
		}
		if (this.isFolder(state, path)) {
			return { type: vscode.FileType.Directory, ctime: 0, mtime: 0, size: 0, permissions };
		}
		throw vscode.FileSystemError.FileNotFound(uri);
	}

	private isFolder(state: TeamState, path: string): boolean {
		if (!path || state.emptyFolders.has(path)) {
			return true;
		}
		const prefix = path + '/';
		return [...state.notes.keys()].some(p => p.startsWith(prefix)) || [...state.emptyFolders].some(p => p.startsWith(prefix));
	}

	async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
		const state = await this.state(uri);
		const path = teamPathOf(uri);
		if (!this.isFolder(state, path)) {
			throw vscode.FileSystemError.FileNotADirectory(uri);
		}
		const prefix = path ? path + '/' : '';
		const entries = new Map<string, vscode.FileType>();
		for (const p of [...state.notes.keys(), ...state.emptyFolders]) {
			if (!p.startsWith(prefix)) {
				continue;
			}
			const rest = p.slice(prefix.length).split('/');
			const isFile = rest.length === 1 && state.notes.has(p);
			entries.set(rest[0], isFile ? vscode.FileType.File : vscode.FileType.Directory);
		}
		return [...entries];
	}

	async createDirectory(uri: vscode.Uri): Promise<void> {
		const state = await this.state(uri);
		this.assertCanEdit(state);
		state.emptyFolders.add(teamPathOf(uri));
		this.onDidChangeFileEmitter.fire([{ type: vscode.FileChangeType.Created, uri }]);
		this.onDidChangeTeamsEmitter.fire();
	}

	async readFile(uri: vscode.Uri): Promise<Uint8Array> {
		const state = await this.state(uri);
		const note = state.notes.get(teamPathOf(uri));
		if (!note) {
			throw vscode.FileSystemError.FileNotFound(uri);
		}
		return encoder.encode(note.content);
	}

	async writeFile(uri: vscode.Uri, content: Uint8Array, options: { create: boolean; overwrite: boolean }): Promise<void> {
		const state = await this.state(uri);
		this.assertCanEdit(state);
		const path = teamPathOf(uri);
		const text = decoder.decode(content);
		const existing = state.notes.get(path);
		if (existing && !options.overwrite) {
			throw vscode.FileSystemError.FileExists(uri);
		}
		if (!existing && !options.create) {
			throw vscode.FileSystemError.FileNotFound(uri);
		}
		if (!path.toLowerCase().endsWith('.md')) {
			throw vscode.FileSystemError.NoPermissions(vscode.l10n.t('Team notes must be Markdown files ending in .md'));
		}
		let saved: NoteMeta;
		try {
			saved = existing
				? await this.account.client.updateNote(uri.authority, existing.id, existing.version, { content: text })
				: await this.account.client.createNote(uri.authority, path, text);
		} catch (err) {
			if (err instanceof NotesServerError && err.status === 409) {
				// Someone else saved first. Pull their version so the editor's
				// own "file is newer" check offers compare and overwrite.
				await this.sync(uri.authority).catch(() => undefined);
				throw vscode.FileSystemError.Unavailable(vscode.l10n.t('{0} Save again to compare or overwrite.', err.message));
			}
			throw vscode.FileSystemError.Unavailable(err.message);
		}
		state.notes.set(path, { ...saved, content: text });
		this.removeEmptyFolderMarkers(state, path);
		this.indexNote(uri.authority, path, text);
		this.onDidChangeFileEmitter.fire([{ type: existing ? vscode.FileChangeType.Changed : vscode.FileChangeType.Created, uri }]);
		if (!existing) {
			this.onDidChangeTeamsEmitter.fire();
		}
	}

	private removeEmptyFolderMarkers(state: TeamState, notePath: string): void {
		for (const folder of state.emptyFolders) {
			if (notePath.startsWith(folder + '/')) {
				state.emptyFolders.delete(folder);
			}
		}
	}

	async delete(uri: vscode.Uri): Promise<void> {
		const state = await this.state(uri);
		this.assertCanEdit(state);
		const path = teamPathOf(uri);
		const targets = [...state.notes.values()].filter(n => n.path === path || n.path.startsWith(path + '/'));
		if (!targets.length && !this.isFolder(state, path)) {
			throw vscode.FileSystemError.FileNotFound(uri);
		}
		for (const note of targets) {
			await this.account.client.deleteNote(uri.authority, note.id);
			state.notes.delete(note.path);
			this.index.delete(teamNoteUri(uri.authority, note.path));
		}
		for (const folder of state.emptyFolders) {
			if (folder === path || folder.startsWith(path + '/')) {
				state.emptyFolders.delete(folder);
			}
		}
		this.onDidChangeFileEmitter.fire([{ type: vscode.FileChangeType.Deleted, uri }]);
		this.onDidChangeTeamsEmitter.fire();
	}

	async rename(oldUri: vscode.Uri, newUri: vscode.Uri, options: { overwrite: boolean }): Promise<void> {
		if (oldUri.authority !== newUri.authority) {
			throw vscode.FileSystemError.NoPermissions(vscode.l10n.t('Notes cannot be moved between teams; copy them instead'));
		}
		const state = await this.state(oldUri);
		this.assertCanEdit(state);
		const from = teamPathOf(oldUri);
		const to = teamPathOf(newUri);
		if (!options.overwrite && (state.notes.has(to) || this.isFolder(state, to))) {
			throw vscode.FileSystemError.FileExists(newUri);
		}
		const moves = [...state.notes.values()]
			.filter(n => n.path === from || n.path.startsWith(from + '/'))
			.map(n => ({ note: n, path: n.path === from ? to : to + n.path.slice(from.length) }));
		if (moves.some(m => !m.path.toLowerCase().endsWith('.md'))) {
			throw vscode.FileSystemError.NoPermissions(vscode.l10n.t('Team notes must be Markdown files ending in .md'));
		}
		for (const { note, path } of moves) {
			const saved = await this.account.client.updateNote(oldUri.authority, note.id, note.version, { path });
			state.notes.delete(note.path);
			this.index.delete(teamNoteUri(oldUri.authority, note.path));
			state.notes.set(path, { ...saved, content: note.content });
			this.indexNote(oldUri.authority, path, note.content);
		}
		for (const folder of [...state.emptyFolders]) {
			if (folder === from || folder.startsWith(from + '/')) {
				state.emptyFolders.delete(folder);
				state.emptyFolders.add(to + folder.slice(from.length));
			}
		}
		this.onDidChangeFileEmitter.fire([
			{ type: vscode.FileChangeType.Deleted, uri: oldUri },
			{ type: vscode.FileChangeType.Created, uri: newUri },
		]);
		this.onDidChangeTeamsEmitter.fire();
	}
}
