/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { createServer as createTcpServer, type AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { createApp } from '../src/app.ts';
import { SmtpMailer, type MailMessage } from '../src/mail.ts';
import { Store } from '../src/store.ts';

let server: Server;
let store: Store;
let base: string;
const outbox: MailMessage[] = [];

before(async () => {
	store = new Store(':memory:');
	const mailer = {
		async send(message: MailMessage) {
			if (message.to.startsWith('bounce')) {
				throw new Error('550 No such user');
			}
			outbox.push(message);
		},
	};
	server = createApp(store, { publicUrl: 'https://notes.example.com', allowRegistration: true, appUrlProtocol: 'nighthawk', sessionTtlMs: 3600_000, mailer });
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

async function register(email: string, name: string): Promise<string> {
	return (await call('POST', '/api/auth/register', undefined, { email, name, password: 'correct horse' })).json.token;
}

describe('email invites', () => {
	it('emails an invite that only the invited address can accept', async () => {
		const owner = await register('olivia@example.com', 'Olivia');
		const team = (await call('POST', '/api/teams', owner, { name: 'Docs' })).json.team;
		const result = await call('POST', `/api/teams/${team.id}/invites/email`, owner, { emails: ['pat@example.com', 'bounce@example.com'], role: 'viewer', message: 'See you there!' });
		const invalid = await call('POST', `/api/teams/${team.id}/invites/email`, owner, { emails: ['not an email'] });
		const code = result.json.sent[0].code;

		const stranger = await register('sam@example.com', 'Sam');
		const wrongPerson = await call('POST', `/api/invites/${code}/accept`, stranger);
		const pat = await register('Pat@Example.com', 'Pat');
		const accepted = await call('POST', `/api/invites/${code}/accept`, pat);
		const listed = (await call('GET', `/api/teams/${team.id}/invites`, owner)).json.invites;

		assert.deepStrictEqual({
			status: result.status,
			sent: result.json.sent.map((i: any) => [i.email, i.role, i.maxUses]),
			failed: result.json.failed,
			mail: outbox.map(m => [m.to, m.subject, m.text.includes(`https://notes.example.com/invite/${code}`), m.text.includes('See you there!')]),
			invalid: invalid.status,
			wrongPerson: [wrongPerson.status, wrongPerson.json.error],
			accepted: [accepted.status, accepted.json.role],
			// Used up and the bounced one revoked.
			listed,
		}, {
			status: 201,
			sent: [['pat@example.com', 'viewer', 1]],
			failed: [{ email: 'bounce@example.com', error: '550 No such user' }],
			mail: [['pat@example.com', 'Olivia invited you to Docs on Nighthawk Notes', true, true]],
			invalid: 400,
			wrongPerson: [403, 'This invite was sent to pat@example.com. Sign in with that email address to accept it.'],
			accepted: [200, 'viewer'],
			listed: [],
		});
	});
});

describe('SMTP', () => {
	it('hands a message to a mail server', async () => {
		const received: string[] = [];
		const smtp = createTcpServer(socket => {
			let data = false;
			let message = '';
			socket.write('220 test ESMTP\r\n');
			socket.on('data', chunk => {
				for (const line of chunk.toString().split('\r\n').filter((l, i, all) => l || i < all.length - 1)) {
					if (data) {
						if (line === '.') {
							data = false;
							received.push(message);
							socket.write('250 queued\r\n');
						} else {
							message += line + '\n';
						}
						continue;
					}
					received.push(line);
					if (line.startsWith('EHLO')) {
						socket.write('250-test\r\n250 AUTH PLAIN\r\n');
					} else if (line.startsWith('AUTH PLAIN')) {
						socket.write('235 ok\r\n');
					} else if (line === 'DATA') {
						data = true;
						socket.write('354 go on\r\n');
					} else if (line === 'QUIT') {
						socket.end('221 bye\r\n');
					} else {
						socket.write('250 ok\r\n');
					}
				}
			});
		});
		await new Promise<void>(resolve => smtp.listen(0, '127.0.0.1', resolve));
		const port = (smtp.address() as AddressInfo).port;
		await new SmtpMailer(`smtp://me%40example.com:secret@127.0.0.1:${port}`, 'Nighthawk Notes <notes@example.com>')
			.send({ to: 'pat@example.com', subject: 'Hello ü', text: 'Line one\nLine two' });
		smtp.close();
		const message = received.find(line => line.includes('Subject:'))!;
		const body = message.split('\n\n')[1].replace(/\n/g, '');
		assert.deepStrictEqual({
			commands: received.filter(line => !line.includes('Subject:')).map(line => line.replace(/^EHLO .*/, 'EHLO')),
			subject: /^Subject: (.*)$/m.exec(message)?.[1],
			body: Buffer.from(body, 'base64').toString(),
		}, {
			commands: ['EHLO', `AUTH PLAIN ${Buffer.from('\0me@example.com\0secret').toString('base64')}`, 'MAIL FROM:<notes@example.com>', 'RCPT TO:<pat@example.com>', 'DATA', 'QUIT'],
			subject: '=?UTF-8?B?SGVsbG8gw7w=?=',
			body: 'Line one\r\nLine two',
		});
	});
});
