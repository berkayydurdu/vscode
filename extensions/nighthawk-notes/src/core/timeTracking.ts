/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Turns the minutes Nighthawk saw you working on a branch into suggested
// timesheet entries. No 'vscode' import, so it can be tested with Node.

/** What the user was working on during a minute. */
export interface WorkContext {
	repo: string;
	branch: string;
	/** Set when the branch names a team ticket. */
	teamId?: string;
	number?: number;
	/** "NC-12" */
	key?: string;
}

/** The active minutes on one ticket, or one branch without a ticket, during one day. */
export interface TrackedSlice extends WorkContext {
	minutes: number;
	/** Files edited, most recent first, at most 20. */
	files: string[];
	/** Milliseconds since the epoch. */
	first: number;
	last: number;
}

/** Slices of one day, keyed by {@link sliceKey}. */
export type DayLog = Record<string, TrackedSlice>;

/** Days as "2026-10-20", each with its slices. */
export type TrackedDays = Record<string, DayLog>;

export function sliceKey(context: WorkContext): string {
	return context.teamId && context.number ? `${context.teamId}#${context.number}` : `branch:${context.repo}/${context.branch}`;
}

/** "2026-10-20" in local time. */
export function isoDay(time: number): string {
	const date = new Date(time);
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** Adds one active minute to the day's log, with the file being edited if any. */
export function addMinute(days: TrackedDays, context: WorkContext, file: string | undefined, now: number): TrackedDays {
	const day = isoDay(now);
	const log = days[day] ??= {};
	const key = sliceKey(context);
	const slice = log[key] ??= { ...context, minutes: 0, files: [], first: now, last: now };
	slice.minutes++;
	slice.last = now;
	// A branch can be renamed or the ticket changed; keep the latest names.
	slice.branch = context.branch;
	slice.key = context.key;
	if (file) {
		slice.files = [file, ...slice.files.filter(f => f !== file)].slice(0, 20);
	}
	return days;
}

/** Drops days older than `keepDays` before `now`. */
export function prune(days: TrackedDays, now: number, keepDays = 21): TrackedDays {
	const oldest = isoDay(now - keepDays * 24 * 60 * 60 * 1000);
	return Object.fromEntries(Object.entries(days).filter(([day]) => day >= oldest));
}

/** Rounds to the nearest `step` minutes, but never down to nothing once there is half a step. */
export function roundMinutes(minutes: number, step = 15): number {
	if (step <= 1) {
		return Math.round(minutes);
	}
	const rounded = Math.round(minutes / step) * step;
	return rounded || (minutes >= step / 2 ? step : 0);
}

export interface Suggestion {
	/** Stable per day and ticket or branch, for dismissing. */
	id: string;
	date: string;
	repo: string;
	branch: string;
	teamId?: string;
	number?: number;
	key?: string;
	/** Active minutes seen. */
	tracked: number;
	/** Minutes already on the timesheet for this ticket and day. */
	logged: number;
	/** What to log: tracked time rounded, less what is logged. */
	minutes: number;
	/** Names of the files edited, most recent first. */
	files: string[];
}

/** The distinct file names among paths, in order. */
export function fileNames(files: readonly string[]): string[] {
	const names = files.map(file => file.split(/[\\/]/).pop()!);
	return names.filter((name, index) => names.indexOf(name) === index);
}

/**
 * Timesheet suggestions for one team between two days (inclusive): each
 * ticket's tracked time not yet logged, and branches without a ticket so
 * the user can pick one. `logged` returns the minutes already booked.
 */
export function suggestions(days: TrackedDays, options: { teamId: string; from: string; to: string; step?: number; minimum?: number; dismissed?: ReadonlySet<string>; logged(number: number, date: string): number }): Suggestion[] {
	const step = options.step ?? 15;
	const minimum = options.minimum ?? 10;
	const result: Suggestion[] = [];
	for (const [date, log] of Object.entries(days)) {
		if (date < options.from || date > options.to) {
			continue;
		}
		for (const [key, slice] of Object.entries(log)) {
			const id = `${date}|${key}`;
			const linked = slice.teamId === options.teamId && !!slice.number;
			if (options.dismissed?.has(id) || slice.minutes < minimum || (slice.teamId && !linked)) {
				continue;
			}
			const logged = linked ? options.logged(slice.number!, date) : 0;
			const minutes = roundMinutes(slice.minutes, step) - logged;
			if (minutes < Math.max(minimum, step / 2)) {
				continue;
			}
			result.push({ id, date, repo: slice.repo, branch: slice.branch, teamId: slice.teamId, number: slice.number, key: slice.key, tracked: slice.minutes, logged, minutes, files: fileNames(slice.files) });
		}
	}
	// Newest day first; linked tickets before loose branches; longest first.
	return result.sort((a, b) => b.date.localeCompare(a.date) || Number(!a.number) - Number(!b.number) || b.minutes - a.minutes);
}
