/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path';
import * as vscode from 'vscode';
import { ToolError, type Tool } from '../core/tools';
import { displayPath, resolvePath, type FileStat, type Workspace } from '../core/workspace';

const decoder = new TextDecoder();
const encoder = new TextEncoder();

function openDocument(file: string): vscode.TextDocument | undefined {
	const target = vscode.Uri.file(file).toString();
	return vscode.workspace.textDocuments.find(d => d.uri.toString() === target);
}

/**
 * The agent's view of files through the editor: it reads unsaved changes,
 * and its edits to open files go through the editor so undo works.
 */
export class EditorWorkspace implements Workspace {
	constructor(readonly roots: string[]) { }

	async readText(file: string): Promise<string> {
		const doc = openDocument(file);
		if (doc) {
			return doc.getText();
		}
		return decoder.decode(await vscode.workspace.fs.readFile(vscode.Uri.file(file)));
	}

	async readBytes(file: string): Promise<Uint8Array> {
		return vscode.workspace.fs.readFile(vscode.Uri.file(file));
	}

	async writeText(file: string, text: string): Promise<void> {
		const uri = vscode.Uri.file(file);
		const doc = openDocument(file);
		if (doc) {
			const edit = new vscode.WorkspaceEdit();
			edit.replace(uri, new vscode.Range(0, 0, doc.lineCount, 0), text);
			if (!await vscode.workspace.applyEdit(edit)) {
				throw new ToolError(`The editor refused the change to ${file}.`);
			}
			await doc.save();
			return;
		}
		await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(file)));
		await vscode.workspace.fs.writeFile(uri, encoder.encode(text));
	}

	async delete(file: string): Promise<void> {
		await vscode.workspace.fs.delete(vscode.Uri.file(file), { useTrash: false });
	}

	async stat(file: string): Promise<FileStat | undefined> {
		try {
			const stat = await vscode.workspace.fs.stat(vscode.Uri.file(file));
			return { isDirectory: (stat.type & vscode.FileType.Directory) !== 0, size: stat.size, mtime: stat.mtime };
		} catch {
			return undefined;
		}
	}

	async readDir(dir: string): Promise<{ name: string; isDirectory: boolean }[]> {
		const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(dir));
		return entries.map(([name, type]) => ({ name, isDirectory: (type & vscode.FileType.Directory) !== 0 }));
	}
}

const SEVERITY = ['error', 'warning', 'info', 'hint'];

/** Errors and warnings from the editor's language services. */
export function diagnosticsTool(): Tool {
	return {
		kind: 'read',
		parallel: true,
		spec: {
			name: 'Diagnostics',
			description: 'Returns the errors and warnings the editor\'s language services report (type errors, lint problems), for one file or the whole workspace. Check it after editing code.',
			inputSchema: {
				type: 'object',
				properties: {
					file_path: { type: 'string', description: 'Only this file. Omit for every open problem.' },
					include_warnings: { type: 'boolean', description: 'Include warnings (default true).' },
				},
				additionalProperties: false,
			},
		},
		title: (input, ws) => typeof input.file_path === 'string' ? `Check ${displayPath(ws, resolvePath(ws, input.file_path))}` : 'Check problems',
		async run(input, ctx) {
			const warnings = input.include_warnings !== false;
			let entries: [vscode.Uri, readonly vscode.Diagnostic[]][];
			if (typeof input.file_path === 'string' && input.file_path) {
				const uri = vscode.Uri.file(resolvePath(ctx.workspace, input.file_path));
				// Opening the file lets its language service check it.
				await vscode.workspace.openTextDocument(uri).then(undefined, () => undefined);
				await new Promise(resolve => setTimeout(resolve, 500));
				entries = [[uri, vscode.languages.getDiagnostics(uri)]];
			} else {
				entries = vscode.languages.getDiagnostics();
			}
			const lines: string[] = [];
			for (const [uri, diagnostics] of entries) {
				for (const d of diagnostics) {
					if (d.severity === vscode.DiagnosticSeverity.Error || (warnings && d.severity === vscode.DiagnosticSeverity.Warning)) {
						const source = d.source ? ` (${d.source}${d.code !== undefined ? ` ${typeof d.code === 'object' ? d.code.value : d.code}` : ''})` : '';
						lines.push(`${uri.fsPath}:${d.range.start.line + 1}:${d.range.start.character + 1} ${SEVERITY[d.severity]}: ${d.message}${source}`);
					}
				}
			}
			if (!lines.length) {
				return { content: 'No problems found.', summary: 'no problems' };
			}
			const shown = lines.slice(0, 200);
			return { content: shown.join('\n') + (lines.length > shown.length ? `\n(${lines.length - shown.length} more)` : ''), summary: `${lines.length} problems` };
		},
	};
}
