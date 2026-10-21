/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { codeLinks, openCommit, startTicketBranch } from './codeLinks';
import { isAllowedRequest } from './core/teamApi';
import type { ActivityTracker } from './timeTracking';
import type { Account } from './teams/account';
import type { Team } from './teams/client';
import { TeamFileSystem, teamNoteUri } from './teams/teamFileSystem';

/** What the workspace page sends to the extension. */
interface PageMessage {
	type?: string;
	id?: number;
	method?: string;
	path?: string;
	body?: unknown;
	name?: string;
	command?: string;
	key?: string;
	title?: string;
	root?: string;
	hash?: string;
	subject?: string;
	from?: string;
	to?: string;
	logged?: Record<string, number>;
	suggestion?: string;
}

/**
 * The team workspace: board, tickets, timesheet and RFCs in an editor tab,
 * one per team. The page talks to the notes server through this panel,
 * which adds the session token so the page never sees it.
 */
export class WorkspacePanel implements vscode.Disposable {

	private static readonly panels = new Map<string, WorkspacePanel>();

	static show(context: vscode.ExtensionContext, account: Account, fs: TeamFileSystem, tracker: ActivityTracker, team: Team): WorkspacePanel {
		const existing = WorkspacePanel.panels.get(team.id);
		if (existing) {
			existing.panel.reveal();
			return existing;
		}
		const panel = new WorkspacePanel(context, account, fs, tracker, team);
		WorkspacePanel.panels.set(team.id, panel);
		return panel;
	}

	static closeAll(): void {
		for (const panel of [...WorkspacePanel.panels.values()]) {
			panel.dispose();
		}
	}

	private readonly panel: vscode.WebviewPanel;
	private readonly disposables: vscode.Disposable[] = [];
	private ready = false;
	private pending: { type: 'openItem'; number: number } | { type: 'openView'; view: string } | undefined;

	private constructor(context: vscode.ExtensionContext, private readonly account: Account, private readonly fs: TeamFileSystem, private readonly tracker: ActivityTracker, private readonly team: Team) {
		const media = vscode.Uri.joinPath(context.extensionUri, 'media');
		this.panel = vscode.window.createWebviewPanel('nighthawk.notes.workspace', team.name, vscode.ViewColumn.Active, {
			enableScripts: true,
			localResourceRoots: [media],
			retainContextWhenHidden: true,
		});
		this.panel.iconPath = new vscode.ThemeIcon('project');
		this.panel.webview.html = this.html(this.panel.webview, media);
		this.disposables.push(
			this.panel.onDidDispose(() => this.dispose()),
			this.panel.webview.onDidReceiveMessage(message => this.onMessage(message)),
			fs.onDidChangeTeams(() => {
				const current = fs.getTeam(team.id);
				if (current) {
					this.panel.title = current.name;
				} else if (account.user) {
					// Removed from the team, or the team was deleted.
					this.dispose();
				}
			}),
			account.onDidChange(() => {
				if (!account.user) {
					this.dispose();
				}
			}),
		);
	}

	dispose(): void {
		if (WorkspacePanel.panels.get(this.team.id) === this) {
			WorkspacePanel.panels.delete(this.team.id);
		}
		this.disposables.forEach(d => d.dispose());
		this.panel.dispose();
	}

	/** Opens the ticket with this number, once the page has loaded. */
	revealItem(number: number): void {
		this.postWhenReady({ type: 'openItem', number });
	}

	/** Switches to a view such as the timesheet, once the page has loaded. */
	revealView(view: 'timesheet'): void {
		this.postWhenReady({ type: 'openView', view });
	}

	private postWhenReady(message: NonNullable<WorkspacePanel['pending']>): void {
		if (this.ready) {
			this.panel.webview.postMessage(message);
		} else {
			this.pending = message;
		}
	}

	private async onMessage(message: PageMessage | undefined): Promise<void> {
		switch (message?.type) {
			case 'ready':
				this.ready = true;
				this.panel.webview.postMessage({
					type: 'init',
					teamId: this.team.id,
					teamName: this.fs.getTeam(this.team.id)?.name ?? this.team.name,
					me: this.account.user,
					l10n: vscode.l10n.bundle,
				});
				if (this.pending) {
					this.panel.webview.postMessage(this.pending);
					this.pending = undefined;
				}
				break;
			case 'timeSuggestions': {
				const logged = Object.fromEntries(Object.entries(message.logged ?? {}).filter(([, minutes]) => typeof minutes === 'number'));
				const data = this.tracker.suggestions(this.team.id, String(message.from ?? ''), String(message.to ?? ''), logged);
				this.panel.webview.postMessage({ type: 'response', id: Number(message.id), ok: true, data });
				break;
			}
			case 'dismissSuggestion':
				this.tracker.dismiss(String(message.suggestion ?? ''));
				this.panel.webview.postMessage({ type: 'response', id: Number(message.id), ok: true, data: null });
				break;
			case 'codeLinks': {
				const data = await codeLinks(String(message.key ?? '')).catch(() => ({ repositories: [] }));
				this.panel.webview.postMessage({ type: 'response', id: Number(message.id), ok: true, data });
				break;
			}
			case 'startBranch':
				await startTicketBranch(String(message.key ?? ''), String(message.title ?? ''));
				break;
			case 'openCommit':
				await openCommit(String(message.root ?? ''), String(message.hash ?? ''), String(message.subject ?? ''));
				break;
			case 'request':
				await this.request(Number(message.id), String(message.method), String(message.path), message.body);
				break;
			case 'openNote':
				if (typeof message.path === 'string') {
					await vscode.window.showTextDocument(teamNoteUri(this.team.id, message.path), { viewColumn: vscode.ViewColumn.Beside });
				}
				break;
			case 'openNoteByName': {
				const name = String(message.name ?? '').toLowerCase();
				const note = this.fs.notesOf(this.team.id).find(n => n.path.toLowerCase() === name || n.path.toLowerCase().replace(/\.md$/, '').split('/').pop() === name);
				if (note) {
					await vscode.window.showTextDocument(teamNoteUri(this.team.id, note.path), { viewColumn: vscode.ViewColumn.Beside });
				} else {
					vscode.window.showInformationMessage(vscode.l10n.t('There is no team note named "{0}" yet.', String(message.name ?? '')));
				}
				break;
			}
			case 'command': {
				const node = { kind: 'team', team: this.fs.getTeam(this.team.id) ?? this.team };
				if (message.command === 'invite') {
					await vscode.commands.executeCommand('nighthawk.notes.teams.invite', node);
				} else if (message.command === 'newNote') {
					await vscode.commands.executeCommand('nighthawk.notes.teams.newNote', node);
				} else if (message.command === 'showNotes') {
					await vscode.commands.executeCommand('nighthawk.notes.teams.focus');
				}
				break;
			}
		}
	}

	private async request(id: number, method: string, path: string, body: unknown): Promise<void> {
		if (!isAllowedRequest(this.team.id, method, path)) {
			this.panel.webview.postMessage({ type: 'response', id, ok: false, status: 403, error: vscode.l10n.t('This request is not allowed from the team workspace.') });
			return;
		}
		try {
			const data = await this.account.client.call(method, path, body);
			this.panel.webview.postMessage({ type: 'response', id, ok: true, data });
		} catch (err) {
			this.panel.webview.postMessage({ type: 'response', id, ok: false, status: err.status ?? 0, error: err.message });
		}
	}

	private html(webview: vscode.Webview, media: vscode.Uri): string {
		const nonce = [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, '0')).join('');
		const script = webview.asWebviewUri(vscode.Uri.joinPath(media, 'workspace.js'));
		const style = webview.asWebviewUri(vscode.Uri.joinPath(media, 'workspace.css'));
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
