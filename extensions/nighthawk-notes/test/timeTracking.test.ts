/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { addMinute, fileNames, prune, roundMinutes, suggestions, type TrackedDays, type WorkContext } from '../src/core/timeTracking.ts';

const at = (day: number, hour: number, minute = 0) => new Date(2026, 9, day, hour, minute).getTime();
const ticket: WorkContext = { repo: 'app', branch: 'nc-12-fix-login', teamId: 't1', number: 12, key: 'NC-12' };
const loose: WorkContext = { repo: 'app', branch: 'spike/cache' };
const other: WorkContext = { repo: 'site', branch: 'xy-3-copy', teamId: 't2', number: 3, key: 'XY-3' };

function track(days: TrackedDays, context: WorkContext, day: number, minutes: number, files: string[] = []): void {
	for (let i = 0; i < minutes; i++) {
		addMinute(days, context, files[i % Math.max(1, files.length)], at(day, 9, i));
	}
}

describe('time tracking', () => {
	it('counts minutes per ticket and branch per day, latest files first', () => {
		const days: TrackedDays = {};
		track(days, ticket, 20, 3, ['src/a.ts', 'src/b.ts', 'src/a.ts']);
		track(days, loose, 20, 2);
		track(days, ticket, 19, 1);
		assert.deepEqual(Object.fromEntries(Object.entries(days).map(([day, log]) => [day, Object.fromEntries(Object.entries(log).map(([key, slice]) => [key, [slice.minutes, slice.files]]))])), {
			'2026-10-20': { 't1#12': [3, ['src/a.ts', 'src/b.ts']], 'branch:app/spike/cache': [2, []] },
			'2026-10-19': { 't1#12': [1, []] },
		});
		assert.deepEqual(Object.keys(prune(days, at(20, 12), 0)), ['2026-10-20']);
		assert.deepEqual(fileNames(['src/a.ts', 'test\\a.ts', 'src/b.ts']), ['a.ts', 'b.ts']);
	});

	it('rounds without losing short stretches', () => {
		assert.deepEqual([roundMinutes(112), roundMinutes(8), roundMinutes(6), roundMinutes(52, 30), roundMinutes(7, 1)], [105, 15, 0, 60, 7]);
	});

	it('suggests unlogged time for the team and loose branches', () => {
		const days: TrackedDays = {};
		track(days, ticket, 20, 112, ['src/login.ts']);
		track(days, ticket, 19, 64);
		track(days, loose, 20, 40);
		track(days, other, 20, 90);
		track(days, { ...loose, branch: 'tiny' }, 20, 5);
		const result = suggestions(days, {
			teamId: 't1',
			from: '2026-10-19',
			to: '2026-10-25',
			dismissed: new Set(['2026-10-20|branch:app/spike/cache']),
			logged: (number, date) => number === 12 && date === '2026-10-19' ? 30 : 0,
		});
		assert.deepEqual(result.map(s => [s.date, s.key ?? s.branch, s.tracked, s.logged, s.minutes, s.files]), [
			['2026-10-20', 'NC-12', 112, 0, 105, ['login.ts']],
			['2026-10-19', 'NC-12', 64, 30, 30, []],
		]);
		const withLoose = suggestions(days, { teamId: 't1', from: '2026-10-20', to: '2026-10-20', logged: () => 105 });
		assert.deepEqual(withLoose.map(s => [s.key ?? s.branch, s.minutes]), [['spike/cache', 45]]);
	});
});
