/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { readFile } from 'node:fs/promises';
import * as http from 'node:http';
import * as https from 'node:https';
import * as net from 'node:net';
import * as tls from 'node:tls';
import { injectScript, PICKER_PATH, rewriteLocation, targetFor } from './preview';

/** Headers that would stop the page from loading in the preview's frame or from running the picker. */
const BLOCKING_HEADERS = ['x-frame-options', 'content-security-policy', 'content-security-policy-report-only', 'cross-origin-opener-policy', 'cross-origin-embedder-policy'];
const MAX_HTML = 20 * 1024 * 1024;

/**
 * Forwards everything to the dev server, adding the picker script to its
 * pages. It listens on this computer only, and only ever talks to the one
 * dev server it was made for, including its live-reload WebSocket.
 */
export class PreviewProxy {
	private server: http.Server | undefined;
	private readonly sockets = new Set<net.Socket>();
	origin = '';

	readonly target: URL;
	private readonly pickerFile: string;
	private readonly unreachable: (origin: string, error: string) => string;

	/** `unreachable` words the page shown when the dev server does not answer. */
	constructor(target: URL, pickerFile: string, unreachable: (origin: string, error: string) => string) {
		this.target = target;
		this.pickerFile = pickerFile;
		this.unreachable = unreachable;
	}

	async start(): Promise<void> {
		const server = this.server = http.createServer((req, res) => this.forward(req, res));
		server.on('upgrade', (req, socket, head) => this.upgrade(req, socket as net.Socket, head));
		server.on('connection', socket => {
			this.sockets.add(socket);
			socket.on('close', () => this.sockets.delete(socket));
		});
		await new Promise<void>((resolve, reject) => {
			server.once('error', reject);
			server.listen(0, '127.0.0.1', () => resolve());
		});
		const port = (server.address() as net.AddressInfo).port;
		this.origin = `http://127.0.0.1:${port}`;
	}

	dispose(): void {
		this.server?.close();
		this.sockets.forEach(s => s.destroy());
	}

	private headers(req: http.IncomingMessage): http.OutgoingHttpHeaders {
		const headers: http.OutgoingHttpHeaders = { ...req.headers, host: this.target.host };
		// Pages come back uncompressed so the script can be added.
		delete headers['accept-encoding'];
		for (const name of ['origin', 'referer']) {
			const value = req.headers[name];
			if (typeof value === 'string' && value.startsWith(this.origin)) {
				headers[name] = this.target.origin + value.slice(this.origin.length);
			}
		}
		return headers;
	}

	private async forward(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		if (req.url === PICKER_PATH) {
			const script = await readFile(this.pickerFile).catch(() => Buffer.from(''));
			res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
			res.end(script);
			return;
		}
		const url = targetFor(req.url ?? '/', this.target);
		if (!url) {
			res.writeHead(400).end();
			return;
		}
		// The server always comes from the target, never from the request: only the path does.
		const target = this.target;
		const request = (target.protocol === 'https:' ? https : http).request({
			protocol: target.protocol,
			hostname: target.hostname,
			port: target.port,
			path: url.pathname + url.search,
			method: req.method,
			headers: this.headers(req),
		}, upstream => {
			const headers = { ...upstream.headers };
			for (const name of BLOCKING_HEADERS) {
				delete headers[name];
			}
			if (typeof headers.location === 'string') {
				headers.location = rewriteLocation(headers.location, this.target, this.origin);
			}
			const html = /text\/html/i.test(String(headers['content-type'] ?? '')) && req.method !== 'HEAD';
			if (!html) {
				res.writeHead(upstream.statusCode ?? 502, headers);
				upstream.pipe(res);
				return;
			}
			const chunks: Buffer[] = [];
			let size = 0;
			upstream.on('data', (chunk: Buffer) => {
				size += chunk.length;
				if (size <= MAX_HTML) {
					chunks.push(chunk);
				}
			});
			upstream.on('end', () => {
				const body = Buffer.from(injectScript(Buffer.concat(chunks).toString('utf8')), 'utf8');
				delete headers['content-length'];
				delete headers['transfer-encoding'];
				res.writeHead(upstream.statusCode ?? 200, { ...headers, 'content-length': body.length });
				res.end(body);
			});
		});
		request.on('error', err => {
			if (!res.headersSent) {
				res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
			}
			res.end(this.unreachable(this.target.origin, err.message));
		});
		req.pipe(request);
	}

	/** Passes WebSocket connections, such as the dev server's live reload, straight through. */
	private upgrade(req: http.IncomingMessage, socket: net.Socket, head: Buffer): void {
		const url = targetFor(req.url ?? '/', this.target);
		if (!url) {
			socket.destroy();
			return;
		}
		const secure = url.protocol === 'https:';
		const port = Number(url.port) || (secure ? 443 : 80);
		const upstream = secure ? tls.connect({ host: url.hostname, port, servername: url.hostname }) : net.connect({ host: url.hostname, port });
		upstream.on(secure ? 'secureConnect' : 'connect', () => {
			const headers = this.headers(req);
			const lines = [`${req.method} ${url.pathname}${url.search} HTTP/1.1`];
			for (const [name, value] of Object.entries(headers)) {
				for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) {
					lines.push(`${name}: ${item}`);
				}
			}
			upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
			upstream.write(head);
			upstream.pipe(socket);
			socket.pipe(upstream);
		});
		const close = () => {
			upstream.destroy();
			socket.destroy();
		};
		upstream.on('error', close);
		socket.on('error', close);
		upstream.on('close', close);
		socket.on('close', close);
		this.sockets.add(upstream);
		upstream.on('close', () => this.sockets.delete(upstream));
	}
}
