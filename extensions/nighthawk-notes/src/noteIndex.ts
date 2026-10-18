/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { normalizeNoteKey, noteNameFromPath, parseNote, resolveLink, type ParsedNote, type WikiLink } from './core/notes';

export interface IndexedNote {
	readonly uri: vscode.Uri;
	/** `vault` for the local vault, `team:<id>` for a team's shared notes. */
	readonly collection: string;
	/** Path relative to the collection root, with forward slashes. */
	readonly path: string;
	readonly name: string;
	readonly aliases: readonly string[];
	readonly parsed: ParsedNote;
}

export interface Backlink {
	readonly note: IndexedNote;
	readonly link: WikiLink;
	readonly lineText: string;
}

/**
 * In-memory index of every note's links, tags and headings, across the local
 * vault and the shared notes of each team. Links only resolve within the
 * collection the linking note belongs to.
 */
export class NoteIndex implements vscode.Disposable {

	private readonly notes = new Map<string, IndexedNote>();
	private readonly lines = new Map<string, string[]>();
	private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
	readonly onDidChange = this.onDidChangeEmitter.event;
	private changeTimer: ReturnType<typeof setTimeout> | undefined;

	dispose(): void {
		this.onDidChangeEmitter.dispose();
		clearTimeout(this.changeTimer);
	}

	set(collection: string, uri: vscode.Uri, path: string, text: string): void {
		const parsed = parseNote(text);
		this.notes.set(uri.toString(), { uri, collection, path, name: noteNameFromPath(path), aliases: parsed.aliases, parsed });
		this.lines.set(uri.toString(), text.split('\n'));
		this.fireChanged();
	}

	delete(uri: vscode.Uri): void {
		if (this.notes.delete(uri.toString())) {
			this.lines.delete(uri.toString());
			this.fireChanged();
		}
	}

	clearCollection(collection: string): void {
		for (const [key, note] of this.notes) {
			if (note.collection === collection) {
				this.notes.delete(key);
				this.lines.delete(key);
			}
		}
		this.fireChanged();
	}

	get(uri: vscode.Uri): IndexedNote | undefined {
		return this.notes.get(uri.toString());
	}

	all(collection?: string): IndexedNote[] {
		const result = [...this.notes.values()];
		return collection === undefined ? result : result.filter(note => note.collection === collection);
	}

	resolve(from: IndexedNote | string, target: string): IndexedNote | undefined {
		const collection = typeof from === 'string' ? from : from.collection;
		if (!target && typeof from !== 'string') {
			return from;
		}
		return resolveLink(target, this.all(collection));
	}

	backlinks(note: IndexedNote): Backlink[] {
		const result: Backlink[] = [];
		const keys = new Set([normalizeNoteKey(note.name), normalizeNoteKey(note.path), ...note.aliases.map(normalizeNoteKey)]);
		for (const other of this.all(note.collection)) {
			if (other.uri.toString() === note.uri.toString()) {
				continue;
			}
			for (const link of other.parsed.links) {
				// Cheap name check first, then a full resolve to rule out a
				// closer note with the same name.
				if (!keys.has(normalizeNoteKey(link.target)) && !keys.has(normalizeNoteKey(link.target.split('/').pop() ?? ''))) {
					continue;
				}
				if (this.resolve(other, link.target)?.uri.toString() === note.uri.toString()) {
					result.push({ note: other, link, lineText: this.lines.get(other.uri.toString())?.[link.line] ?? '' });
				}
			}
		}
		return result;
	}

	/** Link targets that do not resolve to any note, with the notes linking to them. */
	unresolvedLinks(collection: string): Map<string, IndexedNote[]> {
		const result = new Map<string, IndexedNote[]>();
		for (const note of this.all(collection)) {
			for (const link of note.parsed.links) {
				if (link.target && !this.resolve(note, link.target)) {
					const list = result.get(link.target) ?? [];
					if (!list.includes(note)) {
						list.push(note);
					}
					result.set(link.target, list);
				}
			}
		}
		return result;
	}

	tags(): Map<string, IndexedNote[]> {
		const result = new Map<string, IndexedNote[]>();
		for (const note of this.notes.values()) {
			for (const tag of note.parsed.tags) {
				const key = tag.name.toLowerCase();
				const list = result.get(key) ?? [];
				if (!list.includes(note)) {
					list.push(note);
				}
				result.set(key, list);
			}
		}
		return result;
	}

	private fireChanged(): void {
		clearTimeout(this.changeTimer);
		this.changeTimer = setTimeout(() => this.onDidChangeEmitter.fire(), 150);
	}
}
