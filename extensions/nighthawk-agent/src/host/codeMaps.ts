/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { codeMapMarkdown, mapPrompt, type CodeMap, type CodeMapHostMessage, type CodeMapPageMessage } from '../core/codemap';

/**
 * Code maps the agent made with its CodeMap tool: shown in an editor tab as
 * a diagram and an outline, and kept per workspace to open again.
 */
export class CodeMaps implements vscode.Disposable {
	private panel: vscode.WebviewPanel | undefined;
	private current: CodeMap | undefined;
	private readonly dir: string;
	/** The question of the map being made from "AI: New Code Map...", as the tool does not repeat it. */
	private pendingQuestion: string | undefined;

	constructor(private readonly context: vscode.ExtensionContext, workspaceKey: string, private readonly startAgent: (shown: string, prompt: string) => Promise<void>, private readonly toAgent: (text: string) => Promise<void>) {
		this.dir = path.join(context.globalStorageUri.fsPath, 'maps', workspaceKey);
	}

	dispose(): void {
		this.panel?.dispose();
	}

	/** Asks for a question and has the agent explore the code and draw the map. */
	async create(question?: string): Promise<void> {
		question ??= await vscode.window.showInputBox({
			title: vscode.l10n.t('New Code Map'),
			prompt: vscode.l10n.t('What should the map explain? The agent reads the code and draws the parts involved and how they connect.'),
			placeHolder: vscode.l10n.t('How does a request get from the router to the database?'),
			ignoreFocusOut: true,
		});
		if (!question?.trim()) {
			return;
		}
		this.pendingQuestion = question.trim();
		await this.startAgent(vscode.l10n.t('Code map: {0}', this.pendingQuestion), mapPrompt(this.pendingQuestion));
	}

	/** Saves a map from the agent and shows it. */
	async show(map: CodeMap): Promise<void> {
		const saved: CodeMap = { ...map, id: randomUUID(), question: this.pendingQuestion ?? map.question };
		this.pendingQuestion = undefined;
		await this.save(saved);
		this.open(saved);
	}

	private async save(map: CodeMap): Promise<void> {
		await mkdir(this.dir, { recursive: true });
		const file = path.join(this.dir, `${map.id}.json`);
		const temp = `${file}.${process.pid}.tmp`;
		await writeFile(temp, JSON.stringify(map));
		await rename(temp, file);
	}

	private async list(): Promise<CodeMap[]> {
		const names = await readdir(this.dir).catch(() => [] as string[]);
		const maps = await Promise.all(names.filter(n => n.endsWith('.json')).map(async name => {
			try {
				return JSON.parse(await readFile(path.join(this.dir, name), 'utf8')) as CodeMap;
			} catch {
				return undefined;
			}
		}));
		return maps.filter((m): m is CodeMap => !!m?.id && Array.isArray(m.sections)).sort((a, b) => b.created - a.created);
	}

	/** Lists the workspace's maps to open or delete one. */
	async pick(): Promise<void> {
		const maps = await this.list();
		type Item = vscode.QuickPickItem & { map?: CodeMap; create?: boolean };
		const remove: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('trash'), tooltip: vscode.l10n.t('Delete') };
		const pick = vscode.window.createQuickPick<Item>();
		pick.title = vscode.l10n.t('Code Maps');
		pick.placeholder = vscode.l10n.t('Maps the agent drew for this workspace');
		const render = (list: CodeMap[]) => {
			pick.items = [
				...list.map<Item>(map => ({
					label: `$(type-hierarchy) ${map.title}`,
					description: new Date(map.created).toLocaleDateString(),
					detail: map.question,
					buttons: [remove],
					map,
				})),
				{ label: `$(add) ${vscode.l10n.t('New Code Map...')}`, create: true, alwaysShow: true },
			];
		};
		render(maps);
		pick.onDidTriggerItemButton(async e => {
			if (e.item.map) {
				await rm(path.join(this.dir, `${e.item.map.id}.json`), { force: true });
				render(await this.list());
			}
		});
		pick.onDidAccept(() => {
			const item = pick.selectedItems[0];
			pick.hide();
			if (item?.create) {
				this.create();
			} else if (item?.map) {
				this.open(item.map);
			}
		});
		pick.onDidHide(() => pick.dispose());
		pick.show();
	}

	private open(map: CodeMap): void {
		this.current = map;
		if (!this.panel) {
			const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
			const panel = this.panel = vscode.window.createWebviewPanel('nighthawk.codeMap', map.title, vscode.ViewColumn.Active, { enableScripts: true, localResourceRoots: [media], retainContextWhenHidden: true });
			panel.iconPath = new vscode.ThemeIcon('type-hierarchy');
			panel.webview.html = this.html(panel.webview, media);
			panel.webview.onDidReceiveMessage(message => this.onMessage(message as CodeMapPageMessage));
			panel.onDidDispose(() => this.panel = undefined);
		} else {
			this.panel.reveal();
			this.post();
		}
		this.panel.title = map.title;
	}

	private post(): void {
		if (this.current) {
			const message: CodeMapHostMessage = { type: 'map', map: this.current, l10n: vscode.l10n.bundle };
			this.panel?.webview.postMessage(message);
		}
	}

	private async onMessage(message: CodeMapPageMessage): Promise<void> {
		const map = this.current;
		switch (message.type) {
			case 'ready':
				return this.post();
			case 'open': {
				const root = vscode.workspace.workspaceFolders?.[0]?.uri;
				const uri = path.isAbsolute(message.file) ? vscode.Uri.file(message.file) : root && vscode.Uri.joinPath(root, message.file);
				if (!uri || typeof message.line !== 'number') {
					return;
				}
				const start = new vscode.Position(Math.max(0, message.line - 1), 0);
				const end = new vscode.Position(Math.max(0, (message.endLine ?? message.line) - 1), 0);
				const editor = await vscode.window.showTextDocument(uri, { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false, selection: new vscode.Range(start, start) });
				editor.revealRange(new vscode.Range(start, end), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
				return;
			}
			case 'copy':
				if (map) {
					await vscode.env.clipboard.writeText(codeMapMarkdown(map));
					vscode.window.showInformationMessage(vscode.l10n.t('Copied the map as Markdown.'));
				}
				return;
			case 'followUp':
				if (map) {
					await this.toAgent(vscode.l10n.t('About the code map "{0}" ({1}): ', map.title, map.question));
				}
				return;
			case 'regenerate':
				if (map) {
					await this.create(map.question);
				}
				return;
		}
	}

	private html(webview: vscode.Webview, media: vscode.Uri): string {
		const nonce = randomBytes(16).toString('hex');
		const script = webview.asWebviewUri(vscode.Uri.joinPath(media, 'codeMap.js'));
		const style = webview.asWebviewUri(vscode.Uri.joinPath(media, 'codeMap.css'));
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
