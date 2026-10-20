/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { addMinute, isoDay, prune, roundMinutes, sliceKey, suggestions, type Suggestion, type TrackedDays, type WorkContext } from './core/timeTracking';
import { formatDuration } from './codeLinks';
import type { Account } from './teams/account';

const STATE_KEY = 'nighthawk.notes.timeTracking';

interface Saved {
	days: TrackedDays;
	dismissed: string[];
	/** The last day a reminder was shown. */
	reminded?: string;
}

/**
 * Counts the minutes you are active in the editor while a branch is checked
 * out, per ticket the branch names, so the timesheet can suggest what to
 * log. Everything stays on this computer until you log it.
 */
export class ActivityTracker implements vscode.Disposable {
	private saved: Saved;
	private lastActivity = 0;
	private lastFile: string | undefined;
	private readonly emitter = new vscode.EventEmitter<void>();
	readonly onDidChange = this.emitter.event;
	private readonly disposables: vscode.Disposable[] = [this.emitter];

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly account: Account,
		private readonly workContext: () => WorkContext | undefined,
		private readonly openTimesheet: (teamId: string) => void,
	) {
		this.saved = context.globalState.get<Saved>(STATE_KEY) ?? { days: {}, dismissed: [] };
		const touch = (uri?: vscode.Uri) => this.touch(uri);
		this.disposables.push(
			vscode.workspace.onDidChangeTextDocument(e => {
				if (e.contentChanges.length && (e.document.uri.scheme === 'file' || e.document.uri.scheme === 'untitled')) {
					touch(e.document.uri);
				}
			}),
			vscode.workspace.onDidSaveTextDocument(document => touch(document.uri)),
			vscode.window.onDidChangeTextEditorSelection(() => touch()),
			vscode.window.onDidChangeActiveTextEditor(() => touch()),
			vscode.window.onDidChangeTextEditorVisibleRanges(() => touch()),
			vscode.window.onDidStartTerminalShellExecution(() => touch()),
			vscode.window.onDidChangeActiveTerminal(() => touch()),
			vscode.window.onDidChangeWindowState(state => state.focused && touch()),
		);
		const timer = setInterval(() => this.tick(), 60_000);
		this.disposables.push({ dispose: () => clearInterval(timer) });
	}

	dispose(): void {
		this.disposables.forEach(d => d.dispose());
	}

	private config(): vscode.WorkspaceConfiguration {
		return vscode.workspace.getConfiguration('nighthawk.notes.timeTracking');
	}

	private touch(uri?: vscode.Uri): void {
		this.lastActivity = Date.now();
		if (uri?.scheme === 'file' && vscode.workspace.getWorkspaceFolder(uri)) {
			this.lastFile = vscode.workspace.asRelativePath(uri, false);
		}
	}

	/** Counts the past minute if the user was active in it. */
	tick(now = Date.now()): void {
		const idle = Math.max(1, this.config().get<number>('idleMinutes', 5)) * 60_000;
		if (!this.config().get<boolean>('enabled', true) || now - this.lastActivity > idle) {
			return;
		}
		const work = this.workContext();
		if (!work) {
			return;
		}
		addMinute(this.saved.days, work, this.lastFile, now);
		this.lastFile = undefined;
		this.saved.days = prune(this.saved.days, now);
		const oldest = Object.keys(this.saved.days).sort()[0] ?? isoDay(now);
		this.saved.dismissed = this.saved.dismissed.filter(id => id >= oldest);
		this.save();
		this.emitter.fire();
		this.remind(now);
	}

	private save(): void {
		this.context.globalState.update(STATE_KEY, this.saved);
	}

	/** Active minutes today on this branch's ticket, or on the branch itself. */
	trackedToday(work: WorkContext): number {
		return this.saved.days[isoDay(Date.now())]?.[sliceKey(work)]?.minutes ?? 0;
	}

	/** What the timesheet should offer to log for one team, given the minutes already logged. */
	suggestions(teamId: string, from: string, to: string, logged: Record<string, number>): Suggestion[] {
		return suggestions(this.saved.days, {
			teamId,
			from,
			to,
			step: this.step(),
			dismissed: new Set(this.saved.dismissed),
			logged: (number, date) => logged[`${number}|${date}`] ?? 0,
		});
	}

	dismiss(id: string): void {
		if (!this.saved.dismissed.includes(id)) {
			this.saved.dismissed.push(id);
			this.save();
			this.emitter.fire();
		}
	}

	private step(): number {
		return Math.max(1, this.config().get<number>('roundTo', 15));
	}

	/**
	 * Once a day, after the reminder time, says how much tracked ticket time
	 * is not on the timesheet yet, if it is at least half an hour.
	 */
	private async remind(now: number): Promise<void> {
		const at = /^(?<hours>\d{1,2}):(?<minutes>\d{2})$/.exec(this.config().get<string>('reminder', '17:00') ?? '');
		const today = isoDay(now);
		const date = new Date(now);
		if (!at?.groups || this.saved.reminded === today || !this.account.user) {
			return;
		}
		if (date.getHours() * 60 + date.getMinutes() < Number(at.groups.hours) * 60 + Number(at.groups.minutes)) {
			return;
		}
		this.saved.reminded = today;
		this.save();
		const tracked = new Map<string, number>();
		for (const slice of Object.values(this.saved.days[today] ?? {})) {
			if (slice.teamId && slice.number) {
				tracked.set(slice.teamId, (tracked.get(slice.teamId) ?? 0) + roundMinutes(slice.minutes, this.step()));
			}
		}
		for (const [teamId, minutes] of tracked) {
			let logged = 0;
			try {
				const query = new URLSearchParams({ from: today, to: today, userId: this.account.user.id });
				const result = await this.account.client.call<{ worklogs: { minutes: number }[] }>('GET', `/api/teams/${encodeURIComponent(teamId)}/worklogs?${query}`);
				logged = result.worklogs.reduce((sum, log) => sum + log.minutes, 0);
			} catch {
				continue; // Offline; no reminder rather than a wrong one.
			}
			const missing = minutes - logged;
			if (missing >= 30) {
				const review = vscode.l10n.t('Review Timesheet');
				const pick = await vscode.window.showInformationMessage(vscode.l10n.t('You worked about {0} on tickets today that is not on your timesheet yet.', formatDuration(missing)), review);
				if (pick === review) {
					this.openTimesheet(teamId);
				}
				return;
			}
		}
	}
}
