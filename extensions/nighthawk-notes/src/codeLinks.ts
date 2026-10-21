/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFile } from 'node:child_process';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { WorkContext } from './core/timeTracking';
import { findTicketKeys, mentionsTicket, ticketBranchName, ticketPrefix } from './core/tickets';
import type { Team } from './teams/client';
import type { TeamFileSystem } from './teams/teamFileSystem';

/** The parts of the built-in Git extension's API (`extensions/git/src/api/git.d.ts`) used here. */
interface GitRepository {
	readonly rootUri: vscode.Uri;
	readonly state: {
		readonly HEAD: { readonly name?: string } | undefined;
		readonly onDidChange: vscode.Event<void>;
	};
	createBranch(name: string, checkout: boolean, ref?: string): Promise<void>;
	diffBetween(ref1: string, ref2: string): Promise<{ readonly uri: vscode.Uri; readonly originalUri: vscode.Uri; readonly status: number }[]>;
}

interface GitApi {
	readonly repositories: GitRepository[];
	readonly onDidOpenRepository: vscode.Event<GitRepository>;
	readonly onDidCloseRepository: vscode.Event<GitRepository>;
	toGitUri(uri: vscode.Uri, ref: string): vscode.Uri;
	getRepository(uri: vscode.Uri): GitRepository | null;
}

async function gitApi(): Promise<GitApi | undefined> {
	const extension = vscode.extensions.getExtension<{ getAPI(version: 1): GitApi }>('vscode.git');
	if (!extension) {
		return undefined;
	}
	try {
		return (extension.isActive ? extension.exports : await extension.activate()).getAPI(1);
	} catch {
		return undefined; // Git is disabled.
	}
}

function git(cwd: string, args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile('git', args, { cwd, maxBuffer: 4 * 1024 * 1024, timeout: 15_000 }, (err, stdout) => err ? reject(err) : resolve(stdout));
	});
}

export interface LinkedCommit {
	hash: string;
	shortHash: string;
	subject: string;
	author: string;
	/** Seconds since the epoch. */
	date: number;
}

export interface RepositoryLinks {
	name: string;
	root: string;
	current: string | undefined;
	branches: string[];
	commits: LinkedCommit[];
}

/** Commits and branches that mention a ticket, in every repository open in this window. */
export async function codeLinks(key: string): Promise<{ repositories: RepositoryLinks[] }> {
	const api = await gitApi();
	const [prefix, number] = key.split('-');
	if (!api || !prefix || !/^\d+$/.test(number ?? '')) {
		return { repositories: [] };
	}
	// git's own --grep narrows the search; mentionsTicket then drops near misses such as NC-120.
	const grep = `${prefix}[-_ ]?${number}`;
	const repositories = await Promise.all(api.repositories.map(async (repository): Promise<RepositoryLinks> => {
		const root = repository.rootUri.fsPath;
		const [log, refs] = await Promise.all([
			git(root, ['log', '--all', '--regexp-ignore-case', '--extended-regexp', `--grep=${grep}`, '--max-count=50', '--format=%H%x1f%h%x1f%s%x1f%an%x1f%at%x1f%B%x1e']).catch(() => ''),
			git(root, ['for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes']).catch(() => ''),
		]);
		const commits: LinkedCommit[] = [];
		for (const record of log.split('\x1e')) {
			const [hash, shortHash, subject, author, date, message] = record.trim().split('\x1f');
			if (hash && mentionsTicket(message ?? subject, key)) {
				commits.push({ hash, shortHash, subject, author, date: Number(date) });
			}
		}
		const branches = refs.split('\n').filter(ref => ref && !ref.endsWith('/HEAD') && mentionsTicket(ref, key));
		return { name: path.basename(root), root, current: repository.state.HEAD?.name, branches, commits };
	}));
	return { repositories: repositories.filter(r => r.commits.length || r.branches.length || api.repositories.length === 1) };
}

/** Creates and checks out a branch named after the ticket in a repository the user picks. */
export async function startTicketBranch(key: string, title: string): Promise<void> {
	const api = await gitApi();
	if (!api?.repositories.length) {
		vscode.window.showInformationMessage(vscode.l10n.t('Open a folder with a Git repository to start a branch for {0}.', key));
		return;
	}
	const repository = api.repositories.length === 1 ? api.repositories[0] : (await vscode.window.showQuickPick(
		api.repositories.map(r => ({ label: path.basename(r.rootUri.fsPath), description: r.rootUri.fsPath, repository: r })),
		{ title: vscode.l10n.t('Start a Branch for {0}', key), placeHolder: vscode.l10n.t('In which repository?') },
	))?.repository;
	if (!repository) {
		return;
	}
	const name = await vscode.window.showInputBox({
		title: vscode.l10n.t('Start a Branch for {0}', key),
		prompt: vscode.l10n.t('The branch starts from what is checked out now ({0}).', repository.state.HEAD?.name ?? 'HEAD'),
		value: ticketBranchName(key, title),
		validateInput: value => /^(?!.*\.\.)(?!\/)[^\s~^:?*[\\]+(?<![/.])$/.test(value.trim()) ? undefined : vscode.l10n.t('Enter a valid branch name.'),
	});
	if (!name) {
		return;
	}
	try {
		await repository.createBranch(name.trim(), true);
		vscode.window.showInformationMessage(vscode.l10n.t('Switched to the new branch {0}. Commits that mention {1} show on the ticket.', name.trim(), key));
	} catch (err) {
		vscode.window.showErrorMessage(vscode.l10n.t('Could not create the branch: {0}', err.message ?? String(err)));
	}
}

/** Opens the changes of a commit in the multi-file diff editor. */
export async function openCommit(root: string, hash: string, subject: string): Promise<void> {
	const api = await gitApi();
	const repository = api?.getRepository(vscode.Uri.file(root));
	if (!api || !repository || !/^[0-9a-f]{7,40}$/i.test(hash)) {
		return;
	}
	let changes: Awaited<ReturnType<GitRepository['diffBetween']>> = [];
	try {
		changes = await repository.diffBetween(`${hash}~1`, hash);
	} catch {
		// The first commit has no parent; show it against nothing instead.
		changes = await repository.diffBetween('4b825dc642cb6eb9a060e54bf8d69288fbee4904', hash).catch(() => []);
	}
	const resources = changes.map(change => [
		change.uri,
		api.toGitUri(change.originalUri, `${hash}~1`),
		api.toGitUri(change.uri, hash),
	]);
	await vscode.commands.executeCommand('vscode.changes', `${hash.slice(0, 7)} ${subject}`, resources);
}

/** "1h 45m", "45m" */
export function formatDuration(minutes: number): string {
	const hours = Math.floor(minutes / 60);
	const rest = minutes % 60;
	return hours && rest ? `${hours}h ${rest}m` : hours ? `${hours}h` : `${rest}m`;
}

/**
 * Shows the ticket of the checked-out branch in the status bar, for example
 * "NC-12" on `nc-12-fix-login`, and opens it in the team workspace on click.
 */
export class TicketStatus implements vscode.Disposable {

	private readonly item = vscode.window.createStatusBarItem('nighthawk.notes.ticket', vscode.StatusBarAlignment.Left, 50);
	private readonly disposables: vscode.Disposable[] = [this.item];
	private readonly watched = new Set<GitRepository>();
	private tracked: ((context: WorkContext) => number) | undefined;

	constructor(private readonly fs: TeamFileSystem) {
		this.item.name = vscode.l10n.t('Ticket of the Current Branch');
		this.disposables.push(fs.onDidChangeTeams(() => this.update()));
		this.watch();
	}

	private async watch(): Promise<void> {
		const api = await gitApi();
		if (!api) {
			return;
		}
		const add = (repository: GitRepository) => {
			if (!this.watched.has(repository)) {
				this.watched.add(repository);
				this.disposables.push(repository.state.onDidChange(() => this.update()));
			}
		};
		api.repositories.forEach(add);
		this.disposables.push(
			api.onDidOpenRepository(repository => { add(repository); this.update(); }),
			api.onDidCloseRepository(repository => { this.watched.delete(repository); this.update(); }),
			vscode.window.onDidChangeActiveTextEditor(() => this.update()),
		);
		this.update();
	}

	/** The repository the user is looking at: the active editor's, else the first. */
	private current(): GitRepository | undefined {
		const uri = vscode.window.activeTextEditor?.document.uri;
		const repositories = [...this.watched];
		return (uri && repositories.find(r => uri.fsPath.startsWith(r.rootUri.fsPath + path.sep))) || repositories[0];
	}

	/** The checked-out branch and, when it names one, its ticket. */
	context(): (WorkContext & { team?: Team }) | undefined {
		const repository = this.current();
		const branch = repository?.state.HEAD?.name;
		if (!repository || !branch) {
			return undefined;
		}
		const byPrefix = new Map<string, Team>();
		for (const team of this.fs.allTeams()) {
			byPrefix.set(ticketPrefix(team.name), team);
		}
		const ref = findTicketKeys(branch, [...byPrefix.keys()])[0];
		const team = ref && byPrefix.get(ref.prefix);
		const repo = path.basename(repository.rootUri.fsPath);
		return team ? { repo, branch, team, teamId: team.id, number: ref.number, key: ref.key } : { repo, branch };
	}

	/** Shows the time tracked today next to the ticket. */
	showTracked(tracked: (context: WorkContext) => number, onDidChange: vscode.Event<void>): void {
		this.tracked = tracked;
		this.disposables.push(onDidChange(() => this.update()));
		this.update();
	}

	private update(): void {
		const context = this.context();
		if (!context?.team || !context.key) {
			this.item.hide();
			return;
		}
		const minutes = this.tracked?.(context) ?? 0;
		const time = minutes >= 1 ? ` ${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}` : '';
		this.item.text = `$(issues) ${context.key}${time}`;
		this.item.tooltip = minutes >= 1
			? vscode.l10n.t('Branch {0} is linked to {1} in {2}. You have worked on it for {3} today; the team workspace timesheet suggests logging it. Click to open the ticket.', context.branch, context.key, context.team.name, formatDuration(minutes))
			: vscode.l10n.t('Branch {0} is linked to {1} in {2}. Click to open the ticket.', context.branch, context.key, context.team.name);
		this.item.command = { title: vscode.l10n.t('Open Ticket'), command: 'nighthawk.notes.teams.openTicket', arguments: [context.team.id, context.number] };
		this.item.show();
	}

	dispose(): void {
		this.disposables.forEach(d => d.dispose());
	}
}
