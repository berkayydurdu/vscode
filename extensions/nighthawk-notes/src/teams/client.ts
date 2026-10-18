/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Types mirror notes-server/src/store.ts.

export type Role = 'owner' | 'admin' | 'editor' | 'viewer';

export const ROLE_RANK: Record<Role, number> = { owner: 3, admin: 2, editor: 1, viewer: 0 };

export interface User {
	id: string;
	email: string;
	name: string;
}

export interface Team {
	id: string;
	name: string;
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
	expiresAt: number | null;
	maxUses: number | null;
	uses: number;
	url: string;
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
	content?: string;
}

export class NotesServerError extends Error {
	constructor(readonly status: number, message: string) {
		super(message);
	}
}

/**
 * A small typed client for the Nighthawk Notes server's JSON API.
 */
export class NotesClient {

	constructor(readonly serverUrl: string, private readonly token?: string) { }

	private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
		let response: Response;
		try {
			response = await fetch(this.serverUrl.replace(/\/+$/, '') + path, {
				method,
				headers: {
					'Content-Type': 'application/json',
					...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
				},
				body: body === undefined ? undefined : JSON.stringify(body),
			});
		} catch (err) {
			throw new NotesServerError(0, `Cannot reach the notes server at ${this.serverUrl} (${err.cause?.code ?? err.message})`);
		}
		const text = await response.text();
		let json: any;
		try {
			json = text ? JSON.parse(text) : {};
		} catch {
			throw new NotesServerError(response.status, `${this.serverUrl} is not a Nighthawk Notes server`);
		}
		if (!response.ok) {
			throw new NotesServerError(response.status, json.error ?? response.statusText);
		}
		return json as T;
	}

	/** Sends a request on behalf of the team workspace, which checks the path. */
	call<T>(method: string, path: string, body?: unknown): Promise<T> {
		return this.request<T>(method, path, body);
	}

	info() {
		return this.request<{ name: string; version: number; allowRegistration: boolean }>('GET', '/api/info');
	}

	register(email: string, name: string, password: string) {
		return this.request<{ token: string; user: User }>('POST', '/api/auth/register', { email, name, password });
	}

	login(email: string, password: string) {
		return this.request<{ token: string; user: User }>('POST', '/api/auth/login', { email, password });
	}

	logout() {
		return this.request<{ ok: true }>('POST', '/api/auth/logout');
	}

	me() {
		return this.request<{ user: User }>('GET', '/api/me');
	}

	async teams(): Promise<Team[]> {
		return (await this.request<{ teams: Team[] }>('GET', '/api/teams')).teams;
	}

	async createTeam(name: string): Promise<Team> {
		return (await this.request<{ team: Team }>('POST', '/api/teams', { name })).team;
	}

	team(teamId: string) {
		return this.request<{ team: Team; members: Member[] }>('GET', `/api/teams/${enc(teamId)}`);
	}

	renameTeam(teamId: string, name: string) {
		return this.request('PATCH', `/api/teams/${enc(teamId)}`, { name });
	}

	deleteTeam(teamId: string) {
		return this.request('DELETE', `/api/teams/${enc(teamId)}`);
	}

	setRole(teamId: string, userId: string, role: Role) {
		return this.request('PATCH', `/api/teams/${enc(teamId)}/members/${enc(userId)}`, { role });
	}

	removeMember(teamId: string, userId: string) {
		return this.request('DELETE', `/api/teams/${enc(teamId)}/members/${enc(userId)}`);
	}

	leaveTeam(teamId: string) {
		return this.request('DELETE', `/api/teams/${enc(teamId)}/members/me`);
	}

	async invites(teamId: string): Promise<Invite[]> {
		return (await this.request<{ invites: Invite[] }>('GET', `/api/teams/${enc(teamId)}/invites`)).invites;
	}

	async createInvite(teamId: string, role: Role, expiresInHours: number, maxUses?: number): Promise<Invite> {
		return (await this.request<{ invite: Invite }>('POST', `/api/teams/${enc(teamId)}/invites`, { role, expiresInHours, maxUses })).invite;
	}

	revokeInvite(teamId: string, code: string) {
		return this.request('DELETE', `/api/teams/${enc(teamId)}/invites/${enc(code)}`);
	}

	previewInvite(code: string) {
		return this.request<{ invite: { code: string; role: Role; team: { id: string; name: string } } }>('GET', `/api/invites/${enc(code)}`);
	}

	acceptInvite(code: string) {
		return this.request<{ team: { id: string; name: string }; role: Role; alreadyMember: boolean }>('POST', `/api/invites/${enc(code)}/accept`);
	}

	notes(teamId: string, since: number) {
		return this.request<{ notes: NoteMeta[]; cursor: number }>('GET', `/api/teams/${enc(teamId)}/notes?content=1&since=${since}`);
	}

	async note(teamId: string, noteId: string): Promise<NoteMeta & { content: string }> {
		return (await this.request<{ note: NoteMeta & { content: string } }>('GET', `/api/teams/${enc(teamId)}/notes/${enc(noteId)}`)).note;
	}

	async createNote(teamId: string, path: string, content: string): Promise<NoteMeta> {
		return (await this.request<{ note: NoteMeta }>('POST', `/api/teams/${enc(teamId)}/notes`, { path, content })).note;
	}

	async updateNote(teamId: string, noteId: string, baseVersion: number, change: { path?: string; content?: string }): Promise<NoteMeta> {
		return (await this.request<{ note: NoteMeta }>('PUT', `/api/teams/${enc(teamId)}/notes/${enc(noteId)}`, { baseVersion, ...change })).note;
	}

	deleteNote(teamId: string, noteId: string) {
		return this.request('DELETE', `/api/teams/${enc(teamId)}/notes/${enc(noteId)}`);
	}
}

function enc(value: string): string {
	return encodeURIComponent(value);
}

/**
 * Reads an invite code from what a person pasted: a bare code, an invite
 * page link, or a nighthawk:// link. Returns the server too when the text
 * names one.
 */
export function parseInvite(text: string): { code: string; server?: string } | undefined {
	const trimmed = text.trim();
	if (!trimmed) {
		return undefined;
	}
	try {
		const url = new URL(trimmed);
		const code = url.searchParams.get('code');
		if (code) {
			return { code, server: url.searchParams.get('server') ?? undefined };
		}
		const match = /\/invite\/([^/?#]+)/.exec(url.pathname);
		if (match && (url.protocol === 'http:' || url.protocol === 'https:')) {
			return { code: decodeURIComponent(match[1]), server: url.origin + url.pathname.slice(0, match.index) };
		}
		return undefined;
	} catch {
		return /^[A-Za-z0-9-]{6,}$/.test(trimmed) ? { code: trimmed.toUpperCase() } : undefined;
	}
}
