/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { currentPhase, openTasks, parseSpecState, parseTasks, phaseOf, phasePrompt, specSlug, taskPrompt, titleFrom, type SpecInfo } from '../src/core/spec.ts';

const spec: SpecInfo = {
	dir: '.nighthawk/specs/pdf-export',
	state: { title: 'PDF export', request: 'Let users export notes as PDF', created: 1, approved: {} },
};

const tasks = [
	'# Tasks',
	'',
	'- [x] 1. Add the export command',
	'  - Register it in package.json',
	'- [ ] 2. Render notes',
	'  - [x] 2.1 Markdown to HTML',
	'  - [ ] 2.2 HTML to PDF',
	'- [ ] 3. **Tests** for export',
	'```',
	'- [ ] not a task',
	'```',
].join('\n');

describe('spec mode', () => {
	it('names folders and titles from the request', () => {
		assert.equal(specSlug('Let users export their notes as PDF!'), 'let-users-export-their-notes-as');
		assert.equal(specSlug('???'), 'spec');
		assert.equal(titleFrom('Add dark mode. It should follow the OS.\nMore detail'), 'Add dark mode.');
		assert.ok(titleFrom('a '.repeat(80)).length <= 60);
	});

	it('goes through the documents in order', () => {
		assert.equal(currentPhase(spec.state), 'requirements');
		assert.equal(currentPhase({ ...spec.state, approved: { requirements: 1 } }), 'design');
		assert.equal(currentPhase({ ...spec.state, approved: { requirements: 1, design: 2, tasks: 3 } }), undefined);
		assert.equal(phaseOf('/w/.nighthawk/specs/x/Design.md'), 'design');
		assert.equal(phaseOf('/w/.nighthawk/specs/x/notes.md'), undefined);
	});

	it('reads spec.json and ignores what is not a spec', () => {
		assert.deepEqual(parseSpecState('{"title":"A","approved":{"requirements":5,"design":"no"}}')?.approved, { requirements: 5 });
		assert.equal(parseSpecState('{"approved":{}}'), undefined);
		assert.equal(parseSpecState('not json'), undefined);
	});

	it('reads the task checklist, skipping code blocks', () => {
		const parsed = parseTasks(tasks);
		assert.deepEqual(parsed.map(t => [t.number, t.done, t.depth]), [['1', true, 0], ['2', false, 0], ['2.1', true, 1], ['2.2', false, 1], ['3', false, 0]]);
		assert.equal(parsed[4].title, 'Tests for export');
		assert.equal(parsed[3].line, 6);
	});

	it('offers the tasks without open sub-tasks', () => {
		assert.deepEqual(openTasks(parseTasks(tasks)).map(t => t.number), ['2.2', '3']);
	});

	it('writes prompts that keep each step to its document', () => {
		const first = phasePrompt(spec, 'requirements');
		assert.match(first, /Let users export notes as PDF/);
		assert.match(first, /WHEN <event> THEN the system SHALL/);
		assert.match(first, /\.nighthawk\/specs\/pdf-export\/requirements\.md/);
		assert.match(phasePrompt(spec, 'tasks'), /@\.nighthawk\/specs\/pdf-export\/requirements\.md, @\.nighthawk\/specs\/pdf-export\/design\.md/);
		const task = taskPrompt(spec, parseTasks(tasks)[3]);
		assert.match(task, /task 2\.2 .*HTML to PDF/);
		assert.match(task, /Do only this task/);
		assert.match(taskPrompt(spec, undefined), /one at a time/);
	});
});
