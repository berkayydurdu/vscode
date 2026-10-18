/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isAllowedRequest } from '../src/core/teamApi.ts';
import { formatMinutes, parseDuration, parseMarkdown, startOfWeek } from '../webview-src/workspace/util.ts';

describe('team workspace', () => {
	it('only lets the page call its own team', () => {
		const cases: [string, string][] = [
			['GET', '/api/teams/t1'],
			['GET', '/api/teams/t1/items?since=4'],
			['PATCH', '/api/teams/t1/items/abc'],
			['GET', '/api/teams/t2/items'],
			['GET', '/api/teams/t1x/items'],
			['GET', '/api/teams/t1/../me'],
			['POST', '/api/auth/logout'],
			['PUT', '/api/teams/t1/notes/n'],
		];
		assert.deepEqual(cases.map(([method, path]) => isAllowedRequest('t1', method, path)), [true, true, true, false, false, false, false, false]);
	});

	it('reads durations the way people type them', () => {
		assert.deepEqual(
			['1h 30m', '1.5h', '90m', '1:30', '2', '0.25', '45 min', '', 'soon'].map(text => parseDuration(text)),
			[90, 90, 90, 90, 120, 15, 45, 0, undefined],
		);
		assert.deepEqual([formatMinutes(90), formatMinutes(60), formatMinutes(5)], ['1h 30m', '1h', '5m']);
	});

	it('starts weeks on Monday', () => {
		assert.equal(startOfWeek(new Date(2026, 9, 18)).getDate(), 12);
	});

	it('keeps HTML in Markdown as text', () => {
		assert.deepEqual(parseMarkdown('## Plan\n- [x] <b>done</b>\n\n<img src=x onerror=alert(1)> **bold** [[Spec|the spec]]'), [
			{ tag: 'h2', children: ['Plan'] },
			{ tag: 'ul', children: [{ tag: 'li', class: 'task', children: [{ tag: 'span', class: 'md-check done', children: [] }, '<b>done</b>'] }] },
			{ tag: 'p', children: ['<img src=x onerror=alert(1)> ', { tag: 'strong', children: ['bold'] }, ' ', { tag: 'a', class: 'wikilink', href: '#', note: 'Spec', children: ['the spec'] }] },
		]);
	});
});
