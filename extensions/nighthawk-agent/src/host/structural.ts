/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFile } from 'node:child_process';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { findMatches, parsePattern, replacementFor, type Pattern } from '../core/structural';
import type { Multibuffers } from './multibuffer';
import { findRipgrep } from './project';

const MAX_FILE = 1024 * 1024;
const MAX_MATCHES = 2000;

interface FileMatches {
	document: vscode.TextDocument;
	matches: ReturnType<typeof findMatches>;
}

/**
 * Structural search and replace: find code by its shape with `$HOLES`, see
 * every match in a multibuffer, or replace them all through the refactor
 * preview, where each change can be unticked before it is applied.
 */
export class StructuralSearch {
	private lastPattern = '';
	private lastReplacement = '';

	constructor(private readonly multibuffers: Multibuffers) { }

	async run(): Promise<void> {
		const source = await vscode.window.showInputBox({
			title: vscode.l10n.t('Structural Search and Replace (1/2)'),
			prompt: vscode.l10n.t('Code to find, with $NAME for one expression and $$$NAME for any number. Spacing and comments do not matter. Example: console.log($$$ARGS)'),
			value: this.lastPattern || this.selection(),
			ignoreFocusOut: true,
			validateInput: value => {
				if (!value.trim()) {
					return undefined;
				}
				try {
					parsePattern(value);
					return undefined;
				} catch (err) {
					return (err as Error).message;
				}
			},
		});
		if (!source?.trim()) {
			return;
		}
		this.lastPattern = source;
		const replacement = await vscode.window.showInputBox({
			title: vscode.l10n.t('Structural Search and Replace (2/2)'),
			prompt: vscode.l10n.t('Replace with, using the same $NAMES. Leave empty to only find the matches.'),
			value: this.lastReplacement,
			placeHolder: vscode.l10n.t('For example: logger.debug($$$ARGS)'),
			ignoreFocusOut: true,
		});
		if (replacement === undefined) {
			return;
		}
		this.lastReplacement = replacement;
		const pattern = parsePattern(source);
		const found = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Searching for {0}', source), cancellable: true }, (_progress, token) => this.search(pattern, token));
		const total = found.reduce((sum, f) => sum + f.matches.length, 0);
		if (!total) {
			vscode.window.showInformationMessage(vscode.l10n.t('No code matches {0}.', source));
			return;
		}
		if (!replacement) {
			const locations = found.flatMap(({ document, matches }) => matches.map(m => ({ file: document.uri.fsPath, start: document.positionAt(m.start).line, end: document.positionAt(m.end).line })));
			await this.multibuffers.open(vscode.l10n.t('Structural: {0}', source), locations, 1);
			return;
		}
		const all = vscode.l10n.t('Replace All');
		const review = vscode.l10n.t('Review Each');
		const choice = await vscode.window.showInformationMessage(vscode.l10n.t('Replace {0} matches in {1} files?', total, found.length), { modal: true, detail: vscode.l10n.t('Replace All can be undone with Undo. Review Each opens the refactor preview, where you tick the changes to make.') }, all, review);
		if (!choice) {
			return;
		}
		const edit = new vscode.WorkspaceEdit();
		for (const { document, matches } of found) {
			// Changes that need confirmation open the refactor preview instead of applying at once.
			const metadata: vscode.WorkspaceEditEntryMetadata = { needsConfirmation: choice === review, label: vscode.l10n.t('Replace {0}', source), description: vscode.workspace.asRelativePath(document.uri) };
			for (const match of matches) {
				edit.replace(document.uri, new vscode.Range(document.positionAt(match.start), document.positionAt(match.end)), replacementFor(replacement, match), metadata);
			}
		}
		const applied = await vscode.workspace.applyEdit(edit, { isRefactoring: true });
		if (applied) {
			vscode.window.setStatusBarMessage(vscode.l10n.t('Replaced {0} matches in {1} files.', total, found.length), 5000);
		}
	}

	private selection(): string {
		const editor = vscode.window.activeTextEditor;
		return editor && !editor.selection.isEmpty ? editor.document.getText(editor.selection) : '';
	}

	private async search(pattern: Pattern, token: vscode.CancellationToken): Promise<FileMatches[]> {
		const files = await this.candidates(pattern);
		const results: FileMatches[] = [];
		let total = 0;
		for (const file of files) {
			if (token.isCancellationRequested || total >= MAX_MATCHES) {
				break;
			}
			const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file)).then(d => d, () => undefined);
			if (!document || document.getText().length > MAX_FILE) {
				continue;
			}
			const matches = findMatches(pattern, document.getText(), file, MAX_MATCHES - total);
			if (matches.length) {
				results.push({ document, matches });
				total += matches.length;
			}
		}
		return results;
	}

	/** Files that contain the pattern's longest word, honoring .gitignore, from ripgrep. */
	private async candidates(pattern: Pattern): Promise<string[]> {
		const roots = vscode.workspace.workspaceFolders?.filter(f => f.uri.scheme === 'file').map(f => f.uri.fsPath) ?? [];
		const rg = await findRipgrep();
		if (!rg || !roots.length) {
			throw new Error(vscode.l10n.t('Searching needs a folder open and ripgrep, which comes with Nighthawk.'));
		}
		const anchor = pattern.anchor.replace(/^['"`]|['"`]$/g, '');
		const args = ['--hidden', '--glob', '!.git', '--max-filesize', '1M', ...(anchor ? ['-l', '--fixed-strings', '-e', anchor] : ['--files']), '.'];
		const files: string[] = [];
		for (const root of roots) {
			const out = await new Promise<string>(resolve => execFile(rg, args, { cwd: root, maxBuffer: 20 * 1024 * 1024, windowsHide: true }, (_err, stdout) => resolve(stdout ?? '')));
			files.push(...out.split(/\r?\n/).filter(Boolean).map(f => path.join(root, f)));
		}
		return files;
	}
}
