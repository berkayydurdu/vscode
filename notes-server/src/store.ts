/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

export type Role = 'owner' | 'admin' | 'editor' | 'viewer';

export const ROLES: readonly Role[] = ['owner', 'admin', 'editor', 'viewer'];

const ROLE_RANK: Record<Role, number> = { owner: 3, admin: 2, editor: 1, viewer: 0 };

export function roleAtLeast(role: Role, minimum: Role): boolean {
	return ROLE_RANK[role] >= ROLE_RANK[minimum];
}

export function isRole(value: unknown): value is Role {
	return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

export interface User {
	id: string;
	email: string;
	name: string;
	createdAt: number;
}

export interface Team {
	id: string;
	name: string;
	createdAt: number;
}

export interface TeamWithRole extends Team {
	role: Role;
	memberCount: number;
}

export interface Member {
	userId: string;
	email: string;
	name: string;
	role: Role;
	joinedAt: number;
}

export interface Invite {
	code: string;
	teamId: string;
	role: Role;
	createdBy: string;
	createdAt: number;
	expiresAt: number | null;
	maxUses: number | null;
	uses: number;
	revoked: boolean;
}

export interface NoteMeta {
	id: string;
	teamId: string;
	path: string;
	version: number;
	seq: number;
	updatedAt: number;
	updatedBy: string;
	updatedByName: string;
	deleted: boolean;
}

export interface Note extends NoteMeta {
	content: string;
}

type Row = Record<string, unknown>;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
	id TEXT PRIMARY KEY,
	email TEXT NOT NULL UNIQUE,
	name TEXT NOT NULL,
	password_hash TEXT NOT NULL,
	created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
	token_hash TEXT PRIMARY KEY,
	user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	created_at INTEGER NOT NULL,
	expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS teams (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS memberships (
	team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
	user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	role TEXT NOT NULL,
	joined_at INTEGER NOT NULL,
	PRIMARY KEY (team_id, user_id)
);
CREATE TABLE IF NOT EXISTS invites (
	code TEXT PRIMARY KEY,
	team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
	role TEXT NOT NULL,
	created_by TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	expires_at INTEGER,
	max_uses INTEGER,
	uses INTEGER NOT NULL DEFAULT 0,
	revoked INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS notes (
	id TEXT PRIMARY KEY,
	team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
	path TEXT NOT NULL,
	content TEXT NOT NULL,
	version INTEGER NOT NULL,
	seq INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	updated_by TEXT NOT NULL,
	deleted INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS notes_team_path ON notes(team_id, path) WHERE deleted = 0;
CREATE INDEX IF NOT EXISTS notes_team_seq ON notes(team_id, seq);
CREATE TABLE IF NOT EXISTS counters (
	name TEXT PRIMARY KEY,
	value INTEGER NOT NULL
);
`;

export class ConflictError extends Error { }

/**
 * All persistent state of the notes server, kept in one SQLite database.
 */
export class Store {

	private readonly db: DatabaseSync;

	constructor(file: string) {
		this.db = new DatabaseSync(file);
		this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
		this.db.exec(SCHEMA);
	}

	close(): void {
		this.db.close();
	}

	private transaction<T>(fn: () => T): T {
		this.db.exec('BEGIN IMMEDIATE');
		try {
			const result = fn();
			this.db.exec('COMMIT');
			return result;
		} catch (err) {
			this.db.exec('ROLLBACK');
			throw err;
		}
	}

	// --- users and sessions

	createUser(email: string, name: string, passwordHash: string): User {
		const user: User = { id: randomUUID(), email: email.toLowerCase(), name, createdAt: Date.now() };
		this.db.prepare('INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)')
			.run(user.id, user.email, user.name, passwordHash, user.createdAt);
		return user;
	}

	findUserByEmail(email: string): (User & { passwordHash: string }) | undefined {
		const row = this.db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase()) as Row | undefined;
		return row ? { ...toUser(row), passwordHash: String(row.password_hash) } : undefined;
	}

	getUser(id: string): User | undefined {
		const row = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as Row | undefined;
		return row ? toUser(row) : undefined;
	}

	updateUserName(id: string, name: string): void {
		this.db.prepare('UPDATE users SET name = ? WHERE id = ?').run(name, id);
	}

	createSession(tokenHash: string, userId: string, ttlMs: number): void {
		const now = Date.now();
		this.db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
			.run(tokenHash, userId, now, now + ttlMs);
	}

	userForSession(tokenHash: string): User | undefined {
		const row = this.db.prepare(
			'SELECT users.* FROM sessions JOIN users ON users.id = sessions.user_id WHERE token_hash = ? AND expires_at > ?'
		).get(tokenHash, Date.now()) as Row | undefined;
		return row ? toUser(row) : undefined;
	}

	deleteSession(tokenHash: string): void {
		this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
	}

	// --- teams and members

	createTeam(name: string, ownerId: string): Team {
		const team: Team = { id: randomUUID(), name, createdAt: Date.now() };
		this.transaction(() => {
			this.db.prepare('INSERT INTO teams (id, name, created_at) VALUES (?, ?, ?)').run(team.id, team.name, team.createdAt);
			this.db.prepare('INSERT INTO memberships (team_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)')
				.run(team.id, ownerId, 'owner', team.createdAt);
		});
		return team;
	}

	getTeam(id: string): Team | undefined {
		const row = this.db.prepare('SELECT * FROM teams WHERE id = ?').get(id) as Row | undefined;
		return row ? toTeam(row) : undefined;
	}

	renameTeam(id: string, name: string): void {
		this.db.prepare('UPDATE teams SET name = ? WHERE id = ?').run(name, id);
	}

	deleteTeam(id: string): void {
		this.db.prepare('DELETE FROM teams WHERE id = ?').run(id);
	}

	teamsForUser(userId: string): TeamWithRole[] {
		const rows = this.db.prepare(`
			SELECT teams.*, memberships.role AS role,
				(SELECT COUNT(*) FROM memberships m WHERE m.team_id = teams.id) AS member_count
			FROM memberships JOIN teams ON teams.id = memberships.team_id
			WHERE memberships.user_id = ?
			ORDER BY teams.name COLLATE NOCASE
		`).all(userId) as Row[];
		return rows.map(row => ({ ...toTeam(row), role: row.role as Role, memberCount: Number(row.member_count) }));
	}

	roleOf(teamId: string, userId: string): Role | undefined {
		const row = this.db.prepare('SELECT role FROM memberships WHERE team_id = ? AND user_id = ?').get(teamId, userId) as Row | undefined;
		return row ? row.role as Role : undefined;
	}

	members(teamId: string): Member[] {
		const rows = this.db.prepare(`
			SELECT users.id, users.email, users.name, memberships.role, memberships.joined_at
			FROM memberships JOIN users ON users.id = memberships.user_id
			WHERE memberships.team_id = ?
			ORDER BY memberships.joined_at
		`).all(teamId) as Row[];
		return rows.map(row => ({
			userId: String(row.id),
			email: String(row.email),
			name: String(row.name),
			role: row.role as Role,
			joinedAt: Number(row.joined_at),
		}));
	}

	countOwners(teamId: string): number {
		const row = this.db.prepare(`SELECT COUNT(*) AS n FROM memberships WHERE team_id = ? AND role = 'owner'`).get(teamId) as Row;
		return Number(row.n);
	}

	setRole(teamId: string, userId: string, role: Role): void {
		this.db.prepare('UPDATE memberships SET role = ? WHERE team_id = ? AND user_id = ?').run(role, teamId, userId);
	}

	removeMember(teamId: string, userId: string): void {
		this.db.prepare('DELETE FROM memberships WHERE team_id = ? AND user_id = ?').run(teamId, userId);
	}

	// --- invites

	createInvite(code: string, teamId: string, role: Role, createdBy: string, expiresAt: number | null, maxUses: number | null): Invite {
		const invite: Invite = { code, teamId, role, createdBy, createdAt: Date.now(), expiresAt, maxUses, uses: 0, revoked: false };
		this.db.prepare('INSERT INTO invites (code, team_id, role, created_by, created_at, expires_at, max_uses) VALUES (?, ?, ?, ?, ?, ?, ?)')
			.run(code, teamId, role, createdBy, invite.createdAt, expiresAt, maxUses);
		return invite;
	}

	getInvite(code: string): Invite | undefined {
		const row = this.db.prepare('SELECT * FROM invites WHERE code = ?').get(code) as Row | undefined;
		return row ? toInvite(row) : undefined;
	}

	invites(teamId: string): Invite[] {
		const rows = this.db.prepare('SELECT * FROM invites WHERE team_id = ? AND revoked = 0 ORDER BY created_at DESC').all(teamId) as Row[];
		return rows.map(toInvite);
	}

	revokeInvite(code: string): void {
		this.db.prepare('UPDATE invites SET revoked = 1 WHERE code = ?').run(code);
	}

	/**
	 * Adds the user to the invite's team. Returns false when the invite can
	 * no longer be used (revoked, expired or used up).
	 */
	acceptInvite(code: string, userId: string): { teamId: string; role: Role; alreadyMember: boolean } | false {
		return this.transaction(() => {
			const invite = this.getInvite(code);
			if (!invite || !isInviteUsable(invite)) {
				return false;
			}
			const existing = this.roleOf(invite.teamId, userId);
			if (existing) {
				return { teamId: invite.teamId, role: existing, alreadyMember: true };
			}
			this.db.prepare('INSERT INTO memberships (team_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)')
				.run(invite.teamId, userId, invite.role, Date.now());
			this.db.prepare('UPDATE invites SET uses = uses + 1 WHERE code = ?').run(code);
			return { teamId: invite.teamId, role: invite.role, alreadyMember: false };
		});
	}

	// --- notes

	private nextSeq(): number {
		this.db.prepare(`INSERT INTO counters (name, value) VALUES ('seq', 1) ON CONFLICT(name) DO UPDATE SET value = value + 1`).run();
		const row = this.db.prepare(`SELECT value FROM counters WHERE name = 'seq'`).get() as Row;
		return Number(row.value);
	}

	/**
	 * Lists the notes of a team changed after `since` (a sequence number
	 * returned by an earlier call), including deletions so clients can sync.
	 */
	listNotes(teamId: string, since: number, includeContent: boolean): { notes: (NoteMeta | Note)[]; cursor: number } {
		const columns = includeContent ? 'notes.*' : 'notes.id, notes.team_id, notes.path, notes.version, notes.seq, notes.updated_at, notes.updated_by, notes.deleted';
		const rows = this.db.prepare(`
			SELECT ${columns}, users.name AS updated_by_name
			FROM notes LEFT JOIN users ON users.id = notes.updated_by
			WHERE team_id = ? AND seq > ? AND (deleted = 0 OR ? > 0)
			ORDER BY seq
		`).all(teamId, since, since) as Row[];
		const notes = rows.map(row => includeContent ? toNote(row) : toNoteMeta(row));
		const cursorRow = this.db.prepare(`SELECT value FROM counters WHERE name = 'seq'`).get() as Row | undefined;
		return { notes, cursor: cursorRow ? Number(cursorRow.value) : 0 };
	}

	getNote(teamId: string, noteId: string): Note | undefined {
		const row = this.db.prepare(`
			SELECT notes.*, users.name AS updated_by_name
			FROM notes LEFT JOIN users ON users.id = notes.updated_by
			WHERE notes.team_id = ? AND notes.id = ?
		`).get(teamId, noteId) as Row | undefined;
		return row ? toNote(row) : undefined;
	}

	private pathTaken(teamId: string, path: string, exceptId?: string): boolean {
		const row = this.db.prepare('SELECT id FROM notes WHERE team_id = ? AND path = ? AND deleted = 0').get(teamId, path) as Row | undefined;
		return !!row && row.id !== exceptId;
	}

	createNote(teamId: string, path: string, content: string, userId: string): Note {
		return this.transaction(() => {
			if (this.pathTaken(teamId, path)) {
				throw new ConflictError(`A note already exists at ${path}`);
			}
			const id = randomUUID();
			this.db.prepare('INSERT INTO notes (id, team_id, path, content, version, seq, updated_at, updated_by) VALUES (?, ?, ?, ?, 1, ?, ?, ?)')
				.run(id, teamId, path, content, this.nextSeq(), Date.now(), userId);
			return this.getNote(teamId, id)!;
		});
	}

	/**
	 * Updates a note if `baseVersion` matches the stored version, so two
	 * people editing the same note cannot silently overwrite each other.
	 */
	updateNote(teamId: string, noteId: string, baseVersion: number, change: { path?: string; content?: string }, userId: string): Note | undefined {
		return this.transaction(() => {
			const current = this.getNote(teamId, noteId);
			if (!current || current.deleted) {
				return undefined;
			}
			if (current.version !== baseVersion) {
				throw new ConflictError(`Note was changed by ${current.updatedByName} (version ${current.version})`);
			}
			const path = change.path ?? current.path;
			if (path !== current.path && this.pathTaken(teamId, path, noteId)) {
				throw new ConflictError(`A note already exists at ${path}`);
			}
			this.db.prepare('UPDATE notes SET path = ?, content = ?, version = version + 1, seq = ?, updated_at = ?, updated_by = ? WHERE id = ?')
				.run(path, change.content ?? current.content, this.nextSeq(), Date.now(), userId, noteId);
			return this.getNote(teamId, noteId);
		});
	}

	deleteNote(teamId: string, noteId: string, userId: string): boolean {
		return this.transaction(() => {
			const current = this.getNote(teamId, noteId);
			if (!current || current.deleted) {
				return false;
			}
			this.db.prepare(`UPDATE notes SET deleted = 1, content = '', version = version + 1, seq = ?, updated_at = ?, updated_by = ? WHERE id = ?`)
				.run(this.nextSeq(), Date.now(), userId, noteId);
			return true;
		});
	}
}

export function isInviteUsable(invite: Invite, now = Date.now()): boolean {
	return !invite.revoked
		&& (invite.expiresAt === null || invite.expiresAt > now)
		&& (invite.maxUses === null || invite.uses < invite.maxUses);
}

function toUser(row: Row): User {
	return { id: String(row.id), email: String(row.email), name: String(row.name), createdAt: Number(row.created_at) };
}

function toTeam(row: Row): Team {
	return { id: String(row.id), name: String(row.name), createdAt: Number(row.created_at) };
}

function toInvite(row: Row): Invite {
	return {
		code: String(row.code),
		teamId: String(row.team_id),
		role: row.role as Role,
		createdBy: String(row.created_by),
		createdAt: Number(row.created_at),
		expiresAt: row.expires_at === null ? null : Number(row.expires_at),
		maxUses: row.max_uses === null ? null : Number(row.max_uses),
		uses: Number(row.uses),
		revoked: Number(row.revoked) !== 0,
	};
}

function toNoteMeta(row: Row): NoteMeta {
	return {
		id: String(row.id),
		teamId: String(row.team_id),
		path: String(row.path),
		version: Number(row.version),
		seq: Number(row.seq),
		updatedAt: Number(row.updated_at),
		updatedBy: String(row.updated_by),
		updatedByName: row.updated_by_name === null || row.updated_by_name === undefined ? '' : String(row.updated_by_name),
		deleted: Number(row.deleted) !== 0,
	};
}

function toNote(row: Row): Note {
	return { ...toNoteMeta(row), content: String(row.content) };
}
