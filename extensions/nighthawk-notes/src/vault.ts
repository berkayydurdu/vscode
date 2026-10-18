/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { expandTemplate, formatDate, sanitizeFileName } from './core/notes';
import { NoteIndex } from './noteIndex';

export const VAULT_COLLECTION = 'vault';

const decoder = new TextDecoder();
const encoder = new TextEncoder();

export function config() {
	return vscode.workspace.getConfiguration('nighthawk.notes');
}

/** Folders and files the vault ignores, like Obsidian's own settings folder. */
function isIgnored(name: string): boolean {
	return name.startsWith('.') || name === 'node_modules';
}

/**
 * The local vault: a plain folder of Markdown files, so notes stay readable
 * and editable with any tool, and can be synced with git or a cloud drive.
 */
export class Vault implements vscode.Disposable {

	private disposables: vscode.Disposable[] = [];
	private watcher: vscode.FileSystemWatcher | undefined;
	private _root: vscode.Uri;
	private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
	/** Fires when files are added, removed or the vault moves. */
	readonly onDidChange = this.onDidChangeEmitter.event;

	constructor(private readonly index: NoteIndex) {
		this._root = Vault.configuredRoot();
		this.disposables.push(
			vscode.workspace.onDidChangeConfiguration(e => {
				if (e.affectsConfiguration('nighthawk.notes.vaultPath')) {
					this._root = Vault.configuredRoot();
					this.start();
				}
			}),
			// Keep the index current while typing, not only on save.
			vscode.workspace.onDidChangeTextDocument(e => {
				if (this.contains(e.document.uri)) {
					this.index.set(VAULT_COLLECTION, e.document.uri, this.relativePath(e.document.uri), e.document.getText());
				}
			}),
		);
	}

	static configuredRoot(): vscode.Uri {
		const configured = config().get<string>('vaultPath', '').trim();
		if (!configured) {
			return vscode.Uri.file(path.join(os.homedir(), 'Nighthawk Notes'));
		}
		return vscode.Uri.file(path.resolve(configured.replace(/^~(?=$|[\\/])/, os.homedir())));
	}

	get root(): vscode.Uri {
		return this._root;
	}

	dispose(): void {
		this.watcher?.dispose();
		this.disposables.forEach(d => d.dispose());
		this.onDidChangeEmitter.dispose();
	}

	async start(): Promise<void> {
		this.watcher?.dispose();
		this.watcher = undefined;
		this.index.clearCollection(VAULT_COLLECTION);
		// Do not create the vault folder until the first note is written, so
		// opening a Markdown file does not leave a folder in the home folder.
		if (!await exists(this._root)) {
			this.onDidChangeEmitter.fire();
			return;
		}

		this.watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(this._root, '**/*'));
		this.watcher.onDidCreate(uri => this.onFileChanged(uri, true));
		this.watcher.onDidChange(uri => this.onFileChanged(uri, false));
		this.watcher.onDidDelete(uri => {
			// A deleted folder only reports itself, so drop everything under it.
			const prefix = uri.toString() + '/';
			for (const note of this.index.all(VAULT_COLLECTION)) {
				if (note.uri.toString() === uri.toString() || note.uri.toString().startsWith(prefix)) {
					this.index.delete(note.uri);
				}
			}
			this.onDidChangeEmitter.fire();
		});

		await this.scan(this._root);
		this.onDidChangeEmitter.fire();
	}

	private async onFileChanged(uri: vscode.Uri, created: boolean): Promise<void> {
		if (!this.contains(uri)) {
			return;
		}
		if (uri.path.toLowerCase().endsWith('.md')) {
			await this.indexFile(uri);
		} else if (created) {
			// Could be a folder moved into the vault.
			try {
				if ((await vscode.workspace.fs.stat(uri)).type & vscode.FileType.Directory) {
					await this.scan(uri);
				}
			} catch {
				// gone again
			}
		}
		if (created) {
			this.onDidChangeEmitter.fire();
		}
	}

	private async scan(folder: vscode.Uri): Promise<void> {
		let entries: [string, vscode.FileType][];
		try {
			entries = await vscode.workspace.fs.readDirectory(folder);
		} catch {
			return;
		}
		await Promise.all(entries.map(async ([name, type]) => {
			if (isIgnored(name)) {
				return;
			}
			const child = vscode.Uri.joinPath(folder, name);
			if (type & vscode.FileType.Directory) {
				await this.scan(child);
			} else if (name.toLowerCase().endsWith('.md')) {
				await this.indexFile(child);
			}
		}));
	}

	private async indexFile(uri: vscode.Uri): Promise<void> {
		// Prefer an open editor's unsaved text over what is on disk.
		const open = vscode.workspace.textDocuments.find(doc => doc.uri.toString() === uri.toString());
		try {
			const text = open ? open.getText() : decoder.decode(await vscode.workspace.fs.readFile(uri));
			this.index.set(VAULT_COLLECTION, uri, this.relativePath(uri), text);
		} catch {
			this.index.delete(uri);
		}
	}

	contains(uri: vscode.Uri): boolean {
		if (uri.scheme !== this._root.scheme) {
			return false;
		}
		const rel = this.relativePath(uri);
		return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel) && !rel.split('/').some(isIgnored);
	}

	relativePath(uri: vscode.Uri): string {
		return path.relative(this._root.fsPath, uri.fsPath).split(path.sep).join('/');
	}

	async readDirectory(folder: vscode.Uri): Promise<[string, vscode.FileType][]> {
		const entries = await vscode.workspace.fs.readDirectory(folder);
		return entries.filter(([name, type]) => !isIgnored(name) && (type & vscode.FileType.Directory || name.toLowerCase().endsWith('.md')));
	}

	/**
	 * Creates a note in `folder` (the vault root by default), adding a number
	 * to the name when a note with that name already exists.
	 */
	/** Creates the vault folder if it does not exist yet. */
	async ensureRoot(): Promise<void> {
		if (!this.watcher) {
			await vscode.workspace.fs.createDirectory(this._root);
			await this.start();
		}
	}

	async createNote(title: string, content: string, folder: vscode.Uri = this._root): Promise<vscode.Uri> {
		await this.ensureRoot();
		const base = sanitizeFileName(title);
		let uri = vscode.Uri.joinPath(folder, `${base}.md`);
		for (let i = 1; await exists(uri); i++) {
			uri = vscode.Uri.joinPath(folder, `${base} ${i}.md`);
		}
		await vscode.workspace.fs.createDirectory(folder);
		await vscode.workspace.fs.writeFile(uri, encoder.encode(content));
		await this.indexFile(uri);
		this.onDidChangeEmitter.fire();
		return uri;
	}

	async dailyNote(date = new Date()): Promise<vscode.Uri> {
		const name = formatDate(date, config().get<string>('dailyNotes.format', 'YYYY-MM-DD'));
		const folder = vscode.Uri.joinPath(this._root, config().get<string>('dailyNotes.folder', 'Daily'));
		const uri = vscode.Uri.joinPath(folder, `${sanitizeFileName(name)}.md`);
		if (await exists(uri)) {
			return uri;
		}
		const templateName = config().get<string>('dailyNotes.template', '');
		const template = templateName ? await this.readTemplate(templateName) : undefined;
		return this.createNote(name, template !== undefined ? expandTemplate(template, name, date) : `# ${name}\n\n`, folder);
	}

	templatesFolder(): vscode.Uri {
		return vscode.Uri.joinPath(this._root, config().get<string>('templatesFolder', 'Templates'));
	}

	async templates(): Promise<string[]> {
		try {
			const entries = await vscode.workspace.fs.readDirectory(this.templatesFolder());
			return entries.filter(([name, type]) => type === vscode.FileType.File && name.toLowerCase().endsWith('.md')).map(([name]) => name.replace(/\.md$/i, ''));
		} catch {
			return [];
		}
	}

	async readTemplate(name: string): Promise<string | undefined> {
		try {
			const file = name.toLowerCase().endsWith('.md') ? name : `${name}.md`;
			return decoder.decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(this.templatesFolder(), file)));
		} catch {
			return undefined;
		}
	}
}

export async function exists(uri: vscode.Uri): Promise<boolean> {
	try {
		await vscode.workspace.fs.stat(uri);
		return true;
	} catch {
		return false;
	}
}
