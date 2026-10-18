/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { BLOCKS, parseNote, type WikiLink } from './core/notes';
import { NoteIndex, type IndexedNote } from './noteIndex';
import { TEAM_SCHEME } from './teams/teamFileSystem';

export const NOTE_SELECTOR: vscode.DocumentSelector = [
	{ language: 'markdown', scheme: 'file' },
	{ language: 'markdown', scheme: TEAM_SCHEME },
];

export const FOLLOW_LINK_COMMAND = 'nighthawk.notes.followLink';

export function followLinkUri(from: vscode.Uri, target: string, heading: string | undefined): vscode.Uri {
	return vscode.Uri.parse(`command:${FOLLOW_LINK_COMMAND}?${encodeURIComponent(JSON.stringify([from.toString(), target, heading ?? null]))}`);
}

/**
 * Wiki link navigation, hovers and completions, plus Notion style `/` blocks,
 * for notes in the vault and in team spaces.
 */
export function registerLanguageFeatures(index: NoteIndex): vscode.Disposable {

	const noteFor = (document: vscode.TextDocument): IndexedNote | undefined => index.get(document.uri);

	const linkAt = (document: vscode.TextDocument, position: vscode.Position): WikiLink | undefined => {
		const offset = document.offsetAt(position);
		return parseNote(document.getText()).links.find(link => offset >= link.start && offset <= link.end);
	};

	const headingLine = (note: IndexedNote, heading: string | undefined): number => {
		if (!heading) {
			return 0;
		}
		const wanted = heading.toLowerCase();
		return note.parsed.headings.find(h => h.text.toLowerCase() === wanted)?.line ?? 0;
	};

	return vscode.Disposable.from(
		vscode.languages.registerDocumentLinkProvider(NOTE_SELECTOR, {
			provideDocumentLinks(document) {
				const note = noteFor(document);
				if (!note) {
					return [];
				}
				return parseNote(document.getText()).links.map(link => {
					const range = new vscode.Range(document.positionAt(link.start + (link.embed ? 3 : 2)), document.positionAt(link.end - 2));
					const target = index.resolve(note, link.target);
					const result = new vscode.DocumentLink(range, followLinkUri(document.uri, link.target, link.heading));
					result.tooltip = target
						? vscode.l10n.t('Open {0}', target.path)
						: vscode.l10n.t('Create note "{0}"', link.target);
					return result;
				});
			}
		}),

		vscode.languages.registerDefinitionProvider(NOTE_SELECTOR, {
			provideDefinition(document, position) {
				const note = noteFor(document);
				const link = note && linkAt(document, position);
				const target = link && index.resolve(note, link.target);
				if (!target) {
					return undefined;
				}
				return new vscode.Location(target.uri, new vscode.Position(headingLine(target, link.heading), 0));
			}
		}),

		vscode.languages.registerHoverProvider(NOTE_SELECTOR, {
			async provideHover(document, position) {
				const note = noteFor(document);
				const link = note && linkAt(document, position);
				if (!link) {
					return undefined;
				}
				const target = index.resolve(note, link.target);
				if (!target) {
					return new vscode.Hover(vscode.l10n.t('No note named "{0}" yet. Click the link to create it.', link.target));
				}
				const text = (await vscode.workspace.openTextDocument(target.uri)).getText();
				const lines = text.split('\n');
				const start = headingLine(target, link.heading);
				const preview = lines.slice(start, start + 20).join('\n') + (lines.length > start + 20 ? '\n\n…' : '');
				const markdown = new vscode.MarkdownString(`**${escapeMarkdown(target.path)}**\n\n---\n\n${preview}`);
				markdown.supportHtml = false;
				return new vscode.Hover(markdown, new vscode.Range(document.positionAt(link.start), document.positionAt(link.end)));
			}
		}),

		vscode.languages.registerCompletionItemProvider(NOTE_SELECTOR, {
			provideCompletionItems(document, position) {
				const note = noteFor(document);
				if (!note) {
					return undefined;
				}
				const prefix = document.lineAt(position.line).text.slice(0, position.character);
				const suffix = document.lineAt(position.line).text.slice(position.character);
				const closing = suffix.startsWith(']]') ? '' : ']]';

				// [[Heading links#...
				const headingMatch = /\[\[([^\[\]|#]*)#([^\[\]|]*)$/.exec(prefix);
				if (headingMatch) {
					const target = headingMatch[1] ? index.resolve(note, headingMatch[1]) : note;
					const range = new vscode.Range(position.translate(0, -headingMatch[2].length), position);
					return target?.parsed.headings.map(heading => {
						const item = new vscode.CompletionItem(heading.text, vscode.CompletionItemKind.Reference);
						item.detail = '#'.repeat(heading.level);
						item.range = range;
						item.insertText = heading.text + closing;
						return item;
					});
				}

				// [[Note links
				const linkMatch = /\[\[([^\[\]|#]*)$/.exec(prefix);
				if (linkMatch) {
					const range = new vscode.Range(position.translate(0, -linkMatch[1].length), position);
					const names = new Map<string, number>();
					const candidates = index.all(note.collection).filter(n => n.uri.toString() !== note.uri.toString());
					for (const candidate of candidates) {
						names.set(candidate.name.toLowerCase(), (names.get(candidate.name.toLowerCase()) ?? 0) + 1);
					}
					return candidates.map(candidate => {
						// Use the path only when the name alone would be ambiguous.
						const insert = (names.get(candidate.name.toLowerCase()) ?? 0) > 1 ? candidate.path.replace(/\.md$/i, '') : candidate.name;
						const item = new vscode.CompletionItem({ label: candidate.name, description: candidate.path }, vscode.CompletionItemKind.File);
						item.range = range;
						item.insertText = insert + closing;
						item.filterText = candidate.path + ' ' + candidate.aliases.join(' ');
						return item;
					});
				}

				// #tags
				const tagMatch = /(?:^|[\s(,;])#([\p{L}\p{N}_\-/]*)$/u.exec(prefix);
				if (tagMatch && !/^#+$/.test(prefix.trim())) {
					const range = new vscode.Range(position.translate(0, -tagMatch[1].length), position);
					return [...index.tags().keys()].map(tag => {
						const item = new vscode.CompletionItem(tag, vscode.CompletionItemKind.Keyword);
						item.range = range;
						return item;
					});
				}

				// /blocks at the start of a line
				const blockMatch = /^(\s*)\/(\w*)$/.exec(prefix);
				if (blockMatch) {
					const range = new vscode.Range(position.line, blockMatch[1].length, position.line, position.character);
					return BLOCKS.map((block, i) => {
						const item = new vscode.CompletionItem({ label: '/' + block.label, description: block.detail }, vscode.CompletionItemKind.Snippet);
						item.range = range;
						item.insertText = new vscode.SnippetString(block.snippet);
						item.filterText = '/' + block.label + ' ' + block.detail;
						item.sortText = String(i).padStart(3, '0');
						return item;
					});
				}
				return undefined;
			}
		}, '[', '#', '/'),
	);
}

function escapeMarkdown(text: string): string {
	return text.replace(/[\\`*_{}\[\]()#+\-.!|]/g, '\\$&');
}

/**
 * Opens the note a link points at, creating it when it does not exist yet.
 */
export async function followLink(index: NoteIndex, from: vscode.Uri, target: string, heading: string | undefined, createNote: (from: IndexedNote, name: string) => Promise<vscode.Uri | undefined>): Promise<void> {
	const fromNote = index.get(from);
	if (!fromNote) {
		return;
	}
	let note = index.resolve(fromNote, target);
	if (!note) {
		const created = await createNote(fromNote, target);
		if (!created) {
			return;
		}
		await vscode.window.showTextDocument(created);
		return;
	}
	const editor = await vscode.window.showTextDocument(note.uri);
	note = index.get(note.uri) ?? note;
	if (heading) {
		const line = note.parsed.headings.find(h => h.text.toLowerCase() === heading.toLowerCase())?.line;
		if (line !== undefined) {
			const position = new vscode.Position(line, 0);
			editor.selection = new vscode.Selection(position, position);
			editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.AtTop);
		}
	}
}

/**
 * Renames a note and rewrites every link to it in the same collection.
 */
export async function renameNote(index: NoteIndex, note: IndexedNote, newName: string): Promise<vscode.Uri> {
	const newUri = vscode.Uri.joinPath(note.uri, '..', `${newName}.md`);
	const linkers = index.backlinks(note).map(b => b.note).filter((n, i, all) => all.indexOf(n) === i);

	// Work out the edits before renaming, while links still resolve to the old note.
	const edit = new vscode.WorkspaceEdit();
	const touched: vscode.TextDocument[] = [];
	for (const linker of linkers) {
		const document = await vscode.workspace.openTextDocument(linker.uri);
		const links = parseNote(document.getText()).links.filter(link => index.resolve(linker, link.target)?.uri.toString() === note.uri.toString());
		if (!links.length) {
			continue;
		}
		const target = (link: WikiLink) => link.target.includes('/') ? note.path.replace(/[^/]*$/, newName) : newName;
		for (const link of links) {
			edit.replace(document.uri, new vscode.Range(document.positionAt(link.targetStart), document.positionAt(link.targetEnd)), target(link));
		}
		if (!document.isDirty) {
			touched.push(document);
		}
	}

	await vscode.workspace.fs.rename(note.uri, newUri);
	if (edit.size) {
		await vscode.workspace.applyEdit(edit);
		// Save notes that had no unsaved changes before, so the rename does
		// not leave a trail of dirty editors behind.
		await Promise.all(touched.map(doc => doc.save()));
	}
	return newUri;
}
