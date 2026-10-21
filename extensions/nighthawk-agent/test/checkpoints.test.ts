/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { MAX_FILE_SIZE, ShadowRepo, timeAgo } from '../src/core/checkpoints.ts';

const exists = (file: string) => stat(file).then(() => true, () => false);

describe('checkpoints', () => {
	let base: string;
	let root: string;
	let repo: ShadowRepo;

	before(async () => {
		base = await mkdtemp(path.join(tmpdir(), 'nh-checkpoints-'));
		root = path.join(base, 'project');
		await mkdir(path.join(root, 'src'), { recursive: true });
		// The project is a Git repository of its own, which checkpoints must leave alone.
		execFileSync('git', ['init', '-q', root]);
		await writeFile(path.join(root, '.gitignore'), 'build/\n');
		await writeFile(path.join(root, 'src', 'app.js'), 'console.log("works");\n');
		await writeFile(path.join(root, 'README.md'), '# App\n');
		repo = new ShadowRepo('git', path.join(base, 'store', 'project.git'), root);
	});

	after(async () => {
		await rm(base, { recursive: true, force: true });
	});

	it('goes back to an earlier state, including hand edits, new and deleted files', async () => {
		const working = await repo.snapshot('Add a dark mode', { at: Date.UTC(2026, 9, 21, 9, 0) });
		assert.equal(await repo.snapshot('Nothing changed', { reuse: true }), working, 'an unchanged folder can reuse the snapshot');

		await writeFile(path.join(root, 'src', 'app.js'), 'console.log("broken");\n');
		await mkdir(path.join(root, 'src', 'extra'));
		await writeFile(path.join(root, 'src', 'extra', 'new.js'), 'new\n');
		await rm(path.join(root, 'README.md'));
		await mkdir(path.join(root, 'build'));
		await writeFile(path.join(root, 'build', 'out.js'), 'ignored\n');
		await mkdir(path.join(root, 'node_modules', 'dep'), { recursive: true });
		await writeFile(path.join(root, 'node_modules', 'dep', 'index.js'), 'dependency\n');

		const now = await repo.snapshot('Before restoring', { reuse: true });
		assert.notEqual(now, working);
		assert.deepEqual((await repo.changes(working, now)).sort((a, b) => a.path.localeCompare(b.path)), [
			{ path: 'README.md', action: 'restore' },
			{ path: 'src/app.js', action: 'restore' },
			{ path: 'src/extra/new.js', action: 'delete' },
		]);

		await repo.restore(working, now);
		assert.equal(await readFile(path.join(root, 'src', 'app.js'), 'utf8'), 'console.log("works");\n');
		assert.equal(await readFile(path.join(root, 'README.md'), 'utf8'), '# App\n');
		assert.equal(await exists(path.join(root, 'src', 'extra')), false, 'new files and their empty folders are removed');
		assert.equal(await exists(path.join(root, 'build', 'out.js')), true, 'ignored files are left alone');
		assert.equal(await exists(path.join(root, 'node_modules', 'dep', 'index.js')), true, 'dependencies are left alone');

		// Undo: go forward to the snapshot taken before restoring.
		const restored = await repo.snapshot('Before undo', { reuse: true });
		await repo.restore(now, restored);
		assert.equal(await readFile(path.join(root, 'src', 'app.js'), 'utf8'), 'console.log("broken");\n');
		assert.equal(await exists(path.join(root, 'src', 'extra', 'new.js')), true);
		assert.equal(await exists(path.join(root, 'README.md')), false);
	});

	it('lists checkpoints newest first and leaves the project\'s Git alone', async () => {
		const list = await repo.list();
		assert.deepEqual(list.map(c => c.label), ['Before undo', 'Before restoring', 'Add a dark mode']);
		assert.equal(list[2].at, Date.UTC(2026, 9, 21, 9, 0));
		assert.equal(await repo.has(list[2].commit), true);
		assert.equal(await repo.has('0'.repeat(40)), false);
		assert.equal(execFileSync('git', ['-C', root, 'rev-list', '--all']).toString(), '', 'no commits in the project');
		assert.equal(execFileSync('git', ['-C', root, 'diff', '--cached', '--name-only']).toString(), '', 'nothing staged in the project');
	});

	it('leaves very large new files out', async () => {
		const before = await repo.snapshot('Without a big file');
		await writeFile(path.join(root, 'video.mp4'), Buffer.alloc(MAX_FILE_SIZE + 1));
		assert.equal(await repo.snapshot('With a big file', { reuse: true }), before);
		assert.equal((await repo.list())[0].label, 'Without a big file');
		await rm(path.join(root, 'video.mp4'));
	});

	it('says how long ago', () => {
		const now = Date.UTC(2026, 9, 21, 12, 0);
		assert.deepEqual([0, 1, 30, 60, 90, 60 * 24, 60 * 24 * 3].map(m => timeAgo(now - m * 60_000, now)),
			['just now', '1 minute ago', '30 minutes ago', '1 hour ago', '2 hours ago', 'yesterday', '3 days ago']);
	});
});
