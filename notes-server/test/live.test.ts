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
	server.closeAllConnections();
	server.close();
	store.close();
});

async function call(method: string, path: string, token: string, body?: unknown): Promise<{ status: number; json: any }> {
	const res = await fetch(base + path, {
		method,
		headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	return { status: res.status, json: await res.json() };
}

async function register(name: string): Promise<string> {
	const res = await fetch(base + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: `${name}@example.com`, name, password: 'correct horse' }) });
	return (await res.json()).token;
}

interface LiveEvent {
	event: string;
	data: any;
}

/** Joins a note's live stream and collects its events. */
async function join(path: string, token: string, client: string) {
	const controller = new AbortController();
	const res = await fetch(`${base}${path}/live?client=${client}`, { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal });
	assert.equal(res.status, 200);
	const events: LiveEvent[] = [];
	const waiters: (() => void)[] = [];
	(async () => {
		const decoder = new TextDecoder();
		let buffer = '';
		try {
			for await (const chunk of res.body!) {
				buffer += decoder.decode(chunk, { stream: true });
				let end;
				while ((end = buffer.indexOf('\n\n')) >= 0) {
					const block = buffer.slice(0, end);
					buffer = buffer.slice(end + 2);
					const name = /^event: (.*)$/m.exec(block)?.[1];
					const data = /^data: (.*)$/m.exec(block)?.[1];
					if (name && data) {
						events.push({ event: name, data: JSON.parse(data) });
						waiters.splice(0).forEach(wake => wake());
					}
				}
			}
		} catch {
			// Aborted.
		}
	})();
	async function next(name: string, skip = 0): Promise<any> {
		for (; ;) {
			const found = events.filter(e => e.event === name);
			if (found.length > skip) {
				return found[skip].data;
			}
			await new Promise<void>(resolve => waiters.push(resolve));
		}
	}
	return { events, next, leave: () => controller.abort() };
}

describe('live editing', () => {
	it('merges edits made at the same time and saves the result', async () => {
		const owner = await register('lena');
		const editor = await register('emil');
		const viewer = await register('vera');
		const team = (await call('POST', '/api/teams', owner, { name: 'Live' })).json.team;
		for (const [token, role] of [[editor, 'editor'], [viewer, 'viewer']]) {
			const invite = (await call('POST', `/api/teams/${team.id}/invites`, owner, { role, expiresInHours: 1 })).json.invite;
			await call('POST', `/api/invites/${invite.code}/accept`, token);
		}
		const note = (await call('POST', `/api/teams/${team.id}/notes`, owner, { path: 'plan.md', content: 'Plan\n' })).json.note;
		const path = `/api/teams/${team.id}/notes/${note.id}`;

		const a = await join(path, owner, 'client-aaaa');
		const b = await join(path, editor, 'client-bbbb');
		const v = await join(path, viewer, 'client-vvvv');
		const init = await b.next('init');
		assert.equal(init.content, 'Plan\n');
		assert.deepStrictEqual(init.peers.map((p: any) => p.name), ['lena']);
		await a.next('join');

		// Both type at revision 0 without seeing each other's edit.
		const [ra, rb] = await Promise.all([
			call('POST', `${path}/live/edits`, owner, { client: 'client-aaaa', revision: 0, op: [4, ' A'] }),
			call('POST', `${path}/live/edits`, editor, { client: 'client-bbbb', revision: 0, op: [5, 'B\n'] }),
		]);
		assert.deepStrictEqual([ra.status, rb.status].sort(), [200, 200]);
		const ops = [await v.next('op'), await v.next('op', 1)];
		assert.deepStrictEqual(ops.map(o => o.revision), [1, 2]);

		const denied = await call('POST', `${path}/live/edits`, viewer, { client: 'client-vvvv', revision: 2, op: ['x'] });
		const stale = await call('POST', `${path}/live/edits`, editor, { client: 'client-bbbb', revision: 9, op: ['x'] });
		const tooLong = await call('POST', `${path}/live/edits`, editor, { client: 'client-bbbb', revision: 2, op: [100, 'x'] });

		await call('POST', `${path}/live/selections`, editor, { client: 'client-bbbb', revision: 0, selections: [[4, 4]] });
		const presence = await a.next('presence');

		const saved = await a.next('saved');
		const stored = (await call('GET', path, owner)).json.note;

		// A save from outside the live session reaches everyone as an edit.
		await call('PUT', path, owner, { baseVersion: stored.version, content: 'Replaced\n' });
		const replaced = await b.next('op', 2);

		a.leave();
		const left = await b.next('leave');
		assert.deepStrictEqual({
			statuses: [denied.status, stale.status, tooLong.status],
			presence: presence.selections,
			saved: saved.revision,
			content: stored.content,
			replaced: replaced.op,
			left: left.client,
		}, {
			statuses: [403, 400, 400],
			// The cursor after "Plan" moves past the " A" typed there.
			presence: [[6, 6]],
			saved: 2,
			content: 'Plan A\nB\n',
			replaced: ['Replaced', -8],
			left: 'client-aaaa',
		});
		b.leave();
		v.leave();
		await new Promise(resolve => setTimeout(resolve, 50));
	});
});
