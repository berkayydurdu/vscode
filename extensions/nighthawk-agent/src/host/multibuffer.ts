/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFile } from 'node:child_process';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { excerptsFor, isHeader, parse, planWrite, render, sourceLine, type Excerpt, type Location } from '../core/multibuffer';
import { findRipgrep } from './project';

const SCHEME = 'nighthawk-multibuffer';
const MAX_FILES = 200;
const MAX_MATCHES = 1000;
const MAX_BUFFERS = 20;

interface Buffer {
	title: string;
	excerpts: Excerpt[];
	/** How it was made, to read it again. */
	locations: Location[];
	context: number;
	/** When its content last changed, so the editor reads it again after a save or reload. */
	mtime: number;
}

/**
 * Multibuffers: excerpts from many files in one editable tab. Edits are
 * written back into each file on save, so multiple cursors, find and
 * replace and the agent's inline edit work across files at once.
 */
export class Multibuffers implements vscode.FileSystemProvider, vscode.CodeLensProvider, vscode.Disposable {
	private readonly buffers = new Map<string, Buffer>();
	private readonly changed = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
	readonly onDidChangeFile = this.changed.event;
	private readonly lensesChanged = new vscode.EventEmitter<void>();
	readonly onDidChangeCodeLenses = this.lensesChanged.event;
	private readonly disposables: vscode.Disposable[] = [];
	private readonly headerDecoration = vscode.window.createTextEditorDecorationType({
		isWholeLine: true,
		fontWeight: '600',
		color: new vscode.ThemeColor('descriptionForeground'),
		backgroundColor: new vscode.ThemeColor('editorWidget.background'),
		borderColor: new vscode.ThemeColor('editorWidget.border'),
		borderStyle: 'solid',
		borderWidth: '1px 0 0 0',
	});
	private nextId = 1;

	constructor() {
		this.disposables.push(
			this.changed, this.lensesChanged, this.headerDecoration,
			vscode.workspace.registerFileSystemProvider(SCHEME, this, { isCaseSensitive: true }),
			vscode.languages.registerCodeLensProvider({ scheme: SCHEME }, this),
			vscode.window.onDidChangeVisibleTextEditors(editors => editors.forEach(e => this.decorate(e))),
			vscode.workspace.onDidChangeTextDocument(e => {
				if (e.document.uri.scheme === SCHEME) {
					vscode.window.visibleTextEditors.filter(editor => editor.document === e.document).forEach(editor => this.decorate(editor));
				}
			}),
		);
	}

	dispose(): void {
		this.disposables.splice(0).forEach(d => d.dispose());
	}

	// --- Opening

	/** Shows the given places in a new multibuffer tab. */
	async open(title: string, locations: Location[], context = 2): Promise<void> {
		if (!locations.length) {
			vscode.window.showInformationMessage(vscode.l10n.t('Nothing to show.'));
			return;
		}
		const { excerpts, languages } = await this.read(locations, context);
		if (!excerpts.length) {
			vscode.window.showInformationMessage(vscode.l10n.t('Nothing to show.'));
			return;
		}
		const id = String(this.nextId++);
		this.buffers.set(id, { title, excerpts, locations, context, mtime: Date.now() });
		// Documents close and reopen when their language changes, so old buffers are dropped by count, not on close.
		for (const old of [...this.buffers.keys()].slice(0, -MAX_BUFFERS)) {
			this.buffers.delete(old);
		}
		const uri = vscode.Uri.from({ scheme: SCHEME, path: `/${id}/${title.replace(/[/\\]/g, ' ')}` });
		let document = await vscode.workspace.openTextDocument(uri);
		// One language for all files keeps their colors; mixed files show as plain text.
		if (languages.size === 1) {
			document = await vscode.languages.setTextDocumentLanguage(document, [...languages][0]);
		}
		const editor = await vscode.window.showTextDocument(document, { preview: false });
		editor.selection = new vscode.Selection(1, 0, 1, 0);
		this.decorate(editor);
	}

	private async read(locations: Location[], context: number): Promise<{ excerpts: Excerpt[]; languages: Set<string> }> {
		const files = [...new Set(locations.map(l => l.file))].slice(0, MAX_FILES);
		const documents = new Map<string, vscode.TextDocument>();
		await Promise.all(files.map(async file => {
			const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file)).then(d => d, () => undefined);
			if (document) {
				documents.set(file, document);
			}
		}));
		const excerpts = excerptsFor(
			locations.filter(l => documents.has(l.file)),
			file => documents.get(file)?.getText().split(/\r?\n/),
			file => vscode.workspace.asRelativePath(file, vscode.workspace.workspaceFolders !== undefined && vscode.workspace.workspaceFolders.length > 1),
			context,
		);
		return { excerpts, languages: new Set([...documents.values()].map(d => d.languageId)) };
	}

	/** Reads the files again, for when they changed outside the multibuffer. */
	async reload(uri = vscode.window.activeTextEditor?.document.uri): Promise<void> {
		const buffer = uri && this.buffer(uri);
		if (!uri || !buffer) {
			return;
		}
		buffer.excerpts = (await this.read(buffer.locations, buffer.context)).excerpts;
		buffer.mtime = Date.now();
		const document = vscode.workspace.textDocuments.find(d => d.uri.toString() === uri.toString());
		if (document?.isDirty) {
			await vscode.commands.executeCommand('workbench.action.files.revert');
		}
		this.changed.fire([{ type: vscode.FileChangeType.Changed, uri }]);
		this.lensesChanged.fire();
	}

	/** Searches the workspace and shows every match in a multibuffer. */
	async search(query?: string): Promise<void> {
		query ??= await vscode.window.showInputBox({
			title: vscode.l10n.t('Search into a Multibuffer'),
			prompt: vscode.l10n.t('Every match, with the lines around it, in one editable tab. Wrap in slashes for a regular expression, like /use\\w+/.'),
			value: this.selectedWord(),
		});
		if (!query) {
			return;
		}
		const locations = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: vscode.l10n.t('Searching') }, () => this.find(query));
		if (locations.length >= MAX_MATCHES) {
			vscode.window.showWarningMessage(vscode.l10n.t('Showing the first {0} matches.', MAX_MATCHES));
		}
		await this.open(vscode.l10n.t('Search: {0}', query), locations);
	}

	private selectedWord(): string | undefined {
		const editor = vscode.window.activeTextEditor;
		if (!editor) {
			return undefined;
		}
		const range = editor.selection.isEmpty ? editor.document.getWordRangeAtPosition(editor.selection.active) : editor.selection;
		const text = range && editor.document.getText(range);
		return text && !text.includes('\n') ? text : undefined;
	}

	private async find(query: string): Promise<Location[]> {
		const rg = await findRipgrep();
		const roots = vscode.workspace.workspaceFolders?.filter(f => f.uri.scheme === 'file').map(f => f.uri.fsPath) ?? [];
		if (!rg || !roots.length) {
			throw new Error(vscode.l10n.t('Searching needs a folder open and ripgrep, which comes with Nighthawk.'));
		}
		const regex = /^\/(.+)\/$/.exec(query);
		const args = ['--line-number', '--no-heading', '--color', 'never', '--null', '--max-count', '100', ...(regex ? ['--', regex[1]] : ['--fixed-strings', '--', query])];
		const locations: Location[] = [];
		for (const root of roots) {
			const out = await new Promise<string>(resolve => execFile(rg, [...args, '.'], { cwd: root, maxBuffer: 20 * 1024 * 1024, windowsHide: true }, (_err, stdout) => resolve(stdout ?? '')));
			for (const line of out.split('\n')) {
				const nul = line.indexOf('\0');
				const number = nul > 0 ? Number.parseInt(line.slice(nul + 1), 10) : NaN;
				if (Number.isFinite(number)) {
					locations.push({ file: path.join(root, line.slice(0, nul)), start: number - 1, end: number - 1 });
				}
				if (locations.length >= MAX_MATCHES) {
					return locations;
				}
			}
		}
		return locations;
	}

	/** Every reference to the symbol at the cursor, in one multibuffer. */
	async references(): Promise<void> {
		const editor = vscode.window.activeTextEditor;
		if (!editor) {
			return;
		}
		const position = editor.selection.active;
		const word = editor.document.getText(editor.document.getWordRangeAtPosition(position));
		const found = await vscode.commands.executeCommand<vscode.Location[]>('vscode.executeReferenceProvider', editor.document.uri, position) ?? [];
		const locations = found.filter(l => l.uri.scheme === 'file').map(l => ({ file: l.uri.fsPath, start: l.range.start.line, end: l.range.end.line }));
		if (!locations.length) {
			vscode.window.showInformationMessage(vscode.l10n.t('No references found for {0}.', word));
			return;
		}
		await this.open(vscode.l10n.t('References: {0}', word), locations);
	}

	/** Every error and warning in the workspace, in one multibuffer. */
	async problems(): Promise<void> {
		const locations: Location[] = [];
		for (const [uri, diagnostics] of vscode.languages.getDiagnostics()) {
			if (uri.scheme !== 'file') {
				continue;
			}
			for (const d of diagnostics) {
				if (d.severity <= vscode.DiagnosticSeverity.Warning) {
					locations.push({ file: uri.fsPath, start: d.range.start.line, end: d.range.end.line });
				}
			}
		}
		if (!locations.length) {
			vscode.window.showInformationMessage(vscode.l10n.t('No errors or warnings.'));
			return;
		}
		await this.open(vscode.l10n.t('Problems'), locations, 1);
	}

	/** Opens the file and line under the cursor of a multibuffer. */
	async openSource(uri?: vscode.Uri, line?: number): Promise<void> {
		const editor = vscode.window.activeTextEditor;
		uri ??= editor?.document.uri;
		const buffer = uri && this.buffer(uri);
		if (!buffer) {
			return;
		}
		const at = line ?? editor?.selection.active.line ?? 0;
		const source = sourceLine(buffer.excerpts, at);
		if (!source) {
			return;
		}
		const column = line === undefined && editor ? editor.selection.active.character : 0;
		const position = new vscode.Position(source.line, column);
		await vscode.window.showTextDocument(vscode.Uri.file(source.excerpt.file), { selection: new vscode.Range(position, position) });
	}

	// --- Display

	private buffer(uri: vscode.Uri): Buffer | undefined {
		return uri.scheme === SCHEME ? this.buffers.get(uri.path.split('/')[1]) : undefined;
	}

	private decorate(editor: vscode.TextEditor): void {
		if (editor.document.uri.scheme !== SCHEME) {
			return;
		}
		const ranges: vscode.Range[] = [];
		for (let line = 0; line < editor.document.lineCount; line++) {
			if (isHeader(editor.document.lineAt(line).text)) {
				ranges.push(new vscode.Range(line, 0, line, 0));
			}
		}
		editor.setDecorations(this.headerDecoration, ranges);
	}

	provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
		const lenses: vscode.CodeLens[] = [];
		for (let line = 0; line < document.lineCount; line++) {
			if (isHeader(document.lineAt(line).text)) {
				lenses.push(new vscode.CodeLens(new vscode.Range(line, 0, line, 0), { title: vscode.l10n.t('Open File'), command: 'nighthawk.multibuffer.openSource', arguments: [document.uri, line + 1] }));
			}
		}
		return lenses;
	}

	// --- File system

	watch(): vscode.Disposable {
		return new vscode.Disposable(() => undefined);
	}

	stat(uri: vscode.Uri): vscode.FileStat {
		const buffer = this.buffer(uri);
		if (!buffer) {
			throw vscode.FileSystemError.FileNotFound(uri);
		}
		return { type: vscode.FileType.File, ctime: 0, mtime: buffer.mtime, size: new TextEncoder().encode(render(buffer.excerpts).text).length };
	}

	readFile(uri: vscode.Uri): Uint8Array {
		const buffer = this.buffer(uri);
		if (!buffer) {
			throw vscode.FileSystemError.FileNotFound(uri);
		}
		return new TextEncoder().encode(render(buffer.excerpts).text);
	}

	/** Saving writes each changed excerpt into its file, or nothing when a file changed under an excerpt. */
	async writeFile(uri: vscode.Uri, content: Uint8Array): Promise<void> {
		const buffer = this.buffer(uri);
		if (!buffer) {
			throw vscode.FileSystemError.NoPermissions(uri);
		}
		let edited: string[][];
		try {
			edited = parse(new TextDecoder().decode(content), buffer.excerpts);
		} catch {
			throw vscode.FileSystemError.NoPermissions(vscode.l10n.t('The header lines were changed or removed. Undo that, or reopen the multibuffer.'));
		}
		const documents = new Map<string, vscode.TextDocument>();
		for (const file of new Set(buffer.excerpts.map(e => e.file))) {
			documents.set(file, await vscode.workspace.openTextDocument(vscode.Uri.file(file)));
		}
		const plan = planWrite(buffer.excerpts, edited, file => documents.get(file)?.getText().split(/\r?\n/));
		if (plan.conflicts.length) {
			throw vscode.FileSystemError.NoPermissions(vscode.l10n.t('{0} changed since the multibuffer read it. Run "Multibuffer: Reload" to read the files again; your edits there will be lost.', plan.conflicts.join(', ')));
		}
		const edit = new vscode.WorkspaceEdit();
		for (const change of plan.edits) {
			const document = documents.get(change.file)!;
			const eol = document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
			const end = change.start + change.count;
			// Whole lines, with their line breaks; the file's last line has none.
			const range = end < document.lineCount
				? new vscode.Range(change.start, 0, end, 0)
				: new vscode.Range(change.start, 0, document.lineCount - 1, document.lineAt(document.lineCount - 1).text.length);
			const text = change.lines.join(eol) + (end < document.lineCount && change.lines.length ? eol : '');
			if (change.start > 0 && end >= document.lineCount && !change.lines.length) {
				// Removing the last lines also removes the line break before them.
				edit.replace(document.uri, new vscode.Range(change.start - 1, document.lineAt(change.start - 1).text.length, range.end.line, range.end.character), '');
			} else {
				edit.replace(document.uri, range, text);
			}
		}
		if (plan.edits.length && !await vscode.workspace.applyEdit(edit)) {
			throw vscode.FileSystemError.Unavailable(vscode.l10n.t('The files could not be changed.'));
		}
		for (const file of new Set(plan.edits.map(e => e.file))) {
			await documents.get(file)!.save();
		}
		buffer.excerpts = plan.excerpts;
		// Read it again once the save is done, for the new line numbers and headers as they were.
		setTimeout(() => {
			buffer.mtime = Date.now();
			this.changed.fire([{ type: vscode.FileChangeType.Changed, uri }]);
		}, 200);
		this.lensesChanged.fire();
	}

	readDirectory(): [string, vscode.FileType][] {
		return [];
	}

	createDirectory(): void {
		throw vscode.FileSystemError.NoPermissions();
	}

	delete(uri: vscode.Uri): void {
		this.buffers.delete(uri.path.split('/')[1]);
	}

	rename(): void {
		throw vscode.FileSystemError.NoPermissions();
	}
}
