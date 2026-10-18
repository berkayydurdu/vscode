/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** Converts a glob such as `src/**\/*.{ts,tsx}` into a regular expression over `/` paths. */
export function globToRegExp(glob: string, ignoreCase = false): RegExp {
	let source = '';
	let braces = 0;
	for (let i = 0; i < glob.length; i++) {
		const c = glob[i];
		if (c === '*') {
			if (glob[i + 1] === '*') {
				const slashAfter = glob[i + 2] === '/';
				const atSegmentStart = i === 0 || glob[i - 1] === '/';
				if (atSegmentStart && slashAfter) {
					source += '(?:.*/)?';
					i += 2;
				} else {
					source += '.*';
					i += 1;
				}
			} else {
				source += '[^/]*';
			}
		} else if (c === '?') {
			source += '[^/]';
		} else if (c === '{') {
			braces++;
			source += '(?:';
		} else if (c === '}' && braces) {
			braces--;
			source += ')';
		} else if (c === ',' && braces) {
			source += '|';
		} else if (c === '[') {
			const end = glob.indexOf(']', i + 1);
			if (end > i) {
				const body = glob.slice(i + 1, end).replace(/^!/, '^').replace(/\\/g, '\\\\');
				source += `[${body}]`;
				i = end;
			} else {
				source += '\\[';
			}
		} else {
			source += c.replace(/[.+^$()|\\\]]/g, '\\$&');
		}
	}
	return new RegExp(`^${source}$`, ignoreCase ? 'i' : '');
}

/** Folders skipped when walking files without ripgrep. */
export const SKIPPED_DIRS = new Set(['.git', 'node_modules', '.hg', '.svn', '__pycache__', '.venv', '.next', '.cache']);
