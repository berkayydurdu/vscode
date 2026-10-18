/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { NoteIndex, type IndexedNote } from '../noteIndex';
import { Vault } from '../vault';

/** The vault's folders and notes, like a file explorer for notes only. */
export class VaultTreeProvider implements vscode.TreeDataProvider<vscode.Uri>, vscode.Disposable {

	private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;
	private readonly subscription: vscode.Disposable;

	constructor(private readonly vault: Vault) {
		this.subscription = vault.onDidChange(() => this.refresh());
	}

	dispose(): void {
		this.subscription.dispose();
		this.onDidChangeTreeDataEmitter.dispose();
	}

	refresh(): void {
		this.onDidChangeTreeDataEmitter.fire();
	}

	async getChildren(element?: vscode.Uri): Promise<vscode.Uri[]> {
		const folder = element ?? this.vault.root;
		try {
			const entries = await this.vault.readDirectory(folder);
			return entries
				.sort(([a, aType], [b, bType]) => (bType & vscode.FileType.Directory) - (aType & vscode.FileType.Directory) || a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }))
				.map(([name, type]) => {
					const uri = vscode.Uri.joinPath(folder, name);
					this.types.set(uri.toString(), type);
					return uri;
				});
		} catch {
			return [];
		}
	}

	private readonly types = new Map<string, vscode.FileType>();

	getTreeItem(uri: vscode.Uri): vscode.TreeItem {
		const isFolder = !!((this.types.get(uri.toString()) ?? 0) & vscode.FileType.Directory);
		const item = new vscode.TreeItem(uri, isFolder ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
		if (isFolder) {
			item.contextValue = 'notesFolder';
		} else {
			item.label = uri.path.split('/').pop()!.replace(/\.md$/i, '');
			item.contextValue = 'note';
			item.command = { command: 'vscode.open', title: vscode.l10n.t('Open Note'), arguments: [uri] };
		}
		return item;
	}

	getParent(uri: vscode.Uri): vscode.Uri | undefined {
		const parent = vscode.Uri.joinPath(uri, '..');
		return parent.toString() === this.vault.root.toString() ? undefined : parent;
	}
}

type BacklinkNode =
	| { kind: 'note'; note: IndexedNote; lines: { line: number; text: string }[] }
	| { kind: 'line'; note: IndexedNote; line: number; text: string };

/** Notes that link to the note in the active editor. */
export class BacklinksProvider implements vscode.TreeDataProvider<BacklinkNode>, vscode.Disposable {

	private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;
	private readonly disposables: vscode.Disposable[] = [];
	private current: vscode.Uri | undefined;
	view: vscode.TreeView<BacklinkNode> | undefined;

	constructor(private readonly index: NoteIndex) {
		this.disposables.push(
			vscode.window.onDidChangeActiveTextEditor(editor => {
				// Keep showing the last note while focus is in another view.
				if (editor && editor.document.uri.toString() !== this.current?.toString() && index.get(editor.document.uri)) {
					this.current = editor.document.uri;
					this.onDidChangeTreeDataEmitter.fire();
				}
			}),
			index.onDidChange(() => this.onDidChangeTreeDataEmitter.fire()),
		);
		this.current = vscode.window.activeTextEditor?.document.uri;
	}

	dispose(): void {
		this.disposables.forEach(d => d.dispose());
		this.onDidChangeTreeDataEmitter.dispose();
	}

	getChildren(element?: BacklinkNode): BacklinkNode[] {
		if (element?.kind === 'note') {
			return element.lines.map(l => ({ kind: 'line', note: element.note, line: l.line, text: l.text }));
		}
		if (element) {
			return [];
		}
		const note = this.current && this.index.get(this.current);
		if (this.view) {
			this.view.description = note?.name;
		}
		if (!note) {
			return [];
		}
		const grouped = new Map<IndexedNote, { line: number; text: string }[]>();
		for (const backlink of this.index.backlinks(note)) {
			const lines = grouped.get(backlink.note) ?? [];
			if (!lines.some(l => l.line === backlink.link.line)) {
				lines.push({ line: backlink.link.line, text: backlink.lineText.trim() });
			}
			grouped.set(backlink.note, lines);
		}
		return [...grouped].sort(([a], [b]) => a.path.localeCompare(b.path)).map(([n, lines]) => ({ kind: 'note', note: n, lines }));
	}

	getTreeItem(element: BacklinkNode): vscode.TreeItem {
		if (element.kind === 'note') {
			const item = new vscode.TreeItem(element.note.name, vscode.TreeItemCollapsibleState.Expanded);
			item.resourceUri = element.note.uri;
			item.description = element.note.path;
			item.iconPath = vscode.ThemeIcon.File;
			item.command = { command: 'vscode.open', title: vscode.l10n.t('Open Note'), arguments: [element.note.uri] };
			return item;
		}
		const item = new vscode.TreeItem(element.text || ' ', vscode.TreeItemCollapsibleState.None);
		item.tooltip = element.text;
		item.command = {
			command: 'vscode.open',
			title: vscode.l10n.t('Open Note'),
			arguments: [element.note.uri, { selection: new vscode.Range(element.line, 0, element.line, 0) } satisfies vscode.TextDocumentShowOptions],
		};
		return item;
	}
}

type TagNode = { kind: 'tag'; tag: string; notes: IndexedNote[] } | { kind: 'note'; note: IndexedNote };

/** All `#tags` across notes, with the notes that use them. */
export class TagsProvider implements vscode.TreeDataProvider<TagNode>, vscode.Disposable {

	private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;
	private readonly subscription: vscode.Disposable;

	constructor(private readonly index: NoteIndex, private readonly describe: (note: IndexedNote) => string) {
		this.subscription = index.onDidChange(() => this.onDidChangeTreeDataEmitter.fire());
	}

	dispose(): void {
		this.subscription.dispose();
		this.onDidChangeTreeDataEmitter.dispose();
	}

	getChildren(element?: TagNode): TagNode[] {
		if (!element) {
			return [...this.index.tags()]
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([tag, notes]) => ({ kind: 'tag', tag, notes }));
		}
		return element.kind === 'tag'
			? element.notes.sort((a, b) => a.name.localeCompare(b.name)).map(note => ({ kind: 'note', note }))
			: [];
	}

	getTreeItem(element: TagNode): vscode.TreeItem {
		if (element.kind === 'tag') {
			const item = new vscode.TreeItem('#' + element.tag, vscode.TreeItemCollapsibleState.Collapsed);
			item.description = String(element.notes.length);
			item.iconPath = new vscode.ThemeIcon('tag');
			return item;
		}
		const item = new vscode.TreeItem(element.note.name, vscode.TreeItemCollapsibleState.None);
		item.resourceUri = element.note.uri;
		item.iconPath = vscode.ThemeIcon.File;
		item.description = this.describe(element.note);
		item.command = { command: 'vscode.open', title: vscode.l10n.t('Open Note'), arguments: [element.note.uri] };
		return item;
	}
}
