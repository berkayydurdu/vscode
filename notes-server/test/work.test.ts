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
	server = createApp(store, { publicUrl: 'http://localhost', allowRegistration: true, appUrlProtocol: 'nighthawk', sessionTtlMs: 3600_000 });
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
	return { status: res.status, json: await res.json() };
}

let teams = 0;

async function setup() {
	const n = ++teams;
	const register = async (name: string) => (await call('POST', '/api/auth/register', undefined, { email: `${name}${n}@work.test`, name, password: 'long password' })).json;
	const owner = await register('ada');
	const editor = await register('ben');
	const viewer = await register('cy');
	const team = (await call('POST', '/api/teams', owner.token, { name: 'Core' })).json.team;
	for (const [person, role] of [[editor, 'editor'], [viewer, 'viewer']] as const) {
		const invite = (await call('POST', `/api/teams/${team.id}/invites`, owner.token, { role })).json.invite;
		await call('POST', `/api/invites/${invite.code}/accept`, person.token);
	}
	return { owner, editor, viewer, team, items: `/api/teams/${team.id}/items` };
}

describe('work items', () => {
	it('creates tickets with numbers, assignees and to-dos, and moves them across the board', async () => {
		const { owner, editor, viewer, items } = await setup();
		const created = await call('POST', items, owner.token, {
			title: 'Ship the board', priority: 'high', assignees: [editor.user.id], labels: ['ui', 'ui'], dueDate: '2026-11-01', estimateMinutes: 240,
			checklist: [{ id: 'a', text: 'Columns', done: true }, { id: 'b', text: 'Drag and drop', done: false }],
		});
		assert.equal(created.status, 201);
		const second = (await call('POST', items, editor.token, { kind: 'bug', title: 'Card overflows' })).json.item;
		const item = created.json.item;
		assert.deepEqual(
			[item.number, item.kind, item.status, item.labels, second.number, second.kind],
			[1, 'task', 'todo', ['ui'], 2, 'bug'],
		);

		assert.equal((await call('POST', items, viewer.token, { title: 'Nope' })).status, 403);
		assert.equal((await call('POST', items, owner.token, { title: 'x', assignees: ['stranger'] })).status, 400);
		assert.equal((await call('PATCH', `${items}/${item.id}`, owner.token, { status: 'accepted' })).status, 400);

		const moved = (await call('PATCH', `${items}/${item.id}`, editor.token, { status: 'in_progress' })).json.item;
		assert.deepEqual([moved.status, moved.version], ['in_progress', 2]);
		assert.equal((await call('PATCH', `${items}/${item.id}`, owner.token, { title: 'Stale', baseVersion: 1 })).status, 409);

		const listing = (await call('GET', items, viewer.token)).json;
		assert.deepEqual(listing.items.map((i: any) => i.number).sort(), [1, 2]);
		await call('DELETE', `${items}/${second.id}`, owner.token);
		const changes = (await call('GET', `${items}?since=${listing.cursor}`, viewer.token)).json.items;
		assert.deepEqual(changes.map((i: any) => [i.number, i.deleted]), [[2, true]]);
	});

	it('runs RFCs through review with comments', async () => {
		const { owner, editor, viewer, items } = await setup();
		const rfc = (await call('POST', items, owner.token, { kind: 'rfc', title: 'RFC: Sync protocol', body: '## Summary', reviewers: [editor.user.id] })).json.item;
		assert.equal(rfc.status, 'draft');
		assert.equal((await call('PATCH', `${items}/${rfc.id}`, owner.token, { kind: 'task' })).status, 400);
		await call('PATCH', `${items}/${rfc.id}`, owner.token, { status: 'in_review' });

		await call('POST', `${items}/${rfc.id}/reviews`, editor.token, { verdict: 'request_changes', body: 'Needs a rollout plan' });
		const reviews = (await call('POST', `${items}/${rfc.id}/reviews`, editor.token, { verdict: 'approve' })).json.reviews;
		assert.deepEqual(reviews.map((r: any) => r.verdict), ['approve']);

		const comment = (await call('POST', `${items}/${rfc.id}/comments`, viewer.token, { body: 'Looks good' })).json.comment;
		assert.equal((await call('DELETE', `${items}/${rfc.id}/comments/${comment.id}`, editor.token)).status, 403);
		const detail = (await call('GET', `${items}/${rfc.id}`, viewer.token)).json;
		assert.deepEqual([detail.item.commentCount, detail.comments[0].body, detail.reviews.length], [1, 'Looks good', 1]);
	});

	it('books time on tickets and reports it per week', async () => {
		const { owner, editor, viewer, team, items } = await setup();
		const item = (await call('POST', items, owner.token, { title: 'Timesheet', estimateMinutes: 120 })).json.item;
		const worklogs = `/api/teams/${team.id}/worklogs`;
		const log = (await call('POST', worklogs, editor.token, { itemId: item.id, minutes: 90, date: '2026-10-19', note: 'Grid' })).json.worklog;
		await call('POST', worklogs, owner.token, { itemId: item.id, minutes: 30, date: '2026-10-25' });
		assert.equal((await call('POST', worklogs, viewer.token, { itemId: item.id, minutes: 30, date: '2026-10-19' })).status, 403);
		assert.equal((await call('POST', worklogs, editor.token, { itemId: item.id, minutes: 0, date: '2026-10-19' })).status, 400);

		// Only the author (or an admin) changes an entry.
		assert.equal((await call('PATCH', `${worklogs}/${log.id}`, owner.token, { minutes: 60 })).status, 200);
		const ownersLog = (await call('GET', `${worklogs}?userId=${owner.user.id}`, owner.token)).json.worklogs[0];
		assert.equal((await call('DELETE', `${worklogs}/${ownersLog.id}`, editor.token)).status, 403);

		const week = (await call('GET', `${worklogs}?from=2026-10-19&to=2026-10-24`, viewer.token)).json.worklogs;
		assert.deepEqual(week.map((w: any) => [w.minutes, w.note]), [[60, 'Grid']]);
		assert.equal((await call('GET', `${items}/${item.id}`, viewer.token)).json.item.loggedMinutes, 90);
	});
});
