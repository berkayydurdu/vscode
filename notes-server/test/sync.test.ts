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

describe('settings sync', () => {
	it('keeps each person\'s settings and refuses stale writes', async () => {
		const first = await register('sam');
		const other = await register('sue');
		const put = (token: string, resource: string, baseVersion: number, content: string) => call('PUT', `/api/me/sync/${resource}`, token, { baseVersion, content, machine: 'laptop' });
		const created = await put(first, 'settings', 0, '{"editor.fontSize":14}');
		const updated = await put(first, 'settings', 1, '{"editor.fontSize":15}');
		const stale = await put(first, 'settings', 1, '{"editor.fontSize":16}');
		const unknown = await put(first, 'passwords', 0, 'x');
		await put(other, 'keybindings', 0, '[]');
		const mine = (await call('GET', '/api/me/sync', first)).json.resources;
		const theirs = (await call('GET', '/api/me/sync', other)).json.resources;
		await call('DELETE', '/api/me/sync', first);
		const afterDelete = (await call('GET', '/api/me/sync', first)).json.resources;
		assert.deepStrictEqual({
			statuses: [created.status, updated.status, stale.status, unknown.status],
			mine: mine.map((r: any) => [r.resource, r.version, r.content, r.machine]),
			theirs: theirs.map((r: any) => r.resource),
			afterDelete,
		}, {
			statuses: [200, 200, 409, 404],
			mine: [['settings', 2, '{"editor.fontSize":15}', 'laptop']],
			theirs: ['keybindings'],
			afterDelete: [],
		});
	});
});
