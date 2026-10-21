/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHash } from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { runGit, ShadowRepo, timeAgo, type Checkpoint, type FileChange } from '../core/checkpoints';

/** A checkpoint compared with the files as they are now. */
export interface Comparison {
	/** A checkpoint of the files as they are now, to undo a restore with. */
	now: Checkpoint;
	changes: { root: string; change: FileChange }[];
}

export type RestoreChoice = 'code' | 'both' | 'conversation';

/**
 * Snapshots of the workspace's files, taken whenever a message is sent to the
 * agent, so the code can go back to how it was at any earlier message. Each
 * folder gets a shadow Git repository in the extension's storage; the
 * project's own Git repository and history are never touched.
 */
export class Checkpoints {
	private readonly repos = new Map<string, ShadowRepo>();
	private readonly queues = new Map<string, Promise<unknown>>();
	private gitPath: Promise<string | undefined> | undefined;
	private warned = false;
	/** The files as they were before the last restore. */
	private undoPoint: Checkpoint | undefined;

	constructor(private readonly storage: vscode.Uri) { }

	get enabled(): boolean {
		return vscode.workspace.getConfiguration('nighthawk.agent').get<boolean>('checkpoints', true);
	}

	get canUndo(): boolean {
		return !!this.undoPoint;
	}

	/** Git as the Git extension found it, else from PATH. */
	private git(): Promise<string | undefined> {
		this.gitPath ??= (async () => {
			const candidates: string[] = [];
			try {
				const extension = vscode.extensions.getExtension<{ getAPI(version: 1): { git: { path: string } } }>('vscode.git');
				const exports = extension && (extension.isActive ? extension.exports : await extension.activate());
				const found = exports?.getAPI(1).git.path;
				if (found) {
					candidates.push(found);
				}
			} catch {
				// The Git extension is disabled or still starting.
			}
			candidates.push('git');
			for (const candidate of candidates) {
				if (await runGit(candidate, ['--version'], { timeout: 10_000 }).then(() => true, () => false)) {
					return candidate;
				}
			}
			return undefined;
		})();
		return this.gitPath;
	}

	private repo(git: string, root: string): ShadowRepo {
		let repo = this.repos.get(root);
		if (!repo) {
			const key = createHash('sha256').update(process.platform === 'win32' ? root.toLowerCase() : root).digest('hex').slice(0, 16);
			repo = new ShadowRepo(git, path.join(this.storage.fsPath, 'checkpoints', `${key}.git`), root);
			this.repos.set(root, repo);
		}
		return repo;
	}

	/** Runs one Git operation at a time per folder, since conversations can share one. */
	private serial<T>(root: string, task: () => Promise<T>): Promise<T> {
		const previous = this.queues.get(root) ?? Promise.resolve();
		const next = previous.then(task, task);
		this.queues.set(root, next.catch(() => undefined));
		return next;
	}

	private async shadowRepos(roots: readonly string[]): Promise<ShadowRepo[]> {
		const git = await this.git();
		if (!git) {
			throw new Error(vscode.l10n.t('Checkpoints need Git, which was not found. Install Git or set git.path.'));
		}
		return roots.map(root => this.repo(git, root));
	}

	/** Gets the folders ready in the background, so the first checkpoint is quick. */
	warm(roots: readonly string[]): void {
		if (!this.enabled || !roots.length || roots.every(root => this.repos.has(root))) {
			return;
		}
		this.shadowRepos(roots).then(repos => Promise.all(repos.map(repo => this.serial(repo.root, () => repo.prepare())))).catch(() => undefined);
	}

	/** Saves the files of `roots`; quietly returns nothing when checkpoints are off or unavailable. */
	async create(roots: readonly string[], label: string): Promise<Checkpoint | undefined> {
		if (!this.enabled || !roots.length) {
			return undefined;
		}
		try {
			return await this.snapshot(roots, label, false);
		} catch (err) {
			if (!this.warned) {
				this.warned = true;
				vscode.window.showWarningMessage(vscode.l10n.t('Could not save a checkpoint of your files: {0}', err.message));
			}
			return undefined;
		}
	}

	/** Checkpoints for messages are always kept, so each one is in the list; others reuse an unchanged one. */
	private async snapshot(roots: readonly string[], label: string, reuse: boolean): Promise<Checkpoint> {
		const at = Date.now();
		const repos = await this.shadowRepos(roots);
		const refs = await Promise.all(repos.map(async repo => ({ root: repo.root, commit: await this.serial(repo.root, () => repo.snapshot(label, { at, reuse })) })));
		return { at, refs };
	}

	/** Takes a checkpoint of the files now and lists what restoring `checkpoint` would change. */
	async compare(checkpoint: Checkpoint, label: string): Promise<Comparison> {
		const now = await this.snapshot(checkpoint.refs.map(r => r.root), label, true);
		const repos = await this.shadowRepos(checkpoint.refs.map(r => r.root));
		const changes: Comparison['changes'] = [];
		for (const [i, ref] of checkpoint.refs.entries()) {
			const repo = repos[i];
			if (!await repo.has(ref.commit)) {
				throw new Error(vscode.l10n.t('This checkpoint is no longer stored.'));
			}
			for (const change of await this.serial(ref.root, () => repo.changes(ref.commit, now.refs[i].commit))) {
				changes.push({ root: ref.root, change });
			}
		}
		return { now, changes };
	}

	/** Puts the files back as they were at `checkpoint`, after `compare` took `now`. */
	async restore(checkpoint: Checkpoint, now: Checkpoint): Promise<void> {
		const repos = await this.shadowRepos(checkpoint.refs.map(r => r.root));
		for (const [i, ref] of checkpoint.refs.entries()) {
			await this.serial(ref.root, () => repos[i].restore(ref.commit, now.refs[i].commit));
		}
		this.undoPoint = now;
	}

	/**
	 * Asks the user and restores the files. With `conversation`, also offers to
	 * take the conversation back; the caller does that part.
	 */
	async confirmAndRestore(checkpoint: Checkpoint, options: { what: string; conversation: boolean }): Promise<RestoreChoice | undefined> {
		await vscode.workspace.saveAll(false);
		let comparison: Comparison;
		try {
			comparison = await this.compare(checkpoint, vscode.l10n.t('Before restoring to: {0}', options.what));
		} catch (err) {
			vscode.window.showErrorMessage(vscode.l10n.t('Could not open the checkpoint: {0}', err.message));
			return undefined;
		}
		const time = new Date(checkpoint.at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
		const files = comparison.changes;
		const multiRoot = checkpoint.refs.length > 1;
		const names = files.slice(0, 8).map(f => `${f.change.action === 'delete' ? '- ' : ''}${multiRoot ? `${path.basename(f.root)}/` : ''}${f.change.path}`);
		const more = files.length > names.length ? `\n${vscode.l10n.t('...and {0} more', files.length - names.length)}` : '';
		const code = vscode.l10n.t('Restore Code');
		const both = vscode.l10n.t('Restore Code and Conversation');
		const conversation = vscode.l10n.t('Conversation Only');
		const buttons = files.length
			? (options.conversation ? [code, both, conversation] : [code])
			: (options.conversation ? [conversation] : []);
		const when = vscode.l10n.t('{0} ({1})', time, timeAgo(checkpoint.at));
		if (!buttons.length) {
			vscode.window.showInformationMessage(vscode.l10n.t('Your files are the same as at the checkpoint from {0}.', when));
			return undefined;
		}
		const detail = files.length
			? [
				vscode.l10n.t('Your files go back to how they were at {0}, before: {1}', when, options.what),
				'',
				vscode.l10n.t('{0} file(s) differ (- means the file is new and gets removed):', files.length),
				names.join('\n') + more,
				'',
				vscode.l10n.t('Your Git branches and commits are not touched, and you can undo this.'),
			].join('\n')
			: vscode.l10n.t('Your files are the same as at {0}, so only the conversation can go back.', when);
		const answer = await vscode.window.showWarningMessage(vscode.l10n.t('Go back to the checkpoint from {0}?', time), { modal: true, detail }, ...buttons);
		if (!answer) {
			return undefined;
		}
		if (answer === code || answer === both) {
			try {
				await this.restore(checkpoint, comparison.now);
			} catch (err) {
				vscode.window.showErrorMessage(vscode.l10n.t('Could not restore the checkpoint: {0}', err.message));
				return undefined;
			}
		}
		return answer === code ? 'code' : answer === both ? 'both' : 'conversation';
	}

	/** Puts the files back as they were before the last restore. */
	async undo(): Promise<boolean> {
		const point = this.undoPoint;
		if (!point) {
			return false;
		}
		await vscode.workspace.saveAll(false);
		try {
			const comparison = await this.compare(point, vscode.l10n.t('Before undoing a restore'));
			await this.restore(point, comparison.now);
			this.undoPoint = comparison.now;
			return true;
		} catch (err) {
			vscode.window.showErrorMessage(vscode.l10n.t('Could not undo the restore: {0}', err.message));
			return false;
		}
	}

	/** Lists every checkpoint of the workspace, from all conversations, and restores the one picked. */
	async pickAndRestore(roots: readonly string[]): Promise<void> {
		if (!roots.length) {
			vscode.window.showInformationMessage(vscode.l10n.t('Open a folder to use checkpoints.'));
			return;
		}
		let repos: ShadowRepo[];
		try {
			repos = await this.shadowRepos(roots);
		} catch (err) {
			vscode.window.showErrorMessage(err.message);
			return;
		}
		// Checkpoints of several folders taken together share their time and label.
		const grouped = new Map<string, { at: number; label: string; refs: Checkpoint['refs'] }>();
		for (const repo of repos) {
			for (const entry of await this.serial(repo.root, () => repo.list()).catch(() => [])) {
				const key = `${entry.at}\n${entry.label}`;
				const group = grouped.get(key) ?? { at: entry.at, label: entry.label, refs: [] };
				group.refs.push({ root: repo.root, commit: entry.commit });
				grouped.set(key, group);
			}
		}
		const entries = [...grouped.values()].sort((a, b) => b.at - a.at);
		if (!entries.length) {
			vscode.window.showInformationMessage(vscode.l10n.t('No checkpoints yet. One is saved each time you send the agent a message.'));
			return;
		}
		const pick = await vscode.window.showQuickPick(entries.map(entry => ({
			label: `$(history) ${timeAgo(entry.at)}`,
			description: new Date(entry.at).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' }),
			detail: entry.label.split('\n')[0].slice(0, 200),
			entry,
		})), {
			title: vscode.l10n.t('Restore Checkpoint'),
			placeHolder: vscode.l10n.t('Pick a moment to take your files back to (a checkpoint is saved before each agent message)'),
			matchOnDetail: true,
			matchOnDescription: true,
		});
		if (!pick) {
			return;
		}
		const checkpoint: Checkpoint = { at: pick.entry.at, refs: pick.entry.refs };
		if (await this.confirmAndRestore(checkpoint, { what: pick.entry.label.split('\n')[0].slice(0, 120), conversation: false })) {
			const undo = vscode.l10n.t('Undo');
			if (await vscode.window.showInformationMessage(vscode.l10n.t('Restored your files to {0}.', timeAgo(checkpoint.at)), undo) === undo) {
				await this.undo();
			}
		}
	}
}
