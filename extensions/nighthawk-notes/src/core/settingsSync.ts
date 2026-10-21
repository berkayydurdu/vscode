/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Merging for settings sync, without 'vscode' so it can be tested with Node.
// Each kind of data is merged three ways: what both sides had after the
// last sync (the base), what this computer has now, and what the server
// has now. A change on one side wins; a change on both sides goes to this
// computer once it has synced before, and to the server on the first sync,
// so a new computer takes on the settings everyone else has.

export type SyncResourceName = 'settings' | 'keybindings' | 'snippets' | 'extensions';

export const SYNC_RESOURCES: readonly SyncResourceName[] = ['settings', 'keybindings', 'snippets', 'extensions'];

/** Settings that describe this computer rather than the person, never synced. */
export const MACHINE_SETTINGS = [
	'nighthawk.notes.vaultPath',
	'nighthawk.notes.server.url',
	'settingsSync.ignoredSettings',
	'settingsSync.ignoredExtensions',
];

/** JSON with object keys sorted, so equal values compare equal. */
export function canonical(value: unknown): string {
	return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(sortKeys);
	}
	if (value && typeof value === 'object') {
		return Object.fromEntries(Object.keys(value).sort().map(key => [key, sortKeys((value as Record<string, unknown>)[key])]));
	}
	return value;
}

/** True when a setting matches one of the patterns, which may end in `*`. */
export function isIgnored(key: string, patterns: readonly string[]): boolean {
	return patterns.some(pattern => pattern.endsWith('*') ? key.startsWith(pattern.slice(0, -1)) : key === pattern);
}

export interface MergeResult<T> {
	merged: T;
	/** Names of entries both sides changed differently. */
	conflicts: string[];
}

/**
 * Merges maps of named values (settings by key, snippet files by name).
 * A missing entry means not set; removing an entry on one side removes it.
 */
export function mergeMaps<T>(base: Record<string, T> | undefined, local: Record<string, T>, remote: Record<string, T>): MergeResult<Record<string, T>> {
	const first = !base;
	const before = base ?? {};
	const merged: Record<string, T> = {};
	const conflicts: string[] = [];
	const same = (a: T | undefined, b: T | undefined) => canonical(a) === canonical(b);
	for (const key of new Set([...Object.keys(local), ...Object.keys(remote), ...Object.keys(before)])) {
		const l = Object.hasOwn(local, key) ? local[key] : undefined;
		const r = Object.hasOwn(remote, key) ? remote[key] : undefined;
		const b = Object.hasOwn(before, key) ? before[key] : undefined;
		let value: T | undefined;
		if (same(l, r)) {
			value = l;
		} else if (same(l, b)) {
			value = r;
		} else if (same(r, b)) {
			value = l;
		} else if (first && (l === undefined || r === undefined)) {
			// Only one side has it: nothing to choose between.
			value = l ?? r;
		} else {
			conflicts.push(key);
			value = first ? r : l;
		}
		if (value !== undefined) {
			merged[key] = value;
		}
	}
	return { merged, conflicts };
}

/**
 * Merges lists whose entries are added and removed as a whole (keyboard
 * shortcuts, extensions). Keeps this computer's order, then adds the
 * server's new entries.
 */
export function mergeLists<T>(base: readonly T[] | undefined, local: readonly T[], remote: readonly T[], keyOf: (item: T) => string = canonical): T[] {
	const baseKeys = new Set((base ?? []).map(keyOf));
	const localKeys = new Set(local.map(keyOf));
	const remoteKeys = new Set(remote.map(keyOf));
	// Removed on one side: it was in the base and is missing there.
	const removed = (key: string) => baseKeys.has(key) && (!localKeys.has(key) || !remoteKeys.has(key));
	const result: T[] = [];
	const seen = new Set<string>();
	for (const item of [...local, ...remote]) {
		const key = keyOf(item);
		if (!seen.has(key) && !removed(key)) {
			seen.add(key);
			result.push(item);
		}
	}
	return result;
}

/** Parses a synced resource's content, or returns undefined when it is missing or unreadable. */
export function parseContent<T>(content: string | undefined): T | undefined {
	if (content === undefined) {
		return undefined;
	}
	try {
		return JSON.parse(content) as T;
	} catch {
		return undefined;
	}
}
