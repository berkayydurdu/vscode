/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { findProgram, formatDuration, runPlan, SCRATCH_LANGUAGES, scratchName, type ScratchLanguage } from '../core/scratch';
import { killTree } from '../core/shell';

const FILES_CONTEXT = 'nighthawk.scratchFiles';
const LAST_LANGUAGE_KEY = 'nighthawk.scratch.lastLanguage';

export interface ScratchItem {
	uri: vscode.Uri;
	name: string;
	mtime: number;
}

/**
 * Scratch files: kept in one folder for every workspace, listed in the
 * Explorer's Scratches view, and run with the play button in the editor
 * title, which streams the output to a terminal.
 */
export class Scratches implements vscode.Disposable, vscode.TreeDataProvider<ScratchItem> {
	readonly dir: vscode.Uri;
	private readonly changed = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this.changed.event;
	private readonly disposables: vscode.Disposable[] = [this.changed];
	private run: ScratchRun | undefined;

	constructor(private readonly context: vscode.ExtensionContext) {
		// A file URI, as the storage URI can have the editor's own scheme, which programs cannot run from.
		this.dir = vscode.Uri.file(path.join(context.globalStorageUri.fsPath, 'scratches'));
		const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(this.dir, '*'));
		this.disposables.push(watcher, watcher.onDidCreate(() => this.refresh()), watcher.onDidDelete(() => this.refresh()), watcher.onDidChange(() => this.refresh()));
		this.disposables.push(vscode.window.registerTreeDataProvider('nighthawk.scratches', this));
		this.refresh();
	}

	dispose(): void {
		this.run?.dispose();
		for (const d of this.disposables) {
			d.dispose();
		}
	}

	private async list(): Promise<ScratchItem[]> {
		const names = await readdir(this.dir.fsPath).catch(() => [] as string[]);
		const items = await Promise.all(names.filter(n => !n.startsWith('.')).map(async name => {
			const uri = vscode.Uri.joinPath(this.dir, name);
			const info = await stat(uri.fsPath).catch(() => undefined);
			return info?.isFile() ? { uri, name, mtime: info.mtimeMs } : undefined;
		}));
		return items.filter((i): i is ScratchItem => !!i).sort((a, b) => b.mtime - a.mtime);
	}

	private async refresh(): Promise<void> {
		const items = await this.list();
		// Lets the editor title show the run button on scratch files only.
		await vscode.commands.executeCommand('setContext', FILES_CONTEXT, items.map(i => i.uri.fsPath));
		this.changed.fire();
	}

	getChildren(element?: ScratchItem): Promise<ScratchItem[]> | ScratchItem[] {
		return element ? [] : this.list();
	}

	getTreeItem(item: ScratchItem): vscode.TreeItem {
		const tree = new vscode.TreeItem(item.uri, vscode.TreeItemCollapsibleState.None);
		tree.label = item.name;
		tree.description = new Date(item.mtime).toLocaleDateString();
		tree.tooltip = item.uri.fsPath;
		tree.contextValue = 'scratch';
		tree.command = { command: 'vscode.open', title: vscode.l10n.t('Open'), arguments: [item.uri] };
		return tree;
	}

	/** Asks for a language and opens a new scratch file in it. */
	async create(): Promise<void> {
		const last = this.context.globalState.get<string>(LAST_LANGUAGE_KEY);
		type Item = vscode.QuickPickItem & { language: ScratchLanguage };
		const items: Item[] = SCRATCH_LANGUAGES.map(language => ({ label: language.label, description: `.${language.ext}`, language }));
		items.sort((a, b) => Number(b.language.id === last) - Number(a.language.id === last));
		const pick = await vscode.window.showQuickPick(items, { title: vscode.l10n.t('New Scratch File'), placeHolder: vscode.l10n.t('Language of the scratch file; it lives outside the project and every workspace sees it'), matchOnDescription: true });
		if (pick) {
			await this.context.globalState.update(LAST_LANGUAGE_KEY, pick.language.id);
			await this.write(pick.language.ext, pick.language.template ?? '');
		}
	}

	/** Copies the selection, or the whole file, into a new scratch file of the same language. */
	async createFromSelection(): Promise<void> {
		const editor = vscode.window.activeTextEditor;
		if (!editor) {
			return this.create();
		}
		const text = editor.document.getText(editor.selection.isEmpty ? undefined : editor.selection);
		const ext = path.extname(editor.document.fileName).slice(1) || SCRATCH_LANGUAGES.find(l => l.id === editor.document.languageId)?.ext || 'txt';
		await this.write(ext, text);
	}

	private async write(ext: string, text: string): Promise<void> {
		await mkdir(this.dir.fsPath, { recursive: true });
		const taken = new Set((await readdir(this.dir.fsPath).catch(() => [] as string[])).map(n => n.toLowerCase()));
		const uri = vscode.Uri.joinPath(this.dir, scratchName(ext, taken));
		await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(text));
		const editor = await vscode.window.showTextDocument(uri);
		const end = editor.document.lineAt(Math.max(0, editor.document.lineCount - 1)).range.end;
		editor.selection = new vscode.Selection(end, end);
		await this.refresh();
	}

	async rename(item?: ScratchItem): Promise<void> {
		if (!item) {
			return;
		}
		const ext = path.extname(item.name);
		const value = await vscode.window.showInputBox({
			title: vscode.l10n.t('Rename Scratch File'),
			value: item.name,
			valueSelection: [0, item.name.length - ext.length],
			validateInput: text => !text.trim() || /[\\/:*?"<>|]/.test(text) ? vscode.l10n.t('Enter a file name without slashes or special characters.') : undefined,
		});
		if (value && value !== item.name) {
			await vscode.workspace.fs.rename(item.uri, vscode.Uri.joinPath(this.dir, value.trim()), { overwrite: false });
			await this.refresh();
		}
	}

	async delete(item?: ScratchItem): Promise<void> {
		if (!item) {
			return;
		}
		const remove = vscode.l10n.t('Delete');
		if (await vscode.window.showWarningMessage(vscode.l10n.t('Delete the scratch file "{0}"?', item.name), { modal: true }, remove) === remove) {
			await vscode.workspace.fs.delete(item.uri, { useTrash: true });
			await this.refresh();
		}
	}

	async revealFolder(): Promise<void> {
		await mkdir(this.dir.fsPath, { recursive: true });
		await vscode.commands.executeCommand('revealFileInOS', this.dir);
	}

	/** Saves and runs a file (a scratch file, or any file the editor shows) with its language's usual command. */
	async runFile(target?: vscode.Uri | ScratchItem): Promise<void> {
		const uri = target instanceof vscode.Uri ? target : target?.uri ?? vscode.window.activeTextEditor?.document.uri;
		if (!uri || uri.scheme !== 'file') {
			vscode.window.showInformationMessage(vscode.l10n.t('Open a file on disk to run it.'));
			return;
		}
		const document = await vscode.workspace.openTextDocument(uri);
		if (document.isDirty) {
			await document.save();
		}
		const file = uri.fsPath;
		const configured = vscode.workspace.getConfiguration('nighthawk.scratch').get<Record<string, string>>('runners') ?? {};
		const out = path.join(tmpdir(), `nighthawk-scratch-${path.basename(file, path.extname(file))}${process.platform === 'win32' ? '.exe' : ''}`);
		const plan = runPlan(file, document.lineAt(0).text, { platform: process.platform, configured, out });
		const setRunner = vscode.l10n.t('Set Runner');
		if (!plan?.steps.length) {
			if (await vscode.window.showWarningMessage(vscode.l10n.t('Nighthawk does not know how to run {0} files. Add a runner for them in the settings.', path.extname(file) || path.basename(file)), setRunner) === setRunner) {
				await vscode.commands.executeCommand('workbench.action.openSettingsJson', { revealSetting: { key: 'nighthawk.scratch.runners', edit: true } });
			}
			return;
		}
		const programs = await Promise.all(plan.steps.map(async step => step[0] === out ? out : findProgram(step[0])));
		const missing = plan.steps.find((_step, index) => !programs[index]);
		if (missing) {
			if (await vscode.window.showWarningMessage(vscode.l10n.t('Running this file needs "{0}", which is not on PATH. Install it, or set another runner in the settings.', missing[0]), setRunner) === setRunner) {
				await vscode.commands.executeCommand('workbench.action.openSettingsJson', { revealSetting: { key: 'nighthawk.scratch.runners', edit: true } });
			}
			return;
		}
		this.run?.dispose();
		const cwd = vscode.workspace.workspaceFolders?.find(f => f.uri.scheme === 'file')?.uri.fsPath ?? path.dirname(file);
		this.run = new ScratchRun(path.basename(file), plan.steps.map((step, index) => [programs[index]!, ...step.slice(1)]), plan.steps.map(step => step.map(word => word === file || word === out ? path.basename(word) : word).join(' ')), cwd);
	}
}

/** One run in its own terminal: the commands' output as it comes, typed input passed on, Ctrl+C stops it. */
class ScratchRun implements vscode.Disposable {
	private readonly write = new vscode.EventEmitter<string>();
	private child: ChildProcess | undefined;
	private stopped = false;
	private line = '';
	private readonly terminal: vscode.Terminal;

	constructor(name: string, private readonly steps: string[][], private readonly shown: string[], private readonly cwd: string) {
		this.terminal = vscode.window.createTerminal({
			name: vscode.l10n.t('Run {0}', name),
			iconPath: new vscode.ThemeIcon('play'),
			pty: {
				onDidWrite: this.write.event,
				open: () => this.start(),
				close: () => this.stop(),
				handleInput: (data: string) => this.input(data),
			},
		});
		this.terminal.show(true);
	}

	dispose(): void {
		this.stop();
		this.terminal.dispose();
		this.write.dispose();
	}

	private print(text: string): void {
		this.write.fire(text.replace(/\r?\n/g, '\r\n'));
	}

	private async start(): Promise<void> {
		const started = Date.now();
		let code: number | null = 0;
		for (const [index, step] of this.steps.entries()) {
			if (this.stopped) {
				return;
			}
			this.print(`\x1b[2m$ ${this.shown[index]}\x1b[0m\n`);
			code = await this.spawn(step);
			if (code !== 0) {
				break;
			}
		}
		if (!this.stopped) {
			const color = code === 0 ? '32' : '31';
			this.print(`\n\x1b[${color}m${vscode.l10n.t('Process finished with exit code {0} in {1}', code ?? 'signal', formatDuration(Date.now() - started))}\x1b[0m\n`);
		}
		this.child = undefined;
	}

	private spawn([program, ...args]: string[]): Promise<number | null> {
		return new Promise(resolve => {
			const child = this.child = spawn(program, args, {
				cwd: this.cwd,
				env: { ...process.env, FORCE_COLOR: '1', PYTHONUNBUFFERED: '1' },
				windowsHide: true,
				// Windows runs .cmd and .bat programs (such as npx) only through the shell.
				shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(program),
			});
			child.stdout?.on('data', (data: Buffer) => this.print(data.toString()));
			child.stderr?.on('data', (data: Buffer) => this.print(`\x1b[31m${data.toString()}\x1b[0m`));
			child.on('error', err => {
				this.print(`\x1b[31m${err.message}\x1b[0m\n`);
				resolve(-1);
			});
			child.on('close', code => resolve(code));
		});
	}

	/** Typed input, a line at a time with Backspace working, as the program's input is not a terminal. */
	private input(data: string): void {
		if (data === '\x03') {
			this.print('^C\n');
			if (this.child) {
				killTree(this.child);
			}
			return;
		}
		const stdin = this.child?.stdin;
		if (!stdin?.writable) {
			return;
		}
		for (const char of data) {
			if (char === '\r') {
				this.print('\n');
				stdin.write(`${this.line}\n`);
				this.line = '';
			} else if (char === '\x7f' || char === '\b') {
				if (this.line) {
					this.line = this.line.slice(0, -1);
					this.write.fire('\b \b');
				}
			} else if (char === '\x04') {
				// Ctrl+D ends the input.
				stdin.end(this.line);
				this.line = '';
			} else if (char >= ' ') {
				this.line += char;
				this.write.fire(char);
			}
		}
	}

	private stop(): void {
		this.stopped = true;
		if (this.child) {
			killTree(this.child);
			this.child = undefined;
		}
	}
}
