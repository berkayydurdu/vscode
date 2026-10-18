/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { NoteIndex } from './noteIndex';

/**
 * A panel drawing notes as dots and links as lines, like Obsidian's graph.
 * Clicking a dot opens the note.
 */
export class GraphPanel implements vscode.Disposable {

	private static current: GraphPanel | undefined;

	static show(context: vscode.ExtensionContext, index: NoteIndex, collection: string, title: string): void {
		if (GraphPanel.current) {
			GraphPanel.current.collection = collection;
			GraphPanel.current.panel.title = title;
			GraphPanel.current.panel.reveal();
			GraphPanel.current.update();
			return;
		}
		GraphPanel.current = new GraphPanel(context, index, collection, title);
	}

	private readonly panel: vscode.WebviewPanel;
	private readonly disposables: vscode.Disposable[] = [];

	private constructor(context: vscode.ExtensionContext, private readonly index: NoteIndex, private collection: string, title: string) {
		const media = vscode.Uri.joinPath(context.extensionUri, 'media');
		this.panel = vscode.window.createWebviewPanel('nighthawk.notes.graph', title, vscode.ViewColumn.Beside, {
			enableScripts: true,
			localResourceRoots: [media],
			retainContextWhenHidden: true,
		});
		this.panel.iconPath = new vscode.ThemeIcon('type-hierarchy');
		this.panel.webview.html = this.html(this.panel.webview, media);
		this.disposables.push(
			this.panel.onDidDispose(() => this.dispose()),
			this.panel.webview.onDidReceiveMessage(message => {
				if (message?.type === 'open' && typeof message.uri === 'string') {
					vscode.window.showTextDocument(vscode.Uri.parse(message.uri), { viewColumn: vscode.ViewColumn.One });
				} else if (message?.type === 'ready') {
					this.update();
				}
			}),
			index.onDidChange(() => this.update()),
			vscode.window.onDidChangeActiveTextEditor(() => this.update()),
		);
	}

	dispose(): void {
		GraphPanel.current = undefined;
		this.disposables.forEach(d => d.dispose());
		this.panel.dispose();
	}

	private update(): void {
		const notes = this.index.all(this.collection);
		const ids = new Map(notes.map((note, i) => [note.uri.toString(), i]));
		const edges: [number, number][] = [];
		for (const note of notes) {
			const from = ids.get(note.uri.toString())!;
			for (const link of note.parsed.links) {
				const target = link.target && this.index.resolve(note, link.target);
				const to = target ? ids.get(target.uri.toString()) : undefined;
				if (to !== undefined && to !== from) {
					edges.push([from, to]);
				}
			}
		}
		const active = vscode.window.activeTextEditor?.document.uri.toString();
		this.panel.webview.postMessage({
			type: 'graph',
			nodes: notes.map(note => ({ uri: note.uri.toString(), name: note.name, tags: note.parsed.tags.length, active: note.uri.toString() === active })),
			edges,
		});
	}

	private html(webview: vscode.Webview, media: vscode.Uri): string {
		const nonce = [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, '0')).join('');
		const script = webview.asWebviewUri(vscode.Uri.joinPath(media, 'graph.js'));
		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<style>
		html, body { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; background: var(--vscode-editor-background); }
		canvas { display: block; width: 100%; height: 100%; cursor: grab; }
		canvas.dragging { cursor: grabbing; }
		#empty { position: absolute; inset: 0; display: none; align-items: center; justify-content: center; color: var(--vscode-descriptionForeground); font-family: var(--vscode-font-family); }
	</style>
</head>
<body>
	<canvas id="graph"></canvas>
	<div id="empty">${vscode.l10n.t('No notes yet. Link notes with [[Note name]] to see them here.')}</div>
	<script type="module" nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
	}
}
