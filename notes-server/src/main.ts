/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createApp } from './app.ts';
import { Store } from './store.ts';

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? '127.0.0.1';
const dbFile = resolve(process.env.NOTES_DB ?? 'data/notes.db');
const publicUrl = process.env.PUBLIC_URL ?? `http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`;

mkdirSync(dirname(dbFile), { recursive: true });
const store = new Store(dbFile);

const server = createApp(store, {
	publicUrl,
	allowRegistration: process.env.ALLOW_REGISTRATION !== 'false',
	appUrlProtocol: process.env.APP_URL_PROTOCOL ?? 'nighthawk',
	sessionTtlMs: Number(process.env.SESSION_TTL_DAYS ?? 30) * 24 * 3600_000,
});

server.listen(port, host, () => {
	console.log(`Nighthawk Notes server listening on http://${host}:${port}`);
	console.log(`Public URL: ${publicUrl}`);
	console.log(`Database: ${dbFile}`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
	process.on(signal, () => {
		server.close(() => {
			store.close();
			process.exit(0);
		});
	});
}
