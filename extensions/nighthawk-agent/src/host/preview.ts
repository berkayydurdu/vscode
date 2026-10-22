/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomBytes } from 'node:crypto';
import * as http from 'node:http';
import * as vscode from 'vscode';
import { PreviewProxy } from '../core/previewProxy';
import { DEV_PORTS, elementContext, elementLabel, errorsContext, pageUrl, previewUrl, type ConsoleEntry, type PickedElement, type PreviewHostMessage, type PreviewPageMessage } from '../core/preview';

/** Whether something answers HTTP on this port of this computer. */
function answers(port: number): Promise<boolean> {
	return new Promise(resolve => {
		const request = http.request({ host: 'localhost', port, method: 'HEAD', path: '/', timeout: 400 }, response => {
			response.resume();
			resolve(true);
		});
		request.on('timeout', () => request.destroy());
		request.on('error', () => resolve(false));
		request.end();
	});
}

/**
 * The live preview: one editor tab showing the user's dev server, with an
 * element picker whose picks become `@preview:N` mentions for the agent,
 * and the page's console errors as `@preview:errors`.
 */
export class Preview implements vscode.Disposable {
	private panel: vscode.WebviewPanel | undefined;
	private proxy: PreviewProxy | undefined;
	private readonly disposables: vscode.Disposable[] = [];
	private readonly elements = new Map<number, PickedElement>();
	private errors: ConsoleEntry[] = [];
	private nextId = 1;
	private page = '';

	constructor(private readonly context: vscode.ExtensionContext, private readonly toAgent: (text: string) => Promise<void>) { }

	dispose(): void {
		this.panel?.dispose();
		this.proxy?.dispose();
	}

	/** Opens the preview, asking which address when none is given. */
	async open(address?: string): Promise<void> {
		const url = address ? previewUrl(address) : await this.ask();
		if (!url) {
			return;
		}
		this.proxy?.dispose();
		const proxy = this.proxy = new PreviewProxy(url, vscode.Uri.joinPath(this.context.extensionUri, 'media', 'previewPicker.js').fsPath, (origin, error) => vscode.l10n.t('Could not reach {0}: {1}', origin, error));
		await proxy.start();
		this.errors = [];
		this.page = url.toString();
		const panel = this.ensurePanel(proxy.origin);
		panel.title = vscode.l10n.t('Preview: {0}', url.host);
		// The tab loads the page once its script is ready.
		panel.reveal(panel.viewColumn ?? vscode.ViewColumn.Beside, true);
	}

	private load(url: URL): void {
		const proxy = this.proxy;
		if (!proxy || !this.panel) {
			return;
		}
		this.post({ type: 'load', path: url.pathname + url.search + url.hash, url: url.toString(), l10n: vscode.l10n.bundle });
	}

	private async ask(): Promise<URL | undefined> {
		type Item = vscode.QuickPickItem & { url?: string };
		const pick = vscode.window.createQuickPick<Item>();
		pick.title = vscode.l10n.t('Open Live Preview');
		pick.placeholder = vscode.l10n.t('Address of your dev server, such as localhost:5173');
		pick.busy = true;
		const typed = (): Item[] => {
			const url = previewUrl(pick.value);
			return url ? [{ label: url.toString(), description: vscode.l10n.t('Open this address'), url: url.toString(), alwaysShow: true }] : [];
		};
		let found: Item[] = [];
		const render = () => {
			pick.items = [...typed(), ...found];
		};
		pick.onDidChangeValue(render);
		render();
		Promise.all(DEV_PORTS.map(async port => await answers(port) ? port : undefined)).then(ports => {
			found = ports.filter((p): p is number => !!p).map(port => ({ label: `$(globe) localhost:${port}`, description: vscode.l10n.t('running now'), url: `http://localhost:${port}/` }));
			pick.busy = false;
			if (!found.length && !pick.value) {
				pick.placeholder = vscode.l10n.t('No dev server found on the usual ports. Start one, then enter its address.');
			}
			render();
		});
		const chosen = await new Promise<string | undefined>(resolve => {
			pick.onDidAccept(() => resolve(pick.selectedItems[0]?.url ?? previewUrl(pick.value)?.toString()));
			pick.onDidHide(() => resolve(undefined));
			pick.show();
		});
		pick.dispose();
		return chosen ? previewUrl(chosen) : undefined;
	}

	private ensurePanel(proxyOrigin: string): vscode.WebviewPanel {
		if (this.panel) {
			this.panel.webview.html = this.html(proxyOrigin);
			return this.panel;
		}
		const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
		const panel = this.panel = vscode.window.createWebviewPanel('nighthawk.preview', vscode.l10n.t('Preview'), { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true }, {
			enableScripts: true,
			localResourceRoots: [media],
			retainContextWhenHidden: true,
		});
		panel.iconPath = new vscode.ThemeIcon('globe');
		panel.webview.html = this.html(proxyOrigin);
		this.disposables.push(
			panel.webview.onDidReceiveMessage(message => this.onMessage(message as PreviewPageMessage)),
			panel.onDidDispose(() => {
				this.panel = undefined;
				this.proxy?.dispose();
				this.proxy = undefined;
				this.disposables.splice(0).forEach(d => d.dispose());
			}),
		);
		return panel;
	}

	private post(message: PreviewHostMessage): void {
		this.panel?.webview.postMessage(message);
	}

	private async onMessage(message: PreviewPageMessage): Promise<void> {
		const proxy = this.proxy;
		if (!proxy) {
			return;
		}
		switch (message.type) {
			case 'ready':
				return this.load(new URL(this.page));
			case 'navigate': {
				const url = previewUrl(message.url);
				if (!url) {
					return;
				}
				if (url.origin !== proxy.target.origin) {
					return this.open(url.toString());
				}
				this.page = url.toString();
				return this.load(url);
			}
			case 'page':
				this.page = pageUrl(message.url, proxy.target);
				this.post({ type: 'address', url: this.page });
				return;
			case 'console':
				this.errors.push(message.entry);
				this.errors = this.errors.slice(-50);
				return;
			case 'picked': {
				const element = { ...message.element, url: pageUrl(message.element.url, proxy.target) };
				const id = this.nextId++;
				this.elements.set(id, element);
				if (this.elements.size > 50) {
					this.elements.delete(this.elements.keys().next().value as number);
				}
				this.post({ type: 'added', label: elementLabel(element) });
				await this.toAgent(`@preview:${id} `);
				return;
			}
			case 'sendErrors':
				await this.toAgent('@preview:errors ');
				return;
			case 'openExternal':
				await vscode.env.openExternal(vscode.Uri.parse(this.page));
				return;
		}
	}

	/** Starts or stops picking an element, for the command and its keybinding. */
	async pick(): Promise<void> {
		if (!this.panel) {
			await this.open();
		}
		this.panel?.reveal(undefined, false);
		this.post({ type: 'pick', on: true });
	}

	reload(): void {
		this.post({ type: 'reload' });
	}

	/** What the agent is told for a `@preview:N` or `@preview:errors` mention. */
	mention(ref: string): string | undefined {
		if (ref === 'errors') {
			return this.page ? errorsContext(this.page, this.errors.filter(e => e.level === 'error')) : undefined;
		}
		const element = this.elements.get(Number(ref));
		return element ? elementContext(element, this.errors.filter(e => e.level === 'error' && e.time > Date.now() - 10 * 60_000)) : undefined;
	}

	private html(proxyOrigin: string): string {
		const webview = this.panel!.webview;
		const nonce = randomBytes(16).toString('hex');
		const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
		const script = webview.asWebviewUri(vscode.Uri.joinPath(media, 'preview.js'));
		const style = webview.asWebviewUri(vscode.Uri.joinPath(media, 'preview.css'));
		return `<!DOCTYPE html>
<html lang="${vscode.env.language}">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src ${proxyOrigin}; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<link rel="stylesheet" href="${style}">
</head>
<body data-proxy="${proxyOrigin}">
	<script type="module" nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
	}
}
