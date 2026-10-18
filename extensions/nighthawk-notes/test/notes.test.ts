/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Run with: node --test extensions/nighthawk-notes/test/

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { expandTemplate, formatDate, noteNameFromPath, parseNote, resolveLink, rewriteLinks, sanitizeFileName } from '../src/core/notes.ts';

describe('parseNote', () => {
	it('finds wiki links with headings, aliases and embeds', () => {
		const text = 'See [[Launch plan#Goals|the goals]] and ![[diagram]].\nAlso [[ Projects/Roadmap ]].';
		const { links } = parseNote(text);
		assert.deepEqual(links.map(l => [l.target, l.heading, l.alias, l.embed, l.line]), [
			['Launch plan', 'Goals', 'the goals', false, 0],
			['diagram', undefined, undefined, true, 0],
			['Projects/Roadmap', undefined, undefined, false, 1],
		]);
		const roadmap = links[2];
		assert.equal(text.slice(roadmap.targetStart, roadmap.targetEnd), 'Projects/Roadmap');
	});

	it('finds tags but not headings, numbers or anything in code', () => {
		const text = [
			'---',
			'tags: [project, "q4"]',
			'aliases:',
			'  - Launch',
			'---',
			'# Title',
			'#inbox and #work/meetings, issue #12',
			'`#notatag` and [[#Heading]]',
			'```',
			'#also-not [[not a link]]',
			'```',
		].join('\n');
		const parsed = parseNote(text);
		assert.deepEqual(parsed.tags.map(t => t.name).sort(), ['inbox', 'project', 'q4', 'work/meetings']);
		assert.deepEqual(parsed.headings.map(h => [h.level, h.text]), [[1, 'Title']]);
		assert.deepEqual(parsed.aliases, ['Launch']);
		assert.deepEqual(parsed.links.map(l => [l.target, l.heading]), [['', 'Heading']]);
	});
});

describe('resolveLink', () => {
	const notes = [
		{ path: 'Archive/Projects/Launch.md' },
		{ path: 'Projects/Launch.md' },
		{ path: 'Daily/2026-10-18.md', aliases: ['today'] },
	];

	it('prefers exact paths, then the shortest matching name, then aliases', () => {
		assert.equal(resolveLink('Archive/Projects/Launch', notes)?.path, 'Archive/Projects/Launch.md');
		assert.equal(resolveLink('launch', notes)?.path, 'Projects/Launch.md');
		assert.equal(resolveLink('Projects/Launch.md', notes)?.path, 'Projects/Launch.md');
		assert.equal(resolveLink('Today', notes)?.path, 'Daily/2026-10-18.md');
		assert.equal(resolveLink('missing', notes), undefined);
	});
});

describe('rewriteLinks', () => {
	it('renames link targets and keeps headings and aliases', () => {
		const text = 'A [[Old#Top|alias]] B [[other]] C [[old]]';
		const result = rewriteLinks(text, parseNote(text).links, t => t.toLowerCase() === 'old', 'New name');
		assert.equal(result, 'A [[New name#Top|alias]] B [[other]] C [[New name]]');
		assert.equal(rewriteLinks('no links', [], () => true, 'x'), undefined);
	});
});

describe('helpers', () => {
	it('formats names, dates and templates', () => {
		assert.equal(noteNameFromPath('Projects/Launch plan.md'), 'Launch plan');
		assert.equal(sanitizeFileName('What: a/b? #1'), 'What a b 1');
		assert.equal(sanitizeFileName('   '), 'Untitled');
		const date = new Date(2026, 9, 8, 7, 5);
		assert.equal(formatDate(date, 'YYYY-MM-DD HH:mm'), '2026-10-08 07:05');
		assert.equal(expandTemplate('# {{title}}\n{{date}} {{time}} {{date:DD.MM.YYYY}}', 'Standup', date), '# Standup\n2026-10-08 07:05 08.10.2026');
	});
});
