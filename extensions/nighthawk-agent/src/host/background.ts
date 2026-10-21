/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { backgroundPrompt, parseShortstat, taskSlug, taskTitle, type BackgroundStatus, type BackgroundTask } from '../core/background';
import type { PermissionMode } from '../core/permissions';
import { openAgentPanel, type AgentController, type ControllerHost } from './agentView';
import { Session } from './session';

const STATE_KEY = 'nighthawk.agent.backgroundTasks';

function git(cwd: string, args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile('git', args, { cwd, maxBuffer: 16 * 1024 * 1024, timeout: 60_000, windowsHide: true }, (err, stdout, stderr) => {
			if (err) {
				reject(new Error((stderr || err.message).trim()));
			} else {
				resolve(stdout);
			}
		});
	});
}

/** The parts of the built-in Git extension's API (`extensions/git/src/api/git.d.ts`) used here. */
interface GitApi {
	toGitUri(uri: vscode.Uri, ref: string): vscode.Uri;
	openRepository(root: vscode.Uri): Promise<{ diffBetween(ref1: string, ref2: string): Promise<{ uri: vscode.Uri; originalUri: vscode.Uri; status: number }[]> } | null>;
}

/** `Status` values of the Git extension's API that change how a diff is opened. */
const enum GitStatus {
	IndexAdded = 1,
	IndexRenamed = 3,
	Deleted = 6,
}

async function gitApi(): Promise<GitApi | undefined> {
	const extension = vscode.extensions.getExtension<{ getAPI(version: 1): GitApi }>('vscode.git');
	try {
		return extension && (extension.isActive ? extension.exports : await extension.activate()).getAPI(1);
	} catch {
		return undefined;
	}
}

/**
 * Agents that work on their own while the user keeps coding, each in its
 * own Git worktree and branch so they never touch the user's files or each
 * other. Shown in the "Background Agents" view.
 */
export class BackgroundAgents implements vscode.TreeDataProvider<BackgroundTask>, vscode.Disposable {
	private tasks: BackgroundTask[];
	private readonly sessions = new Map<string, Session>();
	private readonly viewers = new Map<string, AgentController>();
	private readonly changed = new vscode.EventEmitter<BackgroundTask | undefined>();
	readonly onDidChangeTreeData = this.changed.event;
	private readonly disposables: vscode.Disposable[] = [this.changed];
	private readonly timer: ReturnType<typeof setInterval>;

	constructor(private readonly host: ControllerHost) {
		// Work that was running when the window closed cannot resume by itself.
		this.tasks = (host.context.workspaceState.get<BackgroundTask[]>(STATE_KEY) ?? []).map(task =>
			task.status === 'running' || task.status === 'waiting' || task.status === 'queued' ? { ...task, status: 'stopped' as const } : task);
		// Refreshes the "running for 3m" descriptions.
		this.timer = setInterval(() => this.tasks.some(t => t.status === 'running') && this.changed.fire(undefined), 30_000);
		this.updateContext();
	}

	dispose(): void {
		clearInterval(this.timer);
		for (const session of this.sessions.values()) {
			session.dispose();
		}
		this.disposables.forEach(d => d.dispose());
	}

	/** The live conversation of a background task, so opening it from history shows this one. */
	live(sessionId: string): Session | undefined {
		return this.sessions.get(sessionId);
	}

	private save(): void {
		this.host.context.workspaceState.update(STATE_KEY, this.tasks);
		this.updateContext();
		this.changed.fire(undefined);
	}

	private updateContext(): void {
		vscode.commands.executeCommand('setContext', 'nighthawk.agent.hasBackgroundTasks', this.tasks.length > 0);
	}

	private set(task: BackgroundTask, change: Partial<BackgroundTask>): void {
		Object.assign(task, change);
		this.save();
	}

	// --- starting

	/** Asks for a task and the repository, makes a worktree and starts an agent on it. */
	async start(prompt?: string): Promise<void> {
		if (!this.host.endpoints.current()) {
			const add = vscode.l10n.t('Add Model Endpoint');
			if (await vscode.window.showInformationMessage(vscode.l10n.t('Connect a model to run background agents.'), add) === add) {
				await vscode.commands.executeCommand('nighthawk.ai.addEndpoint');
			}
			return;
		}
		const repos = await this.repositories();
		if (!repos.length) {
			vscode.window.showInformationMessage(vscode.l10n.t('Background agents work in a Git worktree, so open a folder that is a Git repository first.'));
			return;
		}
		prompt ??= await vscode.window.showInputBox({
			title: vscode.l10n.t('Start Background Agent'),
			prompt: vscode.l10n.t('What should the agent do? It works on its own branch in a separate worktree, starting from your last commit (uncommitted changes are not included).'),
			placeHolder: vscode.l10n.t('e.g. Add tests for the upload client and fix what they find'),
			ignoreFocusOut: true,
		});
		if (!prompt?.trim()) {
			return;
		}
		const repo = repos.length === 1 ? repos[0] : (await vscode.window.showQuickPick(repos.map(r => ({ label: path.basename(r), description: r, repo: r })), { title: vscode.l10n.t('Start Background Agent'), placeHolder: vscode.l10n.t('In which repository?') }))?.repo;
		if (!repo) {
			return;
		}
		const id = randomUUID().slice(0, 6);
		const slug = `${taskSlug(prompt)}-${id}`;
		const worktree = path.join(this.host.context.globalStorageUri.fsPath, 'worktrees', path.basename(repo), slug);
		const branch = `nighthawk/${slug}`;
		let base: string;
		let baseName: string | undefined;
		try {
			base = (await git(repo, ['rev-parse', 'HEAD'])).trim();
			baseName = (await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
			await git(repo, ['worktree', 'add', '-b', branch, worktree, base]);
		} catch (err) {
			vscode.window.showErrorMessage(vscode.l10n.t('Could not create a worktree for the background agent: {0}', err.message));
			return;
		}
		const task: BackgroundTask = {
			id, prompt: prompt.trim(), title: taskTitle(prompt), repo, worktree, branch, base,
			baseName: baseName === 'HEAD' ? undefined : baseName,
			status: 'queued', sessionId: '', created: Date.now(),
		};
		this.tasks.unshift(task);
		this.save();
		this.runQueued();
	}

	/** Git repositories among the workspace folders, by their top folder. */
	private async repositories(): Promise<string[]> {
		const folders = (vscode.workspace.workspaceFolders ?? []).filter(f => f.uri.scheme === 'file');
		const roots = await Promise.all(folders.map(f => git(f.uri.fsPath, ['rev-parse', '--show-toplevel']).then(out => path.normalize(out.trim()), () => undefined)));
		return [...new Set(roots.filter((r): r is string => !!r))];
	}

	private maxParallel(): number {
		return Math.max(1, vscode.workspace.getConfiguration('nighthawk.agent.background').get<number>('maxParallel', 3));
	}

	/** Starts queued tasks while fewer than the maximum are running. */
	private runQueued(): void {
		let active = this.tasks.filter(t => t.status === 'running' || t.status === 'waiting').length;
		for (const task of [...this.tasks].reverse()) {
			if (task.status === 'queued' && active < this.maxParallel()) {
				active++;
				this.run(task, backgroundPrompt(task));
			}
		}
	}

	private run(task: BackgroundTask, prompt: string, existing?: Session): void {
		const session = existing ?? this.session(task, undefined);
		this.set(task, { status: 'running', sessionId: session.id, error: undefined });
		session.sendTask(task.title, prompt);
	}

	/** A conversation for the task that keeps the task's status in step with it, new or loaded from history. */
	private session(task: BackgroundTask, data: ConstructorParameters<typeof Session>[1]): Session {
		const session = new Session({
			...this.host,
			reveal: () => this.needsUser(task),
			isVisible: () => !!this.viewers.get(task.id)?.visible,
		}, data, {
			roots: [task.worktree],
			mode: vscode.workspace.getConfiguration('nighthawk.agent.background').get<PermissionMode>('permissionMode', 'acceptEdits'),
		});
		this.sessions.set(session.id, session);
		session.onMessage(message => {
			if ((message.type === 'state' || message.type === 'upsert') && session.running && task.status !== 'stopped') {
				const waiting = session.transcript().some(item => (item.kind === 'tool' && item.status === 'awaiting') || (item.kind === 'question' && item.answer === undefined) || (item.kind === 'plan' && item.status === 'awaiting'));
				const status: BackgroundStatus = waiting ? 'waiting' : 'running';
				if (task.status !== status) {
					this.set(task, { status });
				}
			}
		});
		session.onDidFinish(() => this.finish(task, session));
		return session;
	}

	/** Commits what the agent changed, counts it and tells the user. */
	private async finish(task: BackgroundTask, session: Session): Promise<void> {
		const stopped = task.status === 'stopped';
		let changes = task.changes;
		try {
			if ((await git(task.worktree, ['status', '--porcelain'])).trim()) {
				await git(task.worktree, ['add', '-A']);
				await git(task.worktree, ['-c', 'user.name=Nighthawk Agent', '-c', 'user.email=agent@nighthawk.local', 'commit', '-q', '-m', task.title, '-m', `Background task: ${task.prompt}`]);
			}
			changes = parseShortstat(await git(task.worktree, ['diff', '--shortstat', task.base, 'HEAD']));
		} catch (err) {
			task.error = err.message;
		}
		const error = session.lastError;
		this.set(task, { status: stopped ? 'stopped' : error ? 'failed' : 'done', finished: Date.now(), changes, error: error ?? task.error });
		if (!this.viewers.has(task.id) && this.sessions.get(session.id) === session) {
			// Nobody is looking at it; free it. Opening the task loads it again.
			this.sessions.delete(session.id);
			session.dispose();
		}
		this.runQueued();
		if (stopped) {
			return;
		}
		const open = vscode.l10n.t('Open');
		const review = vscode.l10n.t('Review Changes');
		const message = error
			? vscode.l10n.t('Background agent "{0}" stopped with an error: {1}', task.title, error)
			: changes?.files
				? vscode.l10n.t('Background agent "{0}" finished: {1} files changed (+{2} -{3}).', task.title, changes.files, changes.added, changes.removed)
				: vscode.l10n.t('Background agent "{0}" finished without changing files.', task.title);
		const pick = await (error ? vscode.window.showWarningMessage(message, open) : vscode.window.showInformationMessage(message, ...(changes?.files ? [review, open] : [open])));
		if (pick === open) {
			await this.open(task);
		} else if (pick === review) {
			await this.review(task);
		}
	}

	/** The agent waits for an approval or an answer: say so unless its conversation is on screen. */
	private async needsUser(task: BackgroundTask): Promise<void> {
		const viewer = this.viewers.get(task.id);
		if (viewer) {
			viewer.revealPage();
			return;
		}
		const open = vscode.l10n.t('Open');
		if (await vscode.window.showInformationMessage(vscode.l10n.t('Background agent "{0}" is waiting for you.', task.title), open) === open) {
			await this.open(task);
		}
	}

	// --- actions

	/** Shows the task's conversation in an editor tab. */
	async open(task: BackgroundTask): Promise<void> {
		const viewer = this.viewers.get(task.id);
		if (viewer) {
			viewer.revealPage();
			return;
		}
		let session = this.sessions.get(task.sessionId);
		if (!session) {
			const data = task.sessionId ? await this.host.store.load(task.sessionId) : undefined;
			if (!data) {
				vscode.window.showWarningMessage(vscode.l10n.t('The conversation of this background agent could not be loaded.'));
				return;
			}
			session = this.session(task, data);
		}
		const controller = openAgentPanel(this.host);
		controller.show(session);
		this.viewers.set(task.id, controller);
		controller.onDidDispose(() => {
			this.viewers.delete(task.id);
			const live = this.sessions.get(task.sessionId);
			if (live && !live.running) {
				this.sessions.delete(task.sessionId);
				live.dispose();
			}
		});
	}

	/** Sends a stopped or finished task back to work in the same conversation. */
	async resume(task: BackgroundTask): Promise<void> {
		const text = await vscode.window.showInputBox({
			title: vscode.l10n.t('Continue Background Agent'),
			prompt: vscode.l10n.t('What should "{0}" do next?', task.title),
			value: task.status === 'stopped' ? vscode.l10n.t('Continue where you stopped.') : '',
			ignoreFocusOut: true,
		});
		if (!text?.trim()) {
			return;
		}
		let session = this.sessions.get(task.sessionId);
		if (!session) {
			const data = await this.host.store.load(task.sessionId);
			session = data && this.session(task, data);
		}
		if (!session) {
			vscode.window.showWarningMessage(vscode.l10n.t('The conversation of this background agent could not be loaded.'));
			return;
		}
		this.run(task, text.trim(), session);
	}

	stop(task: BackgroundTask): void {
		const session = this.sessions.get(task.sessionId);
		if (task.status === 'queued') {
			this.set(task, { status: 'stopped' });
		} else if (session?.running) {
			this.set(task, { status: 'stopped' });
			session.stop();
		}
	}

	/** Opens every file the agent changed in the multi-file diff editor, against where it started. */
	async review(task: BackgroundTask): Promise<void> {
		const api = await gitApi();
		const repository = api && await api.openRepository(vscode.Uri.file(task.worktree));
		if (!api || !repository) {
			vscode.window.showWarningMessage(vscode.l10n.t('The built-in Git extension is needed to review the changes.'));
			return;
		}
		const changes = await repository.diffBetween(task.base, 'HEAD');
		if (!changes.length) {
			vscode.window.showInformationMessage(vscode.l10n.t('Background agent "{0}" has not changed any files yet.', task.title));
			return;
		}
		// Added files have no original and deleted ones no modified side.
		await vscode.commands.executeCommand('vscode.changes', vscode.l10n.t('{0} (Background Agent)', task.title), changes.map(change => [
			change.uri,
			change.status === GitStatus.IndexAdded ? undefined : api.toGitUri(change.status === GitStatus.IndexRenamed ? change.originalUri : change.uri, task.base),
			change.status === GitStatus.Deleted ? undefined : api.toGitUri(change.uri, 'HEAD'),
		]));
	}

	/** Merges the task's branch into whatever is checked out in the repository now. */
	async merge(task: BackgroundTask): Promise<void> {
		let current = '';
		try {
			current = (await git(task.repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
		} catch {
			// Shown as "the current branch" below.
		}
		const merge = vscode.l10n.t('Merge');
		const pick = await vscode.window.showInformationMessage(
			vscode.l10n.t('Merge the changes of "{0}" into {1}?', task.title, current && current !== 'HEAD' ? current : vscode.l10n.t('the current branch')),
			{ modal: true, detail: vscode.l10n.t('This runs git merge {0} in {1}. Conflicts, if any, are left for you to resolve in Source Control.', task.branch, task.repo) },
			merge,
		);
		if (pick !== merge) {
			return;
		}
		try {
			await git(task.repo, ['merge', '--no-ff', '--no-edit', task.branch]);
			this.set(task, { status: 'merged' });
			const remove = vscode.l10n.t('Remove Worktree');
			if (await vscode.window.showInformationMessage(vscode.l10n.t('Merged "{0}". Remove its worktree and branch now?', task.title), remove) === remove) {
				await this.remove(task, false);
			}
		} catch (err) {
			vscode.window.showErrorMessage(vscode.l10n.t('The merge did not finish: {0}', err.message));
			await vscode.commands.executeCommand('workbench.view.scm');
		}
	}

	async openFolder(task: BackgroundTask): Promise<void> {
		await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(task.worktree), { forceNewWindow: true });
	}

	/** Removes the worktree and its branch; asks first unless the work was merged. */
	async remove(task: BackgroundTask, ask = task.status !== 'merged'): Promise<void> {
		if (ask) {
			const discard = vscode.l10n.t('Discard');
			const pick = await vscode.window.showWarningMessage(
				vscode.l10n.t('Discard background agent "{0}"?', task.title),
				{ modal: true, detail: vscode.l10n.t('This deletes its worktree and the branch {0}, with everything it changed.', task.branch) },
				discard,
			);
			if (pick !== discard) {
				return;
			}
		}
		const session = this.sessions.get(task.sessionId);
		session?.stop();
		try {
			await git(task.repo, ['worktree', 'remove', '--force', task.worktree]);
		} catch {
			// Already gone.
		}
		try {
			await git(task.repo, ['branch', '-D', task.branch]);
		} catch {
			// Already gone.
		}
		this.tasks = this.tasks.filter(t => t.id !== task.id);
		this.save();
	}

	// --- tree view

	getChildren(): BackgroundTask[] {
		return this.tasks;
	}

	getTreeItem(task: BackgroundTask): vscode.TreeItem {
		const item = new vscode.TreeItem(task.title, vscode.TreeItemCollapsibleState.None);
		item.id = task.id;
		item.iconPath = STATUS_ICONS[task.status];
		item.description = this.describe(task);
		item.contextValue = `backgroundTask.${task.status}`;
		item.command = { command: 'nighthawk.agent.background.open', title: vscode.l10n.t('Open'), arguments: [task] };
		const tooltip = new vscode.MarkdownString();
		tooltip.appendMarkdown(`**${statusLabel(task.status)}**\n\n`);
		tooltip.appendText(task.prompt);
		tooltip.appendMarkdown(`\n\n${vscode.l10n.t('Branch')}: \`${task.branch}\`  \n${vscode.l10n.t('Worktree')}: \`${task.worktree}\``);
		if (task.error) {
			tooltip.appendMarkdown('\n\n');
			tooltip.appendText(task.error);
		}
		item.tooltip = tooltip;
		return item;
	}

	private describe(task: BackgroundTask): string {
		const changes = task.changes?.files ? vscode.l10n.t('{0} files, +{1} -{2}', task.changes.files, task.changes.added, task.changes.removed) : '';
		switch (task.status) {
			case 'running': return vscode.l10n.t('working for {0}', elapsed(Date.now() - task.created));
			case 'waiting': return vscode.l10n.t('waiting for you');
			case 'queued': return vscode.l10n.t('queued');
			case 'failed': return vscode.l10n.t('failed');
			case 'stopped': return changes ? vscode.l10n.t('stopped, {0}', changes) : vscode.l10n.t('stopped');
			case 'merged': return changes ? vscode.l10n.t('merged, {0}', changes) : vscode.l10n.t('merged');
			default: return changes || vscode.l10n.t('no changes');
		}
	}
}

const STATUS_ICONS: Record<BackgroundStatus, vscode.ThemeIcon> = {
	queued: new vscode.ThemeIcon('clock'),
	running: new vscode.ThemeIcon('sync~spin'),
	waiting: new vscode.ThemeIcon('bell-dot', new vscode.ThemeColor('notificationsWarningIcon.foreground')),
	done: new vscode.ThemeIcon('pass', new vscode.ThemeColor('testing.iconPassed')),
	failed: new vscode.ThemeIcon('error', new vscode.ThemeColor('testing.iconFailed')),
	stopped: new vscode.ThemeIcon('debug-pause'),
	merged: new vscode.ThemeIcon('git-merge'),
};

function statusLabel(status: BackgroundStatus): string {
	switch (status) {
		case 'queued': return vscode.l10n.t('Queued');
		case 'running': return vscode.l10n.t('Working');
		case 'waiting': return vscode.l10n.t('Waiting for you');
		case 'done': return vscode.l10n.t('Done');
		case 'failed': return vscode.l10n.t('Failed');
		case 'stopped': return vscode.l10n.t('Stopped');
		case 'merged': return vscode.l10n.t('Merged');
	}
}

function elapsed(ms: number): string {
	const minutes = Math.floor(ms / 60_000);
	return minutes < 1 ? vscode.l10n.t('under a minute') : minutes < 60 ? vscode.l10n.t('{0}m', minutes) : vscode.l10n.t('{0}h {1}m', Math.floor(minutes / 60), minutes % 60);
}
