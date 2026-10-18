/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { createApp } from '../src/app.ts';
import { Store } from '../src/store.ts';

let server: Server;
let store: Store;
let base: string;

before(async () => {
	store = new Store(':memory:');
	server = createApp(store, { publicUrl: 'https://notes.example.com', allowRegistration: true, appUrlProtocol: 'nighthawk', sessionTtlMs: 3600_000 });
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
	server.close();
	store.close();
});

async function call(method: string, path: string, token?: string, body?: unknown): Promise<{ status: number; json: any }> {
	const res = await fetch(base + path, {
		method,
		headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const text = await res.text();
	return { status: res.status, json: res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text };
}

async function register(name: string): Promise<{ token: string; id: string }> {
	const { status, json } = await call('POST', '/api/auth/register', undefined, { email: `${name}@example.com`, name, password: 'correct horse' });
	assert.equal(status, 201);
	return { token: json.token, id: json.user.id };
}

describe('accounts', () => {
	it('registers, signs in and out', async () => {
		const { token } = await register('alice');
		assert.equal((await call('GET', '/api/me', token)).json.user.name, 'alice');

		assert.equal((await call('POST', '/api/auth/register', undefined, { email: 'ALICE@example.com', name: 'x', password: 'password1' })).status, 409);
		assert.equal((await call('POST', '/api/auth/login', undefined, { email: 'alice@example.com', password: 'wrong pass' })).status, 401);

		const login = await call('POST', '/api/auth/login', undefined, { email: 'Alice@Example.com', password: 'correct horse' });
		assert.equal(login.status, 200);
		assert.equal((await call('POST', '/api/auth/logout', login.json.token)).status, 200);
		assert.equal((await call('GET', '/api/me', login.json.token)).status, 401);
		// The first session is unaffected.
		assert.equal((await call('GET', '/api/me', token)).status, 200);
	});

	it('rejects weak input and unauthenticated calls', async () => {
		assert.equal((await call('POST', '/api/auth/register', undefined, { email: 'bob@example.com', name: 'bob', password: 'short' })).status, 400);
		assert.equal((await call('POST', '/api/auth/register', undefined, { email: 'not-an-email', name: 'bob', password: 'long enough' })).status, 400);
		assert.equal((await call('GET', '/api/teams')).status, 401);
		assert.equal((await call('GET', '/api/teams', 'bogus')).status, 401);
	});
});

describe('teams and invites', () => {
	it('creates a team, invites a member and manages roles', async () => {
		const owner = await register('olga');
		const member = await register('mike');
		const outsider = await register('otto');

		const team = (await call('POST', '/api/teams', owner.token, { name: 'Design' })).json.team;
		assert.equal(team.role, 'owner');

		// Outsiders cannot see the team at all.
		assert.equal((await call('GET', `/api/teams/${team.id}`, outsider.token)).status, 404);

		const invite = (await call('POST', `/api/teams/${team.id}/invites`, owner.token, { role: 'viewer', maxUses: 1 })).json.invite;
		assert.match(invite.code, /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
		assert.equal(invite.url, `https://notes.example.com/invite/${invite.code}`);

		const preview = await call('GET', `/api/invites/${invite.code.toLowerCase()}`);
		assert.equal(preview.json.invite.team.name, 'Design');

		const accepted = await call('POST', `/api/invites/${invite.code}/accept`, member.token);
		assert.equal(accepted.json.role, 'viewer');
		// Single use: a second person cannot use it.
		assert.equal((await call('POST', `/api/invites/${invite.code}/accept`, outsider.token)).status, 404);

		const details = (await call('GET', `/api/teams/${team.id}`, member.token)).json;
		assert.deepEqual(details.members.map((m: any) => [m.name, m.role]), [['olga', 'owner'], ['mike', 'viewer']]);

		// Viewers cannot invite or manage members.
		assert.equal((await call('POST', `/api/teams/${team.id}/invites`, member.token, {})).status, 403);

		// Promote to admin; an admin still cannot make owners.
		await call('PATCH', `/api/teams/${team.id}/members/${member.id}`, owner.token, { role: 'admin' });
		assert.equal((await call('PATCH', `/api/teams/${team.id}/members/${member.id}`, member.token, { role: 'owner' })).status, 403);
		assert.equal((await call('POST', `/api/teams/${team.id}/invites`, member.token, { role: 'owner' })).status, 403);

		// The only owner cannot leave or be demoted.
		assert.equal((await call('DELETE', `/api/teams/${team.id}/members/me`, owner.token)).status, 409);
		assert.equal((await call('PATCH', `/api/teams/${team.id}/members/${owner.id}`, owner.token, { role: 'editor' })).status, 409);

		// Revoked invites stop working.
		const second = (await call('POST', `/api/teams/${team.id}/invites`, member.token, {})).json.invite;
		assert.equal((await call('GET', `/api/teams/${team.id}/invites`, owner.token)).json.invites.length, 1);
		await call('DELETE', `/api/teams/${team.id}/invites/${second.code}`, owner.token);
		assert.equal((await call('POST', `/api/invites/${second.code}/accept`, outsider.token)).status, 404);

		// Members can leave; admins can remove others.
		assert.equal((await call('DELETE', `/api/teams/${team.id}/members/me`, member.token)).status, 200);
		assert.equal((await call('GET', '/api/teams', member.token)).json.teams.length, 0);

		assert.equal((await call('DELETE', `/api/teams/${team.id}`, owner.token)).status, 200);
		assert.equal((await call('GET', '/api/teams', owner.token)).json.teams.length, 0);
	});

	it('serves an invite page that opens the app', async () => {
		const owner = await register('pia');
		const team = (await call('POST', '/api/teams', owner.token, { name: '<Team & Co>' })).json.team;
		const invite = (await call('POST', `/api/teams/${team.id}/invites`, owner.token, {})).json.invite;
		const page = await call('GET', `/invite/${invite.code}`);
		assert.equal(page.status, 200);
		assert.ok(page.json.includes('&lt;Team &amp; Co&gt;'));
		assert.ok(page.json.includes(`nighthawk://vscode.nighthawk-notes/join?server=${encodeURIComponent('https://notes.example.com')}&amp;code=${invite.code}`));
		assert.equal((await call('GET', '/invite/NOPE-NOPE-NOPE')).status, 404);
	});
});

describe('team notes', () => {
	it('creates, syncs and protects notes against lost updates', async () => {
		const owner = await register('nina');
		const viewer = await register('vic');
		const team = (await call('POST', '/api/teams', owner.token, { name: 'Wiki' })).json.team;
		const invite = (await call('POST', `/api/teams/${team.id}/invites`, owner.token, { role: 'viewer' })).json.invite;
		await call('POST', `/api/invites/${invite.code}/accept`, viewer.token);

		const created = await call('POST', `/api/teams/${team.id}/notes`, owner.token, { path: 'Projects/Launch', content: '# Launch' });
		assert.equal(created.status, 201);
		const note = created.json.note;
		assert.equal(note.path, 'Projects/Launch.md');
		assert.equal(note.version, 1);

		assert.equal((await call('POST', `/api/teams/${team.id}/notes`, owner.token, { path: 'Projects/Launch.md' })).status, 409);
		assert.equal((await call('POST', `/api/teams/${team.id}/notes`, owner.token, { path: '../escape' })).status, 400);
		assert.equal((await call('POST', `/api/teams/${team.id}/notes`, viewer.token, { path: 'mine' })).status, 403);

		const listing = (await call('GET', `/api/teams/${team.id}/notes`, viewer.token)).json;
		assert.equal(listing.notes.length, 1);
		assert.equal(listing.notes[0].content, undefined);
		assert.equal((await call('GET', `/api/teams/${team.id}/notes?content=1`, viewer.token)).json.notes[0].content, '# Launch');

		const updated = await call('PUT', `/api/teams/${team.id}/notes/${note.id}`, owner.token, { baseVersion: 1, content: '# Launch v2' });
		assert.equal(updated.json.note.version, 2);
		assert.equal(updated.json.note.updatedByName, 'nina');

		// A stale edit is rejected instead of overwriting.
		const stale = await call('PUT', `/api/teams/${team.id}/notes/${note.id}`, owner.token, { baseVersion: 1, content: 'stale' });
		assert.equal(stale.status, 409);

		// Incremental sync reports changes and deletions after the cursor.
		const changes = (await call('GET', `/api/teams/${team.id}/notes?since=${listing.cursor}`, viewer.token)).json;
		assert.deepEqual(changes.notes.map((n: any) => n.version), [2]);
		await call('DELETE', `/api/teams/${team.id}/notes/${note.id}`, owner.token);
		const afterDelete = (await call('GET', `/api/teams/${team.id}/notes?since=${changes.cursor}`, viewer.token)).json;
		assert.equal(afterDelete.notes[0].deleted, true);
		assert.equal((await call('GET', `/api/teams/${team.id}/notes`, viewer.token)).json.notes.length, 0);

		// The path is free again after deletion.
		assert.equal((await call('POST', `/api/teams/${team.id}/notes`, owner.token, { path: 'Projects/Launch.md' })).status, 201);
	});
});
