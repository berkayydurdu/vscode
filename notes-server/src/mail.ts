/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomUUID } from 'node:crypto';
import { connect as netConnect, type Socket } from 'node:net';
import { hostname } from 'node:os';
import { connect as tlsConnect } from 'node:tls';

export interface MailMessage {
	to: string;
	subject: string;
	text: string;
}

/** Sends email; the server sends invites with it when one is set up. */
export interface Mailer {
	send(message: MailMessage): Promise<void>;
}

const TIMEOUT_MS = 20_000;

/** A reply from the mail server: its code and its text, all lines joined. */
interface Reply {
	code: number;
	text: string;
}

/**
 * A small SMTP client, enough to hand messages to a mail provider: plain
 * or TLS connections, STARTTLS, and AUTH PLAIN. Set it up with a URL such
 * as `smtp://user:password@smtp.example.com:587` (STARTTLS) or
 * `smtps://user:password@smtp.example.com` (TLS from the start).
 */
export class SmtpMailer implements Mailer {
	private readonly url: URL;
	private readonly from: string;

	constructor(url: string, from: string) {
		this.url = new URL(url);
		if (this.url.protocol !== 'smtp:' && this.url.protocol !== 'smtps:') {
			throw new Error('SMTP_URL must start with smtp:// or smtps://');
		}
		this.from = from;
	}

	async send(message: MailMessage): Promise<void> {
		const secure = this.url.protocol === 'smtps:';
		const host = this.url.hostname;
		const port = Number(this.url.port || (secure ? 465 : 587));
		let socket: Socket = await open(() => secure ? tlsConnect({ host, port, servername: host }) : netConnect({ host, port }), secure ? 'secureConnect' : 'connect');
		let session = new Session(socket);
		try {
			await session.expect(220);
			let hello = await session.command(`EHLO ${hostname() || 'localhost'}`, 250);
			if (!secure && /^STARTTLS$/im.test(hello.text)) {
				await session.command('STARTTLS', 220);
				session.detach();
				socket = await open(() => tlsConnect({ socket, servername: host }), 'secureConnect');
				session = new Session(socket);
				hello = await session.command(`EHLO ${hostname() || 'localhost'}`, 250);
			}
			const user = decodeURIComponent(this.url.username);
			if (user) {
				const password = decodeURIComponent(this.url.password);
				await session.command(`AUTH PLAIN ${Buffer.from(`\0${user}\0${password}`).toString('base64')}`, 235);
			}
			await session.command(`MAIL FROM:<${address(this.from)}>`, 250);
			await session.command(`RCPT TO:<${address(message.to)}>`, [250, 251]);
			await session.command('DATA', 354);
			await session.command(this.format(message), 250);
			await session.command('QUIT', 221).catch(() => undefined);
		} finally {
			socket.destroy();
		}
	}

	/** The message as sent after DATA: headers, a base64 body, and the closing dot. */
	private format(message: MailMessage): string {
		const domain = address(this.from).split('@')[1] || 'localhost';
		const body = Buffer.from(message.text.replace(/\r?\n/g, '\r\n')).toString('base64').replace(/.{76}/g, '$&\r\n');
		return [
			`From: ${headerValue(this.from)}`,
			`To: ${headerValue(message.to)}`,
			`Subject: ${encodeHeader(message.subject)}`,
			`Date: ${new Date().toUTCString()}`,
			`Message-ID: <${randomUUID()}@${domain}>`,
			'MIME-Version: 1.0',
			'Content-Type: text/plain; charset=utf-8',
			'Content-Transfer-Encoding: base64',
			'',
			body,
			'.',
		].join('\r\n');
	}
}

/** Opens a connection and waits until it is ready. */
function open(create: () => Socket, readyEvent: string): Promise<Socket> {
	return new Promise((resolve, reject) => {
		const socket = create();
		socket.setTimeout(TIMEOUT_MS, () => socket.destroy(new Error('The mail server did not answer in time')));
		socket.once(readyEvent, () => resolve(socket));
		socket.once('error', reject);
	});
}

/** Reads replies from the mail server, one command at a time. */
class Session {
	private buffer = '';
	private lines: string[] = [];
	private waiting: (() => void) | undefined;
	private failure: Error | undefined;
	private readonly socket: Socket;
	private readonly onData = (chunk: Buffer) => {
		this.buffer += chunk.toString('utf8');
		let end;
		while ((end = this.buffer.indexOf('\r\n')) >= 0) {
			this.lines.push(this.buffer.slice(0, end));
			this.buffer = this.buffer.slice(end + 2);
		}
		this.wake();
	};
	private readonly onError = (err: Error) => {
		this.failure = err;
		this.wake();
	};
	private readonly onClose = () => {
		this.failure ??= new Error('The mail server closed the connection');
		this.wake();
	};

	constructor(socket: Socket) {
		this.socket = socket;
		socket.on('data', this.onData);
		socket.on('error', this.onError);
		socket.on('close', this.onClose);
	}

	/** Stops reading, before the connection is handed to TLS. */
	detach(): void {
		this.socket.off('data', this.onData);
		this.socket.off('error', this.onError);
		this.socket.off('close', this.onClose);
	}

	private wake(): void {
		const waiting = this.waiting;
		this.waiting = undefined;
		waiting?.();
	}

	private async reply(): Promise<Reply> {
		const text: string[] = [];
		for (; ;) {
			while (!this.lines.length) {
				if (this.failure) {
					throw this.failure;
				}
				await new Promise<void>(resolve => this.waiting = resolve);
			}
			const line = this.lines.shift()!;
			text.push(line.slice(4));
			// "250-..." continues; "250 ..." is the last line.
			if (line[3] !== '-') {
				return { code: Number(line.slice(0, 3)), text: text.join('\n') };
			}
		}
	}

	async expect(codes: number | number[]): Promise<Reply> {
		const reply = await this.reply();
		if (![codes].flat().includes(reply.code)) {
			throw new Error(`The mail server refused: ${reply.code} ${reply.text}`);
		}
		return reply;
	}

	command(line: string, codes: number | number[]): Promise<Reply> {
		this.socket.write(line + '\r\n');
		return this.expect(codes);
	}
}

/** The address in `Name <address>`, or the whole value. */
function address(value: string): string {
	return (/<([^>]+)>/.exec(value)?.[1] ?? value).trim();
}

/** A header value with line breaks taken out, so it cannot add headers. */
function headerValue(value: string): string {
	return value.replace(/[\r\n]+/g, ' ');
}

/** Encodes a header with non-ASCII text (RFC 2047). */
function encodeHeader(value: string): string {
	const clean = headerValue(value);
	return /^[\x20-\x7e]*$/.test(clean) ? clean : `=?UTF-8?B?${Buffer.from(clean).toString('base64')}?=`;
}

/** True for something that looks like one email address. */
export function isEmail(value: string): boolean {
	return value.length <= 320 && /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/.test(value);
}
