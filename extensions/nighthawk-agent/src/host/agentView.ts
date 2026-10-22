/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path';
import * as vscode from 'vscode';
import type { HostMessage, PageMessage } from '../core/protocol';
import { resolvePath } from '../core/workspace';
import { Session, type Services, type SessionOptions } from './session';

const DIFF_SCHEME = 'nighthawk-agent-diff';

/** Serves the before and after texts of agent edits to the diff editor. */
export class DiffContentProvider implements vscode.TextDocumentContentProvider {
	private readonly texts = new Map<string, string>();

	static register(): { provider: DiffContentProvider; disposable: vscode.Disposable } {
		const provider = new DiffContentProvider();
		return { provider, disposable: vscode.workspace.registerTextDocumentContentProvider(DIFF_SCHEME, provider) };
	}

	set(key: string, file: string, text: string): vscode.Uri {
		this.texts.set(key, text);
		return vscode.Uri.from({ scheme: DIFF_SCHEME, path: `/${key}/${path.basename(file)}` });
	}

	provideTextDocumentContent(uri: vscode.Uri): string {
		return this.texts.get(uri.path.split('/')[1]) ?? '';
	}
}

export interface ControllerHost extends Omit<Services, 'reveal' | 'isVisible'> {
	diffs: DiffContentProvider;
	/** A conversation that is running elsewhere, such as a background task, to show instead of loading a copy. */
	liveSession?(id: string): Session | undefined;
}

/** Connects one agent page (the side bar view or an editor tab) to a conversation. */
export class AgentController implements vscode.Disposable {
	session: Session;
	private listener: vscode.Disposable | undefined;
	private readonly disposables: vscode.Disposable[] = [];
	private ready = false;
	/** Text to put in the input once the page is ready, when asked before it was. */
	private pendingPrefill: { text: string; append: boolean }[] = [];
	/** Conversations shown here that something else owns, such as background tasks. */
	private readonly borrowed = new WeakSet<Session>();
	private readonly disposed = new vscode.EventEmitter<void>();
	readonly onDidDispose = this.disposed.event;

	constructor(
		private readonly host: ControllerHost,
		private readonly webview: vscode.Webview,
		private readonly reveal: () => void,
		private readonly isVisible: () => boolean,
		private readonly onTitle?: (title: string) => void,
	) {
		const media = vscode.Uri.joinPath(host.context.extensionUri, 'media');
		webview.options = { enableScripts: true, localResourceRoots: [media] };
		webview.html = this.html(media);
		this.session = this.newSession();
		this.disposables.push(
			webview.onDidReceiveMessage(message => this.onMessage(message as PageMessage)),
			host.endpoints.onDidChange(() => this.session.postState()),
			host.mcp.onDidChange(() => this.session.postState()),
			vscode.workspace.onDidChangeConfiguration(e => {
				if (e.affectsConfiguration('nighthawk.agent')) {
					this.session.postState();
				}
			}),
		);
	}

	dispose(): void {
		this.listener?.dispose();
		if (!this.borrowed.has(this.session)) {
			this.session.dispose();
		}
		this.disposables.forEach(d => d.dispose());
		this.disposed.fire();
		this.disposed.dispose();
	}

	get visible(): boolean {
		return this.isVisible();
	}

	/** Brings the page to the front. */
	revealPage(): void {
		this.reveal();
	}

	/** Shows a conversation that something else owns, such as a background task, without taking it over. */
	show(session: Session): void {
		const old = this.session;
		this.borrowed.add(session);
		this.attach(session);
		this.release(old);
	}

	/** Disposes a conversation that is no longer shown, unless it is still working or owned elsewhere. */
	private release(session: Session): void {
		// A running conversation keeps going in the background until it finishes.
		if (!session.running && !this.borrowed.has(session)) {
			session.dispose();
		}
	}

	private services(): Services {
		return { ...this.host, reveal: this.reveal, isVisible: this.isVisible };
	}

	private newSession(data?: ConstructorParameters<typeof Session>[1], options?: SessionOptions): Session {
		const session = new Session(this.services(), data, options);
		this.attach(session);
		return session;
	}

	private attach(session: Session): void {
		this.listener?.dispose();
		this.session = session;
		this.listener = session.onMessage(message => {
			this.post(message);
			if (message.type === 'state') {
				this.onTitle?.(message.state.title);
			}
		});
		if (this.ready) {
			this.post({ type: 'init', l10n: vscode.l10n.bundle, state: session.viewState(), items: session.transcript() });
		}
		this.onTitle?.(session.viewState().title);
	}

	private post(message: HostMessage): void {
		if (this.ready) {
			this.webview.postMessage(message);
		}
	}

	/** Starts a conversation, with an external agent such as Claude Code when `options.external` names one. */
	startNew(options?: SessionOptions): void {
		if (this.session.isEmpty && !this.session.running && this.session.external?.agent === options?.external) {
			this.post({ type: 'focus' });
			return;
		}
		const old = this.session;
		this.newSession(undefined, options);
		this.release(old);
		this.post({ type: 'focus' });
	}

	async open(id: string): Promise<void> {
		if (!await this.openIfSaved(id)) {
			vscode.window.showWarningMessage(vscode.l10n.t('That conversation could not be loaded.'));
		}
	}

	/** Shows the conversation; false when it is neither running nor saved. */
	async openIfSaved(id: string): Promise<boolean> {
		if (id === this.session.id) {
			return true;
		}
		const live = this.host.liveSession?.(id);
		if (live) {
			this.show(live);
			return true;
		}
		const data = await this.host.store.load(id);
		if (!data) {
			return false;
		}
		const old = this.session;
		this.newSession(data);
		this.release(old);
		return true;
	}

	prefill(text: string, append = true): void {
		if (!this.ready) {
			this.pendingPrefill.push({ text, append });
			return;
		}
		this.post({ type: 'prefill', text, append });
		this.post({ type: 'focus' });
	}

	focusInput(): void {
		this.post({ type: 'focus' });
	}

	async showHistory(): Promise<void> {
		const sessions = await this.host.store.list();
		if (!sessions.length) {
			vscode.window.showInformationMessage(vscode.l10n.t('No past conversations in this workspace yet.'));
			return;
		}
		const pick = await vscode.window.showQuickPick(sessions.map(s => ({
			label: s.title,
			description: new Date(s.updated).toLocaleString(),
			id: s.id,
		})), { title: vscode.l10n.t('Resume a Conversation'), matchOnDescription: true });
		if (pick) {
			await this.open(pick.id);
		}
	}

	private async onMessage(message: PageMessage): Promise<void> {
		const session = this.session;
		switch (message.type) {
			case 'ready':
				this.ready = true;
				this.post({ type: 'init', l10n: vscode.l10n.bundle, state: session.viewState(), items: session.transcript() });
				session.refreshCommands();
				for (const { text, append } of this.pendingPrefill.splice(0)) {
					this.prefill(text, append);
				}
				break;
			case 'send':
				await session.send(message.text);
				break;
			case 'stop':
				session.stop();
				break;
			case 'approve':
				session.resolveWaiting(message.id, { decision: message.decision, feedback: message.feedback });
				break;
			case 'answer':
				session.resolveWaiting(message.id, message.answer);
				break;
			case 'plan':
				session.resolveWaiting(message.id, { approve: message.approve, mode: message.mode });
				break;
			case 'setMode':
				session.setMode(message.mode);
				break;
			case 'pickModel':
				if (session.external) {
					await vscode.commands.executeCommand('nighthawk.agent.external.start');
				} else {
					await this.host.endpoints.pickModel();
				}
				session.postState();
				break;
			case 'newSession':
				this.startNew();
				break;
			case 'history':
				this.post({ type: 'sessions', sessions: await this.host.store.list() });
				break;
			case 'openSession':
				await this.open(message.id);
				break;
			case 'deleteSession':
				await this.host.store.delete(message.id);
				this.post({ type: 'sessions', sessions: await this.host.store.list() });
				break;
			case 'mention':
				this.post({ type: 'mentions', requestId: message.requestId, results: await this.mentions(message.query).catch(() => []) });
				break;
			case 'openFile':
				await this.openFile(message.path, message.line);
				break;
			case 'openDiff':
				await this.openDiff(message.id);
				break;
			case 'rewind':
				await session.rewind(message.id);
				break;
			case 'action':
				await this.action(message.action);
				break;
		}
	}

	private async action(action: string): Promise<void> {
		switch (action) {
			case 'addEndpoint':
				await this.host.endpoints.add();
				break;
			case 'setKey':
				await this.host.endpoints.setKey(this.host.endpoints.current()?.endpoint);
				break;
			case 'retry':
				this.session.retry();
				break;
			case 'restartMcp':
				await this.host.mcp.restart();
				vscode.window.showInformationMessage(vscode.l10n.t('MCP servers restarted.'));
				break;
			case 'settings':
				await vscode.commands.executeCommand('workbench.action.openSettings', 'nighthawk.agent');
				break;
			case 'endpoints':
				await this.host.endpoints.manage();
				break;
			case 'editLimit':
				await this.host.usage.editLimit();
				break;
			case 'allowOverLimit':
				await this.host.usage.allowThisMonth();
				this.session.retry();
				break;
			case 'showUsage':
				await vscode.commands.executeCommand('nighthawk.ai.showUsage');
				break;
			case 'undoRestore':
				await this.session.undoRestore();
				break;
			default:
				if (action.startsWith('acp:')) {
					await this.session.externalAction(action.slice(4));
				}
		}
		this.session.postState();
	}

	private async mentions(query: string): Promise<{ label: string; detail?: string; insert: string }[]> {
		const folders = vscode.workspace.workspaceFolders ?? [];
		if (!folders.length) {
			return [];
		}
		const clean = query.replace(/[\\[\]{}*?]/g, '');
		const pattern = clean ? `**/*${clean.split('/').pop()}*` : '**/*';
		const files = await vscode.workspace.findFiles(pattern, '**/{node_modules,.git,out,dist}/**', 200);
		const lower = clean.toLowerCase();
		const scored = files.map(uri => {
			const rel = vscode.workspace.asRelativePath(uri, folders.length > 1);
			const name = path.basename(rel).toLowerCase();
			const score = !lower || name.startsWith(lower) ? 0 : name.includes(lower) ? 1 : rel.toLowerCase().includes(lower) ? 2 : 3;
			return { rel, score };
		}).filter(f => f.score < 3).sort((a, b) => a.score - b.score || a.rel.length - b.rel.length);
		// Offer open editors first when nothing is typed.
		const open = !clean ? vscode.window.tabGroups.all.flatMap(g => g.tabs).map(t => (t.input as { uri?: vscode.Uri })?.uri).filter((u): u is vscode.Uri => !!u && u.scheme === 'file').map(u => vscode.workspace.asRelativePath(u, folders.length > 1)) : [];
		const names = [...new Set([...open, ...scored.map(s => s.rel)])].slice(0, 12);
		return names.map(rel => ({ label: path.basename(rel), detail: path.dirname(rel) === '.' ? undefined : path.dirname(rel), insert: rel.includes(' ') ? `"${rel}"` : rel }));
	}

	private async openFile(file: string, line?: number): Promise<void> {
		// Codebase search results are shown as "path:start-end".
		const at = /:(\d+)(?:-\d+)?$/.exec(file);
		if (at && !line) {
			file = file.slice(0, at.index);
			line = Number(at[1]);
		}
		const roots = (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath);
		const absolute = resolvePath({ roots }, file);
		try {
			const editor = await vscode.window.showTextDocument(vscode.Uri.file(absolute), { preview: true, viewColumn: vscode.ViewColumn.One });
			if (line && line > 0) {
				const position = new vscode.Position(line - 1, 0);
				editor.selection = new vscode.Selection(position, position);
				editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
			}
		} catch {
			vscode.window.showWarningMessage(vscode.l10n.t('Could not open {0}.', file));
		}
	}

	private async openDiff(id: string): Promise<void> {
		const diff = this.session.diffFor(id);
		if (!diff) {
			return;
		}
		const left = this.host.diffs.set(`${id}-before`, diff.path, diff.before);
		const right = this.host.diffs.set(`${id}-after`, diff.path, diff.after);
		await vscode.commands.executeCommand('vscode.diff', left, right, vscode.l10n.t('{0} (Agent Change)', path.basename(diff.path)), { preview: true, viewColumn: vscode.ViewColumn.One });
	}

	private html(media: vscode.Uri): string {
		const nonce = [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, '0')).join('');
		const script = this.webview.asWebviewUri(vscode.Uri.joinPath(media, 'agent.js'));
		const style = this.webview.asWebviewUri(vscode.Uri.joinPath(media, 'agent.css'));
		return `<!DOCTYPE html>
<html lang="${vscode.env.language}">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${this.webview.cspSource} data:; style-src ${this.webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<link rel="stylesheet" href="${style}">
</head>
<body>
	<script type="module" nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
	}
}

/** The agent in the secondary side bar. */
export class AgentViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
	static readonly viewId = 'nighthawk.agent.chat';
	controller: AgentController | undefined;
	private view: vscode.WebviewView | undefined;
	private readonly resolved = new vscode.EventEmitter<AgentController>();
	readonly onDidResolve = this.resolved.event;

	constructor(private readonly host: ControllerHost) { }

	resolveWebviewView(view: vscode.WebviewView): void {
		this.view = view;
		this.controller?.dispose();
		this.controller = new AgentController(this.host, view.webview, () => view.show(true), () => view.visible, title => {
			view.description = title || undefined;
		});
		view.onDidDispose(() => {
			this.controller?.dispose();
			this.controller = undefined;
			this.view = undefined;
		});
		this.resolved.fire(this.controller);
	}

	/** Shows the view and returns its controller once the page exists. */
	async show(): Promise<AgentController> {
		if (this.view && this.controller) {
			this.view.show(false);
			return this.controller;
		}
		const ready = new Promise<AgentController>(resolve => {
			const sub = this.onDidResolve(c => {
				sub.dispose();
				resolve(c);
			});
		});
		await vscode.commands.executeCommand(`${AgentViewProvider.viewId}.focus`);
		return ready;
	}

	dispose(): void {
		this.controller?.dispose();
		this.resolved.dispose();
	}
}

/** The agent in an editor tab, like any other editor. */
export function openAgentPanel(host: ControllerHost): AgentController {
	const panel = vscode.window.createWebviewPanel('nighthawk.agent.panel', vscode.l10n.t('Agent'), vscode.ViewColumn.Beside, { enableScripts: true, retainContextWhenHidden: true });
	panel.iconPath = new vscode.ThemeIcon('sparkle');
	const controller = new AgentController(host, panel.webview, () => panel.reveal(), () => panel.visible, title => {
		panel.title = title ? (title.length > 30 ? `${title.slice(0, 30)}...` : title) : vscode.l10n.t('Agent');
	});
	panel.onDidDispose(() => controller.dispose());
	return controller;
}
