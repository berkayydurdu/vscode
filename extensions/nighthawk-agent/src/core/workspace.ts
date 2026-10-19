/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

export interface FileStat {
	isDirectory: boolean;
	size: number;
	mtime: number;
}

/**
 * The files the agent works on. The editor replaces reads and writes so the
 * agent sees unsaved changes and its edits land in open editors with undo.
 */
export interface Workspace {
	/** Absolute folder paths; the first is the working directory. */
	readonly roots: string[];
	readText(file: string): Promise<string>;
	readBytes(file: string): Promise<Uint8Array>;
	writeText(file: string, text: string): Promise<void>;
	stat(file: string): Promise<FileStat | undefined>;
	readDir(dir: string): Promise<{ name: string; isDirectory: boolean }[]>;
}

export class NodeWorkspace implements Workspace {
	readonly roots: string[];

	constructor(roots: string[]) {
		this.roots = roots;
	}

	readText(file: string): Promise<string> {
		return fs.readFile(file, 'utf8');
	}

	async readBytes(file: string): Promise<Uint8Array> {
		return fs.readFile(file);
	}

	async writeText(file: string, text: string): Promise<void> {
		await fs.mkdir(path.dirname(file), { recursive: true });
		await fs.writeFile(file, text, 'utf8');
	}

	async stat(file: string): Promise<FileStat | undefined> {
		try {
			const stat = await fs.stat(file);
			return { isDirectory: stat.isDirectory(), size: stat.size, mtime: stat.mtimeMs };
		} catch {
			return undefined;
		}
	}

	async readDir(dir: string): Promise<{ name: string; isDirectory: boolean }[]> {
		const entries = await fs.readdir(dir, { withFileTypes: true });
		return entries.map(e => ({ name: e.name, isDirectory: e.isDirectory() }));
	}
}

const caseInsensitive = process.platform === 'win32' || process.platform === 'darwin';

function normalize(p: string): string {
	const resolved = path.resolve(p);
	return caseInsensitive ? resolved.toLowerCase() : resolved;
}

/** Resolves a path the model gave, relative to the working directory. */
export function resolvePath(workspace: Pick<Workspace, 'roots'>, p: string): string {
	let value = p.trim();
	if (value.startsWith('~/') || value === '~') {
		value = path.join(process.env.HOME ?? process.env.USERPROFILE ?? '', value.slice(1));
	}
	return path.resolve(workspace.roots[0] ?? process.cwd(), value);
}

export function isInside(parent: string, child: string): boolean {
	const a = normalize(parent);
	const b = normalize(child);
	return b === a || b.startsWith(a.endsWith(path.sep) ? a : a + path.sep);
}

export function isInWorkspace(workspace: Workspace, file: string): boolean {
	return workspace.roots.some(root => isInside(root, file));
}

/** A short path for display: relative to its workspace folder when inside one. */
export function displayPath(workspace: Workspace, file: string): string {
	for (const root of workspace.roots) {
		if (isInside(root, file)) {
			const rel = path.relative(root, file) || '.';
			return workspace.roots.length > 1 ? `${path.basename(root)}/${rel}` : rel;
		}
	}
	return file;
}

/** Keys files by path, ignoring case where the file system does. */
export function pathKey(file: string): string {
	return normalize(file);
}
