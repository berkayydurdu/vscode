/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { after, describe, it } from 'node:test';
import { elementContext, elementLabel, errorsContext, injectScript, pageUrl, previewUrl, rewriteLocation, targetFor, type PickedElement } from '../src/core/preview.ts';
import { PreviewProxy } from '../src/core/previewProxy.ts';

const dir = mkdtempSync(path.join(tmpdir(), 'nh-preview-'));
after(() => rmSync(dir, { recursive: true, force: true }));

const element: PickedElement = {
	url: 'http://localhost:5173/settings',
	selector: 'main > div:nth-of-type(2) > button',
	tag: 'button',
	text: 'Save changes',
	html: '<button class="primary big" id="save">Save changes</button>',
	attributes: { class: 'primary big', id: 'save' },
	styles: { 'font-size': '13px', 'background-color': 'rgb(0, 120, 212)' },
	rect: { x: 10.4, y: 20, width: 120.2, height: 32 },
	components: ['SaveButton', 'SettingsPage'],
	source: 'src/SaveButton.tsx:12',
};

describe('live preview', () => {
	it('adds its script to pages and maps addresses between the proxy and the dev server', () => {
		const target = new URL('http://localhost:5173/');
		assert.deepEqual([
			injectScript('<!DOCTYPE html><html><head lang="en"><title>x</title></head></html>'),
			injectScript('<!doctype html><p>hi</p>'),
			injectScript('<p>hi</p>'),
			previewUrl('5173')?.toString(),
			previewUrl('localhost:3000/app')?.toString(),
			previewUrl('https://example.com')?.toString(),
			previewUrl('file:///etc/passwd'),
			targetFor('/a/b?c=1', target)?.toString(),
			targetFor('//evil.example/x', target),
			targetFor('http://evil.example/x', target),
			rewriteLocation('http://localhost:5173/login?next=1', target, 'http://127.0.0.1:9999'),
			rewriteLocation('/login', target, 'http://127.0.0.1:9999'),
			rewriteLocation('https://auth.example/', target, 'http://127.0.0.1:9999'),
			pageUrl('http://127.0.0.1:9999/settings#tab', target),
		], [
			'<!DOCTYPE html><html><head lang="en"><script src="/__nighthawk/preview.js"></script><title>x</title></head></html>',
			'<!doctype html><script src="/__nighthawk/preview.js"></script><p>hi</p>',
			'<script src="/__nighthawk/preview.js"></script><p>hi</p>',
			'http://localhost:5173/',
			'http://localhost:3000/app',
			'https://example.com/',
			undefined,
			'http://localhost:5173/a/b?c=1',
			undefined,
			undefined,
			'http://127.0.0.1:9999/login?next=1',
			'http://127.0.0.1:9999/login',
			'https://auth.example/',
			'http://localhost:5173/settings#tab',
		]);
	});

	it('tells the agent about a picked element and console errors', () => {
		const errors = [{ level: 'error' as const, text: 'TypeError: x is undefined', time: 1 }];
		assert.equal(elementLabel(element), '<SaveButton> button#save.primary.big');
		assert.equal(elementContext(element, errors), [
			'<element page="http://localhost:5173/settings">',
			'Selector: main > div:nth-of-type(2) > button',
			'Components (innermost first): SaveButton < SettingsPage',
			'Defined at: src/SaveButton.tsx:12',
			'Text: "Save changes"',
			'Size: 120x32 at 10,20',
			'Computed styles: font-size: 13px; background-color: rgb(0, 120, 212)',
			'Markup:',
			'<button class="primary big" id="save">Save changes</button>',
			'Recent console errors on this page:',
			'- TypeError: x is undefined',
			'</element>',
			'The user picked this element in the live preview. Change it in the source file above; find related code with Grep for the component name or text.',
		].join('\n'));
		assert.equal(errorsContext('http://localhost:5173/', errors), '<console page="http://localhost:5173/">\n[error] TypeError: x is undefined\n</console>');
	});

	it('proxies the dev server, its redirects and its live-reload socket', async () => {
		const picker = path.join(dir, 'picker.js');
		writeFileSync(picker, 'window.picker = 1;');
		const dev = http.createServer((req, res) => {
			if (req.url === '/old') {
				res.writeHead(302, { location: `http://127.0.0.1:${(dev.address() as net.AddressInfo).port}/new` }).end();
			} else if (req.url === '/app.js') {
				res.writeHead(200, { 'content-type': 'text/javascript' }).end('console.log(1)');
			} else {
				res.writeHead(200, { 'content-type': 'text/html', 'x-frame-options': 'DENY', 'content-security-policy': 'frame-ancestors \'none\'' });
				res.end(`<html><head></head><body>${req.url} ${req.headers.host}</body></html>`);
			}
		});
		dev.on('upgrade', (req, socket) => {
			socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
			socket.on('data', data => socket.write(`echo:${data}`));
		});
		await new Promise<void>(resolve => dev.listen(0, '127.0.0.1', resolve));
		const devPort = (dev.address() as net.AddressInfo).port;
		const proxy = new PreviewProxy(new URL(`http://127.0.0.1:${devPort}/`), picker, (origin, error) => `${origin}: ${error}`);
		await proxy.start();
		try {
			const page = await fetch(`${proxy.origin}/home`);
			const script = await fetch(`${proxy.origin}/__nighthawk/preview.js`);
			const js = await fetch(`${proxy.origin}/app.js`);
			const redirect = await fetch(`${proxy.origin}/old`, { redirect: 'manual' });
			const escape = await new Promise<number | undefined>(resolve => http.get(`${proxy.origin}//example.com/`, r => resolve(r.statusCode)));
			const echoed = await new Promise<string>((resolve, reject) => {
				const socket = net.connect(Number(new URL(proxy.origin).port), '127.0.0.1', () => {
					socket.write('GET /hmr HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
				});
				let received = '';
				socket.on('data', data => {
					received += data;
					if (received.includes('\r\n\r\n') && !received.includes('echo:')) {
						socket.write('ping');
					}
					if (received.includes('echo:ping')) {
						socket.destroy();
						resolve(received);
					}
				});
				socket.on('error', reject);
			});
			assert.deepEqual([
				await page.text(),
				page.headers.get('x-frame-options'),
				page.headers.get('content-security-policy'),
				await script.text(),
				await js.text(),
				redirect.headers.get('location'),
				escape,
				echoed.startsWith('HTTP/1.1 101'),
			], [
				`<html><head><script src="/__nighthawk/preview.js"></script></head><body>/home 127.0.0.1:${devPort}</body></html>`,
				null,
				null,
				'window.picker = 1;',
				'console.log(1)',
				`${proxy.origin}/new`,
				400,
				true,
			]);
		} finally {
			proxy.dispose();
			dev.close();
			dev.closeAllConnections();
		}
	});
});
