/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Keyboard macros, as in Emacs and Sublime Text: while recording, typed
// text and the editing keys (cursor moves, deletes, multi-cursor, line
// commands) are kept as steps, which play back on the cursors the editor
// has then.

export type MacroStep =
	/** Text typed, played back through the editor's type command so auto-closing and indenting work the same. */
	| { kind: 'type'; text: string }
	/** A command, such as cursorWordLeft or editor.action.deleteLines. */
	| { kind: 'command'; command: string; args?: unknown }
	/**
	 * An edit made by accepting a suggestion: around each cursor, `before`
	 * characters before it and `after` characters after it become `text`.
	 */
	| { kind: 'edit'; before: number; after: number; text: string };

export interface Macro {
	name: string;
	steps: MacroStep[];
	created: number;
}

/** Steps a recording keeps; a stuck key cannot fill memory. */
export const MAX_STEPS = 10_000;

/** Adds a step to a recording, joining text typed in a row into one step. */
export function addStep(steps: MacroStep[], step: MacroStep): void {
	const last = steps.at(-1);
	if (step.kind === 'type' && last?.kind === 'type') {
		last.text += step.text;
	} else if (steps.length < MAX_STEPS) {
		steps.push(step);
	}
}

const COMMAND_NAMES: Record<string, string> = {
	'editor.action.addSelectionToNextFindMatch': 'add next match',
	'editor.action.insertCursorAbove': 'cursor above',
	'editor.action.insertCursorBelow': 'cursor below',
	'editor.action.moveLinesUpAction': 'move line up',
	'editor.action.moveLinesDownAction': 'move line down',
	'editor.action.copyLinesUpAction': 'copy line up',
	'editor.action.copyLinesDownAction': 'copy line down',
	'editor.action.deleteLines': 'delete line',
	'editor.action.commentLine': 'comment',
	'editor.action.indentLines': 'indent',
	'editor.action.outdentLines': 'outdent',
	'editor.action.insertLineAfter': 'line below',
	'editor.action.insertLineBefore': 'line above',
	'editor.action.selectAll': 'select all',
	'editor.action.clipboardCopyAction': 'copy',
	'editor.action.clipboardCutAction': 'cut',
	'editor.action.clipboardPasteAction': 'paste',
};

/** A step as a few words, such as `"foo"`, `cursorWordLeft` or `delete line`. */
export function describeStep(step: MacroStep): string {
	switch (step.kind) {
		case 'type':
			return JSON.stringify(step.text);
		case 'edit':
			return `suggestion ${JSON.stringify(step.text)}`;
		case 'command':
			return COMMAND_NAMES[step.command] ?? step.command.replace(/^(default:|editor\.action\.)/, '');
	}
}

/** The steps as one line, cut short when long. */
export function describeMacro(steps: readonly MacroStep[], max = 80): string {
	const line = steps.map(describeStep).join(' · ');
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/**
 * The edit step for a change the editor made around the cursor, or
 * undefined when the change does not touch the cursor (another cursor's).
 */
export function editStep(cursor: number, change: { offset: number; length: number; text: string }): MacroStep | undefined {
	const end = change.offset + change.length;
	if (cursor < change.offset || cursor > end) {
		return undefined;
	}
	return { kind: 'edit', before: cursor - change.offset, after: end - cursor, text: change.text };
}

/**
 * Plays an edit step on cursors given as document offsets: the ranges to
 * replace, in document order without overlaps, and where each cursor ends up.
 */
export function planEdit(step: { before: number; after: number; text: string }, cursors: readonly number[], length: number): { replacements: { start: number; end: number }[]; cursors: number[] } {
	const replacements: { start: number; end: number }[] = [];
	for (const cursor of [...new Set(cursors)].sort((a, b) => a - b)) {
		const start = Math.max(0, cursor - step.before, replacements.at(-1)?.end ?? 0);
		replacements.push({ start, end: Math.max(start, Math.min(length, cursor + step.after)) });
	}
	let shift = 0;
	const after = replacements.map(r => {
		const at = r.start + shift + step.text.length;
		shift += step.text.length - (r.end - r.start);
		return at;
	});
	return { replacements, cursors: after };
}

/** Reads saved macros, dropping any that are not well formed. */
export function parseMacros(value: unknown): Macro[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return value.filter((m): m is Macro => typeof m?.name === 'string' && Array.isArray(m.steps) && m.steps.every(isStep));
}

function isStep(step: Partial<MacroStep> | undefined): boolean {
	switch (step?.kind) {
		case 'type':
			return typeof step.text === 'string';
		case 'command':
			return typeof step.command === 'string';
		case 'edit':
			return typeof step.text === 'string' && typeof step.before === 'number' && typeof step.after === 'number';
		default:
			return false;
	}
}
