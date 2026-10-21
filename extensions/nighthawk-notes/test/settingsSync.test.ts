/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { canonical, isIgnored, mergeLists, mergeMaps } from '../src/core/settingsSync.ts';

describe('settings sync merging', () => {
	it('takes each side\'s changes and keeps this computer\'s on conflicts', () => {
		const base = { 'editor.fontSize': 14, 'editor.tabSize': 4, 'files.autoSave': 'off', 'editor.wordWrap': 'off' };
		const local = { 'editor.fontSize': 16, 'editor.tabSize': 4, 'editor.wordWrap': 'on', 'terminal.integrated.fontSize': 12 };
		const remote = { 'editor.fontSize': 14, 'editor.tabSize': 2, 'files.autoSave': 'off', 'editor.wordWrap': 'bounded', 'workbench.colorTheme': 'Nighthawk Light' };
		assert.deepStrictEqual(mergeMaps(base, local, remote), {
			merged: {
				'editor.fontSize': 16, // changed here
				'editor.tabSize': 2, // changed there
				// files.autoSave: removed here
				'editor.wordWrap': 'on', // changed on both: this computer wins
				'terminal.integrated.fontSize': 12, // added here
				'workbench.colorTheme': 'Nighthawk Light', // added there
			},
			conflicts: ['editor.wordWrap'],
		});
	});

	it('lets a new computer take on the synced settings', () => {
		const local = { 'workbench.colorTheme': 'Nighthawk Dark', 'editor.fontSize': 13 };
		const remote = { 'workbench.colorTheme': 'Nighthawk Light', 'editor.minimap.enabled': false };
		assert.deepStrictEqual(mergeMaps(undefined, local, remote), {
			merged: { 'workbench.colorTheme': 'Nighthawk Light', 'editor.fontSize': 13, 'editor.minimap.enabled': false },
			conflicts: ['workbench.colorTheme'],
		});
	});

	it('merges lists by entry, keeping removals from either side', () => {
		const save = { key: 'ctrl+s', command: 'workbench.action.files.saveAll' };
		const agent = { key: 'ctrl+escape', command: 'nighthawk.agent.open' };
		const terminal = { key: 'ctrl+`', command: 'workbench.action.terminal.toggleTerminal' };
		const notes = { command: 'nighthawk.notes.newNote', key: 'ctrl+alt+n' };
		assert.deepStrictEqual({
			keybindings: mergeLists([save, agent], [agent, terminal], [save, agent, { key: 'ctrl+alt+n', command: 'nighthawk.notes.newNote' }]),
			extensions: mergeLists(['esbenp.prettier-vscode', 'golang.Go'], ['esbenp.prettier-vscode', 'golang.go', 'rust-lang.rust-analyzer'], ['ESBENP.prettier-vscode'], id => id.toLowerCase()),
		}, {
			// The save shortcut was removed here, the notes one added there.
			keybindings: [agent, terminal, notes],
			// Go was removed on the other computer.
			extensions: ['esbenp.prettier-vscode', 'rust-lang.rust-analyzer'],
		});
	});

	it('compares settings regardless of key order and ignores machine settings', () => {
		assert.deepStrictEqual([
			canonical({ b: 1, a: { d: [2, { f: 1, e: 0 }], c: 3 } }),
			isIgnored('nighthawk.notes.vaultPath', ['nighthawk.notes.vaultPath']),
			isIgnored('terminal.integrated.shell.linux', ['terminal.integrated.shell.*']),
			isIgnored('editor.fontSize', ['editor.font']),
		], ['{"a":{"c":3,"d":[2,{"e":0,"f":1}]},"b":1}', true, true, false]);
	});
});
