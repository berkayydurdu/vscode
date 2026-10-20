/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { monthKey, type UsageHostMessage, type UsagePageMessage } from '../core/usage';
import type { UsageMeter } from './usage';

/** The "AI Usage" editor tab: spending per day, model, conversation and feature. */
export class UsagePanel implements vscode.Disposable {
	private static current: UsagePanel | undefined;

	static show(context: vscode.ExtensionContext, meter: UsageMeter, openChat: (id: string) => Promise<void>): void {
		if (UsagePanel.current) {
			UsagePanel.current.panel.reveal();
			return;
		}
		UsagePanel.current = new UsagePanel(context, meter, openChat);
	}

	private readonly panel: vscode.WebviewPanel;
	private readonly disposables: vscode.Disposable[] = [];
	private month = monthKey(Date.now());

	private constructor(context: vscode.ExtensionContext, private readonly meter: UsageMeter, private readonly openChat: (id: string) => Promise<void>) {
		const media = vscode.Uri.joinPath(context.extensionUri, 'media');
		this.panel = vscode.window.createWebviewPanel('nighthawk.ai.usage', vscode.l10n.t('AI Usage'), vscode.ViewColumn.Active, { enableScripts: true, localResourceRoots: [media], retainContextWhenHidden: true });
		this.panel.iconPath = new vscode.ThemeIcon('pulse');
		this.panel.webview.html = this.html(media);
		this.disposables.push(
			this.panel,
			this.panel.onDidDispose(() => this.dispose()),
			this.panel.webview.onDidReceiveMessage(message => this.onMessage(message as UsagePageMessage)),
			meter.onDidChange(() => this.post()),
			vscode.workspace.onDidChangeConfiguration(e => {
				if (e.affectsConfiguration('nighthawk.ai')) {
					this.post();
				}
			}),
		);
	}

	dispose(): void {
		UsagePanel.current = undefined;
		this.disposables.splice(0).forEach(d => d.dispose());
	}

	private async onMessage(message: UsagePageMessage): Promise<void> {
		switch (message.type) {
			case 'ready':
				return this.post(true);
			case 'month':
				if (/^\d{4}-\d{2}$/.test(message.month)) {
					this.month = message.month;
					return this.post();
				}
				return;
			case 'editLimit':
				return this.meter.editLimit();
			case 'editPrice':
				return this.meter.editPrice(message.model);
			case 'openChat':
				return this.openChat(message.id);
			case 'settings':
				await vscode.commands.executeCommand('workbench.action.openSettings', 'nighthawk.ai.monthlyLimit nighthawk.ai.prices');
				return;
		}
	}

	private async post(withL10n = false): Promise<void> {
		const message: UsageHostMessage = {
			type: 'summary',
			l10n: withL10n ? vscode.l10n.bundle : undefined,
			summary: await this.meter.summary(this.month),
			months: await this.meter.months(),
			limit: this.meter.limit(),
			allowedOver: this.meter.isAllowedOver(),
			current: this.month === monthKey(Date.now()),
			now: Date.now(),
		};
		this.panel.webview.postMessage(message);
	}

	private html(media: vscode.Uri): string {
		const webview = this.panel.webview;
		const nonce = [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, '0')).join('');
		const script = webview.asWebviewUri(vscode.Uri.joinPath(media, 'usage.js'));
		const style = webview.asWebviewUri(vscode.Uri.joinPath(media, 'usage.css'));
		return `<!DOCTYPE html>
<html lang="${vscode.env.language}">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<link rel="stylesheet" href="${style}">
</head>
<body>
	<script type="module" nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
	}
}
