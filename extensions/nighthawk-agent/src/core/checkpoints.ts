/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

/**
 * Checkpoints: snapshots of a folder's files, kept in a separate ("shadow") Git
 * repository outside the folder. The user's own repository, branches, index and
 * history are never touched; only the files in the working folder are read and,
 * on restore, written.
 */

export type { Checkpoint } from './protocol';

export interface FileChange {
	/** Path relative to the folder, with forward slashes. */
	path: string;
	/** What restoring does to the file. */
	action: 'restore' | 'delete';
}

export interface CheckpointEntry {
	commit: string;
	at: number;
	label: string;
}

/** Folders that are rebuilt from source or downloaded, and too big to snapshot. */
export const DEFAULT_EXCLUDES = [
	'.git/', 'node_modules/', 'bower_components/', 'jspm_packages/', '.venv/', 'venv/', '__pycache__/', '.mypy_cache/', '.pytest_cache/', '.tox/',
	'.gradle/', '.next/', '.nuxt/', '.svelte-kit/', '.turbo/', '.parcel-cache/', '.cache/', '.angular/', '.dart_tool/', '.terraform/', 'Pods/', 'DerivedData/',
	'*.log', '.DS_Store', 'Thumbs.db',
];

/** New files bigger than this are left out of checkpoints. */
export const MAX_FILE_SIZE = 25 * 1024 * 1024;

const EXCLUDE_MARKER = '# Files too large for checkpoints (added automatically)';
const IDENTITY = { GIT_AUTHOR_NAME: 'Nighthawk', GIT_AUTHOR_EMAIL: 'checkpoints@nighthawk.local', GIT_COMMITTER_NAME: 'Nighthawk', GIT_COMMITTER_EMAIL: 'checkpoints@nighthawk.local' };

export class CheckpointError extends Error { }

/** Runs git without letting the user's GIT_* variables point it at another repository. */
export function runGit(git: string, args: string[], options: { input?: string; timeout?: number; env?: Record<string, string> } = {}): Promise<string> {
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (!key.startsWith('GIT_')) {
			env[key] = value;
		}
	}
	Object.assign(env, IDENTITY, { GIT_TERMINAL_PROMPT: '0' }, options.env);
	return new Promise((resolve, reject) => {
		const child = spawn(git, args, { env, windowsHide: true, timeout: options.timeout ?? 120_000 });
		const out: Buffer[] = [];
		const err: Buffer[] = [];
		child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
		child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
		child.on('error', error => reject(new CheckpointError(`Could not run git: ${error.message}`)));
		child.on('close', code => {
			if (code === 0) {
				resolve(Buffer.concat(out).toString('utf8'));
			} else {
				const message = Buffer.concat(err).toString('utf8').trim() || `git ${args.find(a => !a.startsWith('-')) ?? ''} exited with ${code}`;
				reject(new CheckpointError(message));
			}
		});
		child.stdin.on('error', () => { /* git may exit before reading everything */ });
		child.stdin.end(options.input ?? '');
	});
}

/** A shadow repository that snapshots one folder. */
export class ShadowRepo {
	private ready: Promise<void> | undefined;
	private readonly git: string;
	readonly gitDir: string;
	readonly root: string;

	constructor(git: string, gitDir: string, root: string) {
		this.git = git;
		this.gitDir = gitDir;
		this.root = root;
	}

	private run(args: string[], input?: string): Promise<string> {
		return runGit(this.git, [
			'-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false', '-c', 'core.fsmonitor=false', '-c', 'core.longpaths=true',
			'-c', 'core.quotepath=false', '-c', 'gc.auto=0', '-c', 'advice.addEmbeddedRepo=false', '-c', 'core.hooksPath=',
			`--git-dir=${this.gitDir}`, `--work-tree=${this.root}`, ...args,
		], { input });
	}

	private init(): Promise<void> {
		this.ready ??= (async () => {
			try {
				await stat(path.join(this.gitDir, 'HEAD'));
			} catch {
				await mkdir(this.gitDir, { recursive: true });
				await runGit(this.git, ['init', '--quiet', '--bare', this.gitDir]);
				await writeFile(path.join(this.gitDir, 'description'), `Nighthawk checkpoints for ${this.root}\n`);
			}
			await mkdir(path.join(this.gitDir, 'info'), { recursive: true });
			const exclude = path.join(this.gitDir, 'info', 'exclude');
			const current = await readFile(exclude, 'utf8').catch(() => '');
			if (!current.startsWith('# Nighthawk checkpoints')) {
				await writeFile(exclude, ['# Nighthawk checkpoints: never snapshot these.', ...DEFAULT_EXCLUDES, '', EXCLUDE_MARKER, ''].join('\n'));
			}
		})().catch(err => {
			this.ready = undefined;
			throw err;
		});
		return this.ready;
	}

	/** Leaves new files that are too large out of this and later snapshots. */
	private async excludeLargeFiles(): Promise<void> {
		const untracked = (await this.run(['ls-files', '-z', '--others', '--exclude-standard'])).split('\0').filter(Boolean);
		const large: string[] = [];
		for (const file of untracked) {
			const size = await stat(path.join(this.root, file)).then(s => s.size, () => 0);
			if (size > MAX_FILE_SIZE) {
				large.push(`/${file.replace(/([\\*?[\]!#])/g, '\\$1')}`);
			}
		}
		if (large.length) {
			const exclude = path.join(this.gitDir, 'info', 'exclude');
			const current = await readFile(exclude, 'utf8');
			await writeFile(exclude, `${current.replace(/\n*$/, '\n')}${large.join('\n')}\n`);
		}
	}

	private async head(): Promise<string | undefined> {
		return (await this.run(['rev-parse', '--verify', '--quiet', 'HEAD']).catch(() => '')).trim() || undefined;
	}

	/** Hashes the folder's files ahead of the first snapshot, which is slow in a big folder. */
	async prepare(): Promise<void> {
		await this.init();
		await this.add();
	}

	private async add(): Promise<void> {
		await this.excludeLargeFiles();
		await this.run(['add', '--all', '--ignore-errors', '--', '.']).catch(err => {
			// Unreadable files are skipped; anything else is a real failure.
			if (!/unable to (index|stat)|permission denied|open\(.*\) failed/i.test(err.message)) {
				throw err;
			}
		});
	}

	/**
	 * Saves the folder's files. With `reuse`, returns the previous snapshot when
	 * nothing changed instead of adding one, so the list stays short.
	 */
	async snapshot(label: string, options: { at?: number; reuse?: boolean } = {}): Promise<string> {
		await this.init();
		await this.add();
		const tree = (await this.run(['write-tree'])).trim();
		const parent = await this.head();
		if (options.reuse && parent && (await this.run(['rev-parse', `${parent}^{tree}`])).trim() === tree) {
			return parent;
		}
		const date = `@${Math.floor((options.at ?? Date.now()) / 1000)} +0000`;
		const commit = (await runGit(this.git, [`--git-dir=${this.gitDir}`, 'commit-tree', tree, ...(parent ? ['-p', parent] : []), '-F', '-'], {
			input: label.trim() || 'Checkpoint',
			env: { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
		})).trim();
		await this.run(['update-ref', 'HEAD', commit]);
		return commit;
	}

	/** What restoring `commit` would change, compared with `current` (another snapshot). */
	async changes(commit: string, current: string): Promise<FileChange[]> {
		await this.init();
		if (commit === current) {
			return [];
		}
		const out = await this.run(['diff-tree', '-r', '-z', '--no-renames', '--name-status', commit, current]);
		const parts = out.split('\0').filter(Boolean);
		const changes: FileChange[] = [];
		for (let i = 0; i + 1 < parts.length; i += 2) {
			// "A" means the file is new since the checkpoint, so restoring removes it.
			changes.push({ path: parts[i + 1], action: parts[i] === 'A' ? 'delete' : 'restore' });
		}
		return changes;
	}

	/** Puts the folder's files back as they were in `commit`; `current` is a snapshot taken just before. */
	async restore(commit: string, current: string): Promise<FileChange[]> {
		const changes = await this.changes(commit, current);
		for (const change of changes) {
			if (change.action === 'delete') {
				const file = path.join(this.root, ...change.path.split('/'));
				await rm(file, { force: true });
				await removeEmptyParents(path.dirname(file), this.root);
			}
		}
		await this.run(['read-tree', commit]);
		const restore = changes.filter(c => c.action === 'restore').map(c => c.path);
		if (restore.length) {
			await this.run(['checkout-index', '--force', '-z', '--stdin'], restore.join('\0') + '\0');
		}
		return changes;
	}

	/** Checkpoints of this folder, newest first. */
	async list(max = 200): Promise<CheckpointEntry[]> {
		await this.init();
		if (!await this.head()) {
			return [];
		}
		const out = await this.run(['log', `--max-count=${max}`, '-z', '--format=%H%x1f%ct%x1f%B', 'HEAD']);
		return out.split('\0').filter(Boolean).map(entry => {
			const [commit, time, label] = entry.split('\x1f');
			return { commit, at: Number(time) * 1000, label: label.trim() };
		});
	}

	/** Whether the snapshot still exists, e.g. after the checkpoint store was deleted. */
	async has(commit: string): Promise<boolean> {
		await this.init();
		return this.run(['cat-file', '-e', `${commit}^{commit}`]).then(() => true, () => false);
	}
}

async function removeEmptyParents(dir: string, root: string): Promise<void> {
	const stop = path.resolve(root);
	let current = path.resolve(dir);
	while (current.startsWith(stop + path.sep)) {
		try {
			await rmdir(current);
		} catch {
			return;
		}
		current = path.dirname(current);
	}
}

/** "5 minutes ago", for picking a checkpoint by time. */
export function timeAgo(at: number, now = Date.now()): string {
	const minutes = Math.round((now - at) / 60_000);
	if (minutes < 1) {
		return 'just now';
	}
	if (minutes < 60) {
		return minutes === 1 ? '1 minute ago' : `${minutes} minutes ago`;
	}
	const hours = Math.round(minutes / 60);
	if (hours < 24) {
		return hours === 1 ? '1 hour ago' : `${hours} hours ago`;
	}
	const days = Math.round(hours / 24);
	return days === 1 ? 'yesterday' : `${days} days ago`;
}
