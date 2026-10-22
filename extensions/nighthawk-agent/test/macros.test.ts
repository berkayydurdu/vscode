/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { addStep, describeMacro, editStep, parseMacros, planEdit, type MacroStep } from '../src/core/macros.ts';

describe('keyboard macros', () => {
	it('joins typed text and describes the steps', () => {
		const steps: MacroStep[] = [];
		for (const step of [
			{ kind: 'type', text: 'f' },
			{ kind: 'type', text: 'oo' },
			{ kind: 'command', command: 'cursorWordLeft' },
			{ kind: 'command', command: 'editor.action.deleteLines' },
			{ kind: 'type', text: '"' },
			{ kind: 'edit', before: 2, after: 0, text: 'console' },
		] satisfies MacroStep[]) {
			addStep(steps, step);
		}
		assert.deepStrictEqual([steps.length, describeMacro(steps), describeMacro(steps, 20)], [
			5,
			'"foo" · cursorWordLeft · delete line · "\\"" · suggestion "console"',
			'"foo" · cursorWordL…',
		]);
	});

	it('turns an accepted suggestion into an edit around the cursor and plays it on every cursor', () => {
		// "co|" accepted as "console", and "a|b" replaced on both sides.
		const step = editStep(2, { offset: 0, length: 2, text: 'console' })!;
		const text = 'co\nco\nab';
		const plan = planEdit(step, [8, 2, 5], text.length);
		assert.deepStrictEqual([
			step,
			editStep(9, { offset: 0, length: 2, text: 'x' }),
			editStep(1, { offset: 0, length: 2, text: 'xy' }),
			plan,
		], [
			{ kind: 'edit', before: 2, after: 0, text: 'console' },
			undefined,
			{ kind: 'edit', before: 1, after: 1, text: 'xy' },
			{ replacements: [{ start: 0, end: 2 }, { start: 3, end: 5 }, { start: 6, end: 8 }], cursors: [7, 15, 23] },
		]);
	});

	it('keeps the edits of cursors close together from overlapping', () => {
		assert.deepStrictEqual(planEdit({ before: 3, after: 0, text: 'X' }, [2, 3, 3], 3), { replacements: [{ start: 0, end: 2 }, { start: 2, end: 3 }], cursors: [1, 2] });
	});

	it('reads saved macros and drops broken ones', () => {
		const good = { name: 'Quote', steps: [{ kind: 'type', text: '"' }, { kind: 'command', command: 'cursorEnd' }], created: 1 };
		assert.deepStrictEqual(parseMacros([good, { name: 'Bad', steps: [{ kind: 'type' }] }, { steps: [] }, null]), [good]);
		assert.deepStrictEqual(parseMacros('nope'), []);
	});

	it('only takes over editing keys while recording', () => {
		const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { contributes: { keybindings: { command: string; key: string; when?: string; args?: { command?: string } }[] } };
		const wrapped = pkg.contributes.keybindings.filter(k => k.command === 'nighthawk.macro.wrap');
		assert.deepStrictEqual(wrapped.filter(k => !k.when?.startsWith('nighthawk.macro.recording && editorTextFocus') || !k.args?.command || !k.key), []);
		assert.ok(wrapped.length > 40);
	});
});
