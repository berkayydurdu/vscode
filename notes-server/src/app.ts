/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { AttemptLimiter, hashPassword, hashToken, newInviteCode, newToken, verifyPassword } from './auth.ts';
import { ConflictError, isInviteUsable, isRole, roleAtLeast, type Role, type Store, type User } from './store.ts';

export interface AppOptions {
	/** The address people use to reach this server, used in invite links. */
	publicUrl: string;
	allowRegistration: boolean;
	/** Protocol the desktop app registers, used to open invite links in it. */
	appUrlProtocol: string;
	sessionTtlMs: number;
}

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_NOTE_BYTES = 1024 * 1024;
const NOTES_EXTENSION_ID = 'vscode.nighthawk-notes';

class HttpError extends Error {
	readonly status: number;
	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

interface Context {
	req: IncomingMessage;
	res: ServerResponse;
	params: Record<string, string>;
	query: URLSearchParams;
	body: Record<string, unknown>;
	user: User | undefined;
	token: string | undefined;
}

type Handler = (ctx: Context) => Promise<unknown> | unknown;

interface Route {
	method: string;
	pattern: RegExp;
	keys: string[];
	auth: boolean;
	handler: Handler;
}

export function createApp(store: Store, options: AppOptions): Server {
	const routes: Route[] = [];
	const loginLimiter = new AttemptLimiter(10, 15 * 60 * 1000);

	function route(method: string, path: string, auth: boolean, handler: Handler): void {
		const keys: string[] = [];
		const pattern = new RegExp('^' + path.replace(/:(\w+)/g, (_, key: string) => {
			keys.push(key);
			return '([^/]+)';
		}) + '$');
		routes.push({ method, pattern, keys, auth, handler });
	}

	function requireUser(ctx: Context): User {
		if (!ctx.user) {
			throw new HttpError(401, 'Sign in required');
		}
		return ctx.user;
	}

	function requireRole(ctx: Context, minimum: Role): Role {
		const user = requireUser(ctx);
		const role = store.roleOf(ctx.params.teamId, user.id);
		if (!role) {
			throw new HttpError(404, 'Team not found');
		}
		if (!roleAtLeast(role, minimum)) {
			throw new HttpError(403, `This needs the ${minimum} role or higher`);
		}
		return role;
	}

	function startSession(user: User) {
		const token = newToken();
		store.createSession(hashToken(token), user.id, options.sessionTtlMs);
		return { token, user };
	}

	function inviteUrl(code: string): string {
		return `${options.publicUrl.replace(/\/$/, '')}/invite/${encodeURIComponent(code)}`;
	}

	// --- server info

	route('GET', '/api/info', false, () => ({
		name: 'Nighthawk Notes',
		version: 1,
		allowRegistration: options.allowRegistration,
	}));

	// --- accounts

	route('POST', '/api/auth/register', false, async ctx => {
		if (!options.allowRegistration) {
			throw new HttpError(403, 'Registration is turned off on this server');
		}
		const email = requireString(ctx.body, 'email', 320).trim();
		const name = requireString(ctx.body, 'name', 100).trim();
		const password = requireString(ctx.body, 'password', 200);
		if (!/^[^\s@]+@[^\s@]+$/.test(email)) {
			throw new HttpError(400, 'Enter a valid email address');
		}
		if (!name) {
			throw new HttpError(400, 'Enter a name');
		}
		if (password.length < 8) {
			throw new HttpError(400, 'Use a password of at least 8 characters');
		}
		if (store.findUserByEmail(email)) {
			throw new HttpError(409, 'An account with this email already exists');
		}
		const user = store.createUser(email, name, await hashPassword(password));
		ctx.res.statusCode = 201;
		return startSession(user);
	});

	route('POST', '/api/auth/login', false, async ctx => {
		const email = requireString(ctx.body, 'email', 320).trim().toLowerCase();
		const password = requireString(ctx.body, 'password', 200);
		const key = `${ctx.req.socket.remoteAddress}|${email}`;
		if (loginLimiter.isBlocked(key)) {
			throw new HttpError(429, 'Too many failed sign-in attempts, try again later');
		}
		const found = store.findUserByEmail(email);
		if (!found || !await verifyPassword(password, found.passwordHash)) {
			loginLimiter.fail(key);
			throw new HttpError(401, 'Wrong email or password');
		}
		loginLimiter.reset(key);
		const { passwordHash: _, ...user } = found;
		return startSession(user);
	});

	route('POST', '/api/auth/logout', true, ctx => {
		store.deleteSession(hashToken(ctx.token!));
		return { ok: true };
	});

	route('GET', '/api/me', true, ctx => ({ user: requireUser(ctx) }));

	route('PATCH', '/api/me', true, ctx => {
		const user = requireUser(ctx);
		const name = requireString(ctx.body, 'name', 100).trim();
		if (!name) {
			throw new HttpError(400, 'Enter a name');
		}
		store.updateUserName(user.id, name);
		return { user: store.getUser(user.id) };
	});

	// --- teams

	route('GET', '/api/teams', true, ctx => ({ teams: store.teamsForUser(requireUser(ctx).id) }));

	route('POST', '/api/teams', true, ctx => {
		const user = requireUser(ctx);
		const name = requireString(ctx.body, 'name', 100).trim();
		if (!name) {
			throw new HttpError(400, 'Enter a team name');
		}
		ctx.res.statusCode = 201;
		return { team: { ...store.createTeam(name, user.id), role: 'owner', memberCount: 1 } };
	});

	route('GET', '/api/teams/:teamId', true, ctx => {
		const role = requireRole(ctx, 'viewer');
		return { team: { ...store.getTeam(ctx.params.teamId), role }, members: store.members(ctx.params.teamId) };
	});

	route('PATCH', '/api/teams/:teamId', true, ctx => {
		requireRole(ctx, 'admin');
		const name = requireString(ctx.body, 'name', 100).trim();
		if (!name) {
			throw new HttpError(400, 'Enter a team name');
		}
		store.renameTeam(ctx.params.teamId, name);
		return { team: store.getTeam(ctx.params.teamId) };
	});

	route('DELETE', '/api/teams/:teamId', true, ctx => {
		requireRole(ctx, 'owner');
		store.deleteTeam(ctx.params.teamId);
		return { ok: true };
	});

	route('PATCH', '/api/teams/:teamId/members/:userId', true, ctx => {
		const myRole = requireRole(ctx, 'admin');
		const role = ctx.body.role;
		if (!isRole(role)) {
			throw new HttpError(400, 'Role must be owner, admin, editor or viewer');
		}
		const { teamId, userId } = ctx.params;
		const theirRole = store.roleOf(teamId, userId);
		if (!theirRole) {
			throw new HttpError(404, 'Member not found');
		}
		// Only owners may grant or take away ownership.
		if ((role === 'owner' || theirRole === 'owner') && myRole !== 'owner') {
			throw new HttpError(403, 'Only an owner can change ownership');
		}
		if (theirRole === 'owner' && role !== 'owner' && store.countOwners(teamId) === 1) {
			throw new HttpError(409, 'A team needs at least one owner; make someone else owner first');
		}
		store.setRole(teamId, userId, role);
		return { members: store.members(teamId) };
	});

	route('DELETE', '/api/teams/:teamId/members/:userId', true, ctx => {
		const user = requireUser(ctx);
		const { teamId, userId } = ctx.params;
		const leaving = userId === user.id || userId === 'me';
		const targetId = leaving ? user.id : userId;
		const myRole = requireRole(ctx, leaving ? 'viewer' : 'admin');
		const theirRole = store.roleOf(teamId, targetId);
		if (!theirRole) {
			throw new HttpError(404, 'Member not found');
		}
		if (!leaving && theirRole === 'owner' && myRole !== 'owner') {
			throw new HttpError(403, 'Only an owner can remove an owner');
		}
		if (theirRole === 'owner' && store.countOwners(teamId) === 1) {
			throw new HttpError(409, 'The last owner cannot leave; make someone else owner or delete the team');
		}
		store.removeMember(teamId, targetId);
		return { ok: true };
	});

	// --- invites

	route('GET', '/api/teams/:teamId/invites', true, ctx => {
		requireRole(ctx, 'admin');
		const invites = store.invites(ctx.params.teamId)
			.filter(invite => isInviteUsable(invite))
			.map(invite => ({ ...invite, url: inviteUrl(invite.code) }));
		return { invites };
	});

	route('POST', '/api/teams/:teamId/invites', true, ctx => {
		const myRole = requireRole(ctx, 'admin');
		const role = ctx.body.role ?? 'editor';
		if (!isRole(role)) {
			throw new HttpError(400, 'Role must be owner, admin, editor or viewer');
		}
		if (role === 'owner' && myRole !== 'owner') {
			throw new HttpError(403, 'Only an owner can invite owners');
		}
		const expiresInHours = optionalPositiveNumber(ctx.body, 'expiresInHours') ?? 24 * 7;
		const maxUses = optionalPositiveNumber(ctx.body, 'maxUses') ?? null;
		const invite = store.createInvite(newInviteCode(), ctx.params.teamId, role, requireUser(ctx).id, Date.now() + expiresInHours * 3600_000, maxUses === null ? null : Math.floor(maxUses));
		ctx.res.statusCode = 201;
		return { invite: { ...invite, url: inviteUrl(invite.code) } };
	});

	route('DELETE', '/api/teams/:teamId/invites/:code', true, ctx => {
		requireRole(ctx, 'admin');
		const invite = store.getInvite(normalizeCode(ctx.params.code));
		if (!invite || invite.teamId !== ctx.params.teamId) {
			throw new HttpError(404, 'Invite not found');
		}
		store.revokeInvite(invite.code);
		return { ok: true };
	});

	route('GET', '/api/invites/:code', false, ctx => {
		const invite = store.getInvite(normalizeCode(ctx.params.code));
		if (!invite || !isInviteUsable(invite)) {
			throw new HttpError(404, 'This invite is invalid or has expired');
		}
		const team = store.getTeam(invite.teamId)!;
		return { invite: { code: invite.code, role: invite.role, expiresAt: invite.expiresAt, team: { id: team.id, name: team.name } } };
	});

	route('POST', '/api/invites/:code/accept', true, ctx => {
		const result = store.acceptInvite(normalizeCode(ctx.params.code), requireUser(ctx).id);
		if (!result) {
			throw new HttpError(404, 'This invite is invalid or has expired');
		}
		return { team: store.getTeam(result.teamId), role: result.role, alreadyMember: result.alreadyMember };
	});

	// --- team notes

	route('GET', '/api/teams/:teamId/notes', true, ctx => {
		requireRole(ctx, 'viewer');
		const since = Number(ctx.query.get('since') ?? 0);
		const includeContent = ctx.query.get('content') === '1';
		return store.listNotes(ctx.params.teamId, Number.isFinite(since) && since > 0 ? since : 0, includeContent);
	});

	route('POST', '/api/teams/:teamId/notes', true, ctx => {
		requireRole(ctx, 'editor');
		const path = normalizeNotePath(requireString(ctx.body, 'path', 512));
		const content = optionalString(ctx.body, 'content', MAX_NOTE_BYTES) ?? '';
		ctx.res.statusCode = 201;
		return { note: store.createNote(ctx.params.teamId, path, content, requireUser(ctx).id) };
	});

	route('GET', '/api/teams/:teamId/notes/:noteId', true, ctx => {
		requireRole(ctx, 'viewer');
		const note = store.getNote(ctx.params.teamId, ctx.params.noteId);
		if (!note || note.deleted) {
			throw new HttpError(404, 'Note not found');
		}
		return { note };
	});

	route('PUT', '/api/teams/:teamId/notes/:noteId', true, ctx => {
		requireRole(ctx, 'editor');
		const baseVersion = ctx.body.baseVersion;
		if (typeof baseVersion !== 'number') {
			throw new HttpError(400, 'baseVersion is required');
		}
		const pathValue = optionalString(ctx.body, 'path', 512);
		const content = optionalString(ctx.body, 'content', MAX_NOTE_BYTES);
		const note = store.updateNote(ctx.params.teamId, ctx.params.noteId, baseVersion, {
			path: pathValue === undefined ? undefined : normalizeNotePath(pathValue),
			content,
		}, requireUser(ctx).id);
		if (!note) {
			throw new HttpError(404, 'Note not found');
		}
		return { note };
	});

	route('DELETE', '/api/teams/:teamId/notes/:noteId', true, ctx => {
		requireRole(ctx, 'editor');
		if (!store.deleteNote(ctx.params.teamId, ctx.params.noteId, requireUser(ctx).id)) {
			throw new HttpError(404, 'Note not found');
		}
		return { ok: true };
	});

	// --- invite landing page, for links opened in a browser

	route('GET', '/invite/:code', false, ctx => {
		const invite = store.getInvite(normalizeCode(ctx.params.code));
		const team = invite && isInviteUsable(invite) ? store.getTeam(invite.teamId) : undefined;
		ctx.res.setHeader('Content-Type', 'text/html; charset=utf-8');
		ctx.res.setHeader('Content-Security-Policy', `default-src 'none'; style-src 'unsafe-inline'`);
		if (!invite || !team) {
			ctx.res.statusCode = 404;
			return new RawBody(page('Invite not found', '<p>This invite is invalid or has expired. Ask a team admin for a new one.</p>'));
		}
		const appLink = `${options.appUrlProtocol}://${NOTES_EXTENSION_ID}/join?server=${encodeURIComponent(options.publicUrl)}&code=${encodeURIComponent(invite.code)}`;
		return new RawBody(page(`Join ${team.name}`, `
			<p>You have been invited to join <strong>${escapeHtml(team.name)}</strong> as ${escapeHtml(invite.role)} on Nighthawk Notes.</p>
			<p><a class="button" href="${escapeHtml(appLink)}">Open in Nighthawk</a></p>
			<p>Or run <em>Notes: Join Team</em> in Nighthawk and paste this code:</p>
			<p class="code">${escapeHtml(invite.code)}</p>
			<p class="small">Server: ${escapeHtml(options.publicUrl)}</p>
		`));
	});

	return createServer((req, res) => {
		handle(req, res).catch(err => {
			console.error(err);
			if (!res.headersSent) {
				sendJson(res, 500, { error: 'Internal server error' });
			}
		});
	});

	async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const url = new URL(req.url ?? '/', 'http://localhost');
		const method = req.method ?? 'GET';
		let pathMatched = false;
		for (const r of routes) {
			const match = r.pattern.exec(url.pathname);
			if (!match) {
				continue;
			}
			pathMatched = true;
			if (r.method !== method) {
				continue;
			}
			const params: Record<string, string> = {};
			r.keys.forEach((key, i) => params[key] = decodeURIComponent(match[i + 1]));
			try {
				const token = bearerToken(req);
				const user = token ? store.userForSession(hashToken(token)) : undefined;
				if (r.auth && !user) {
					throw new HttpError(401, 'Sign in required');
				}
				const body = method === 'GET' || method === 'HEAD' ? {} : await readJson(req);
				const result = await r.handler({ req, res, params, query: url.searchParams, body, user, token });
				if (result instanceof RawBody) {
					res.end(result.body);
				} else {
					sendJson(res, res.statusCode || 200, result);
				}
			} catch (err) {
				if (err instanceof HttpError) {
					sendJson(res, err.status, { error: err.message });
				} else if (err instanceof ConflictError) {
					sendJson(res, 409, { error: err.message });
				} else {
					throw err;
				}
			}
			return;
		}
		sendJson(res, pathMatched ? 405 : 404, { error: pathMatched ? 'Method not allowed' : 'Not found' });
	}
}

class RawBody {
	readonly body: string;
	constructor(body: string) {
		this.body = body;
	}
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
	res.statusCode = status;
	res.setHeader('Content-Type', 'application/json; charset=utf-8');
	res.setHeader('Cache-Control', 'no-store');
	res.end(JSON.stringify(value));
}

function bearerToken(req: IncomingMessage): string | undefined {
	const header = req.headers.authorization;
	return header?.startsWith('Bearer ') ? header.slice(7).trim() || undefined : undefined;
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		size += (chunk as Buffer).length;
		if (size > MAX_BODY_BYTES) {
			throw new HttpError(413, 'Request body is too large');
		}
		chunks.push(chunk as Buffer);
	}
	if (size === 0) {
		return {};
	}
	try {
		const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
		if (typeof value !== 'object' || value === null || Array.isArray(value)) {
			throw new Error();
		}
		return value as Record<string, unknown>;
	} catch {
		throw new HttpError(400, 'Request body must be a JSON object');
	}
}

function requireString(body: Record<string, unknown>, key: string, maxLength: number): string {
	const value = optionalString(body, key, maxLength);
	if (value === undefined) {
		throw new HttpError(400, `${key} is required`);
	}
	return value;
}

function optionalString(body: Record<string, unknown>, key: string, maxLength: number): string | undefined {
	const value = body[key];
	if (value === undefined || value === null) {
		return undefined;
	}
	if (typeof value !== 'string') {
		throw new HttpError(400, `${key} must be a string`);
	}
	if (value.length > maxLength) {
		throw new HttpError(400, `${key} is too long`);
	}
	return value;
}

function optionalPositiveNumber(body: Record<string, unknown>, key: string): number | undefined {
	const value = body[key];
	if (value === undefined || value === null) {
		return undefined;
	}
	if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
		throw new HttpError(400, `${key} must be a positive number`);
	}
	return value;
}

function normalizeCode(code: string): string {
	return code.trim().toUpperCase();
}

/**
 * Note paths are relative, slash separated and end in `.md`, so a team's
 * notes map one to one onto a folder of Markdown files.
 */
export function normalizeNotePath(path: string): string {
	const segments = path.replace(/\\/g, '/').split('/').map(s => s.trim()).filter(Boolean);
	if (!segments.length || segments.some(s => s === '.' || s === '..' || /[\u0000-\u001f<>:"|?*]/.test(s))) {
		throw new HttpError(400, 'Invalid note path');
	}
	let normalized = segments.join('/');
	if (!normalized.toLowerCase().endsWith('.md')) {
		normalized += '.md';
	}
	return normalized;
}

function escapeHtml(value: string): string {
	return value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' })[c]!);
}

function page(title: string, body: string): string {
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · Nighthawk Notes</title>
<style>
	:root { color-scheme: light dark; }
	body { font: 16px/1.5 system-ui, sans-serif; max-width: 32rem; margin: 4rem auto; padding: 0 1rem; }
	.button { display: inline-block; padding: .6rem 1.2rem; border-radius: 6px; background: #3b5bdb; color: #fff; text-decoration: none; }
	.code { font: 1.5rem ui-monospace, monospace; letter-spacing: .1em; }
	.small { opacity: .7; font-size: .85rem; }
</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
${body}
</body>
</html>`;
}
