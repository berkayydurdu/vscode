/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ServerResponse } from 'node:http';
import type { Store, User } from './store.ts';
import { apply, baseLength, diffOperation, transform, transformOffset, type TextOperation } from './textOperation.ts';

/** How long the server waits after the last edit before saving a live note. */
const SAVE_DELAY_MS = 1000;
/** Edits kept to transform late operations against; older clients start over. */
const HISTORY_LIMIT = 2000;
const HEARTBEAT_MS = 20_000;

/** Colors given to people in the order they join a note, as in the editor's cursors. */
const COLORS = ['#e5484d', '#30a46c', '#0090ff', '#f76b15', '#8e4ec6', '#12a594', '#d6409f', '#ffc53d'];

/** A selection as offsets into the note: where it started and where the cursor is. */
export type Selection = [anchor: number, head: number];

interface Peer {
	client: string;
	userId: string;
	name: string;
	color: string;
	canEdit: boolean;
	selections: Selection[];
	res: ServerResponse;
}

interface LiveNote {
	teamId: string;
	noteId: string;
	content: string;
	revision: number;
	/** Operations from revision `revision - history.length` on. */
	history: TextOperation[];
	peers: Map<string, Peer>;
	saveTimer: ReturnType<typeof setTimeout> | undefined;
	/** Who made the edits not saved yet, credited when they are. */
	lastEditor: string | undefined;
	heartbeat: ReturnType<typeof setInterval>;
}

export class LiveError extends Error {
	readonly status: number;
	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

/**
 * Notes being edited together right now. Each person's editor streams the
 * note's changes from the server (server-sent events) and posts its own
 * edits, which the server puts in order, adjusts for edits made at the same
 * time, and sends to everyone. The note is saved shortly after each pause.
 */
export class LiveNotes {
	private readonly notes = new Map<string, LiveNote>();
	private readonly store: Store;

	constructor(store: Store) {
		this.store = store;
	}

	/** Starts streaming a note to one editor. The response stays open until it leaves. */
	join(teamId: string, noteId: string, client: string, user: User, canEdit: boolean, res: ServerResponse): void {
		let note = this.notes.get(noteId);
		if (!note) {
			const stored = this.store.getNote(teamId, noteId);
			if (!stored || stored.deleted) {
				throw new LiveError(404, 'Note not found');
			}
			note = {
				teamId, noteId, content: stored.content, revision: 0, history: [], peers: new Map(), saveTimer: undefined, lastEditor: undefined,
				heartbeat: setInterval(() => this.broadcast(note!, ': ping\n\n'), HEARTBEAT_MS),
			};
			this.notes.set(noteId, note);
		}
		const existing = note.peers.get(client);
		existing?.res.end();
		const used = new Set([...note.peers.values()].map(peer => peer.color));
		const peer: Peer = {
			client, userId: user.id, name: user.name, canEdit, selections: [], res,
			color: existing?.color ?? COLORS.find(color => !used.has(color)) ?? COLORS[note.peers.size % COLORS.length],
		};
		note.peers.set(client, peer);
		res.writeHead(200, {
			'Content-Type': 'text/event-stream; charset=utf-8',
			'Cache-Control': 'no-store',
			'Connection': 'keep-alive',
			'X-Accel-Buffering': 'no',
		});
		send(res, 'init', { revision: note.revision, content: note.content, color: peer.color, peers: [...note.peers.values()].filter(p => p !== peer).map(describe) });
		this.broadcast(note, event('join', describe(peer)), peer);
		const current = note;
		res.on('close', () => this.leave(current, peer));
	}

	private leave(note: LiveNote, peer: Peer): void {
		if (note.peers.get(peer.client) !== peer) {
			return;
		}
		note.peers.delete(peer.client);
		this.broadcast(note, event('leave', { client: peer.client }));
		if (!note.peers.size) {
			this.close(note);
		}
	}

	/** Saves and forgets a note nobody is editing any more. */
	private close(note: LiveNote): void {
		clearInterval(note.heartbeat);
		this.save(note);
		if (this.notes.get(note.noteId) === note) {
			this.notes.delete(note.noteId);
		}
	}

	private peer(noteId: string, client: string, userId: string): { note: LiveNote; peer: Peer } {
		const note = this.notes.get(noteId);
		const peer = note?.peers.get(client);
		if (!note || !peer || peer.userId !== userId) {
			throw new LiveError(409, 'Not connected to this note; join it again');
		}
		return { note, peer };
	}

	/**
	 * Applies one person's edit, made on top of `revision`, after adjusting it
	 * for the edits others made since. Everyone, the sender included, gets it
	 * in order on their stream; the sender takes its own as confirmation.
	 */
	edit(noteId: string, client: string, userId: string, revision: number, op: TextOperation, maxLength: number): number {
		const { note, peer } = this.peer(noteId, client, userId);
		if (!peer.canEdit) {
			throw new LiveError(403, 'This needs the editor role or higher');
		}
		const oldest = note.revision - note.history.length;
		if (!Number.isInteger(revision) || revision > note.revision) {
			throw new LiveError(400, 'Unknown revision');
		}
		if (revision < oldest) {
			throw new LiveError(409, 'Too far behind; join the note again');
		}
		for (const concurrent of note.history.slice(revision - oldest)) {
			op = transform(op, concurrent)[0];
		}
		if (baseLength(op) > note.content.length) {
			throw new LiveError(400, 'The edit does not fit the note');
		}
		const content = apply(note.content, op);
		if (Buffer.byteLength(content) > maxLength) {
			throw new LiveError(413, 'The note is too large');
		}
		this.commit(note, op, content, client, userId);
		return note.revision;
	}

	private commit(note: LiveNote, op: TextOperation, content: string, client: string, userId: string): void {
		note.content = content;
		note.revision++;
		note.history.push(op);
		if (note.history.length > HISTORY_LIMIT) {
			note.history.splice(0, note.history.length - HISTORY_LIMIT);
		}
		for (const peer of note.peers.values()) {
			peer.selections = peer.selections.map(([anchor, head]) => [transformOffset(anchor, op), transformOffset(head, op)]);
		}
		note.lastEditor = userId;
		this.broadcast(note, event('op', { revision: note.revision, op, client }));
		clearTimeout(note.saveTimer);
		note.saveTimer = setTimeout(() => this.save(note), SAVE_DELAY_MS);
	}

	/** Shares where someone's cursor is, given at `revision`. */
	select(noteId: string, client: string, userId: string, revision: number, selections: Selection[]): void {
		const { note, peer } = this.peer(noteId, client, userId);
		const oldest = note.revision - note.history.length;
		if (!Number.isInteger(revision) || revision > note.revision || revision < oldest) {
			return;
		}
		const later = note.history.slice(revision - oldest);
		const clamp = (offset: number) => Math.max(0, Math.min(note.content.length, later.reduce((at, op) => transformOffset(at, op), offset)));
		peer.selections = selections.slice(0, 20).map(([anchor, head]) => [clamp(anchor), clamp(head)]);
		this.broadcast(note, event('presence', { client, revision: note.revision, selections: peer.selections }), peer);
	}

	/** Someone saved the note outside a live session: their text becomes an edit everyone gets. */
	replaced(noteId: string, content: string, userId: string): void {
		const note = this.notes.get(noteId);
		if (note && note.content !== content) {
			this.commit(note, diffOperation(note.content, content), content, '', userId);
		}
	}

	/** The note was deleted: tell everyone and stop. */
	deleted(noteId: string): void {
		const note = this.notes.get(noteId);
		if (note) {
			clearTimeout(note.saveTimer);
			note.saveTimer = undefined;
			note.lastEditor = undefined;
			this.broadcast(note, event('deleted', {}));
			clearInterval(note.heartbeat);
			this.notes.delete(noteId);
			for (const peer of note.peers.values()) {
				peer.res.end();
			}
		}
	}

	/** Saves every live note now, for shutting down. */
	saveAll(): void {
		for (const note of this.notes.values()) {
			this.save(note);
		}
	}

	private save(note: LiveNote): void {
		clearTimeout(note.saveTimer);
		note.saveTimer = undefined;
		const editor = note.lastEditor;
		if (!editor) {
			return;
		}
		note.lastEditor = undefined;
		try {
			const stored = this.store.getNote(note.teamId, note.noteId);
			if (!stored || stored.deleted || stored.content === note.content) {
				return;
			}
			const saved = this.store.updateNote(note.teamId, note.noteId, stored.version, { content: note.content }, editor);
			if (saved) {
				this.broadcast(note, event('saved', { revision: note.revision, version: saved.version, updatedAt: saved.updatedAt }));
			}
		} catch (err) {
			console.error(`Could not save live note ${note.noteId}`, err);
		}
	}

	private broadcast(note: LiveNote, message: string, except?: Peer): void {
		for (const peer of note.peers.values()) {
			if (peer !== except) {
				peer.res.write(message);
			}
		}
	}
}

function describe(peer: Peer) {
	return { client: peer.client, userId: peer.userId, name: peer.name, color: peer.color, canEdit: peer.canEdit, selections: peer.selections };
}

function event(name: string, data: unknown): string {
	return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

function send(res: ServerResponse, name: string, data: unknown): void {
	res.write(event(name, data));
}
