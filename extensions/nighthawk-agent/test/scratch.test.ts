/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { findProgram, formatDuration, runPlan, scratchName, splitCommand } from '../src/core/scratch.ts';

describe('scratch files', () => {
	it('splits command lines, keeping quoted parts together', () => {
		assert.deepStrictEqual([
			splitCommand('uv run ${file}'),
			splitCommand('node --title="a b" \'x y\'  z'),
			splitCommand(''),
		], [
			['uv', 'run', '${file}'],
			['node', '--title=a b', 'x y', 'z'],
			[],
		]);
	});

	it('runs a file with its setting, its #! line, or its language', () => {
		const plan = (file: string, firstLine = '', platform: NodeJS.Platform = 'linux', configured?: Record<string, string>) => runPlan(file, firstLine, { platform, configured, out: '/tmp/out' });
		assert.deepStrictEqual([
			plan('/s/My File.py'),
			plan('/s/a.py', '', 'win32'),
			plan('/s/a.rs'),
			plan('/s/a.py', '', 'linux', { py: 'uv run ${file}' }),
			plan('/s/a.js', '#!/usr/bin/env -S deno run --allow-read'),
			plan('/s/a.js', '#!/usr/bin/env deno', 'win32'),
			plan('/s/a.unknown'),
		], [
			{ steps: [['python3', '/s/My File.py']], source: 'default' },
			{ steps: [['python', '/s/a.py']], source: 'default' },
			{ steps: [['rustc', '-o', '/tmp/out', '/s/a.rs'], ['/tmp/out']], source: 'default' },
			{ steps: [['uv', 'run', '/s/a.py']], source: 'setting' },
			{ steps: [['deno', 'run', '--allow-read', '/s/a.js']], source: 'shebang' },
			{ steps: [['node', '/s/a.js']], source: 'default' },
			undefined,
		]);
	});

	it('finds programs on PATH, with PATHEXT on Windows', async () => {
		const files = new Set(['/usr/bin/python3', 'C:\\Python\\python.exe']);
		const exists = async (file: string) => files.has(file);
		assert.deepStrictEqual([
			await findProgram('python3', { PATH: '/bin:/usr/bin' }, 'linux', exists),
			await findProgram('python', { PATH: '/bin:/usr/bin' }, 'linux', exists),
			await findProgram('python', { Path: 'C:\\Windows;C:\\Python', PATHEXT: '.COM;.EXE' }, 'win32', exists),
			await findProgram('/usr/bin/python3', {}, 'linux', exists),
		], ['/usr/bin/python3', undefined, 'C:\\Python\\python.exe', '/usr/bin/python3']);
	});

	it('names new files and run times', () => {
		assert.deepStrictEqual([
			scratchName('py', new Set()),
			scratchName('py', new Set(['scratch.py', 'scratch-2.py', 'scratch.js'])),
			formatDuration(420),
			formatDuration(12_345),
		], ['scratch.py', 'scratch-3.py', '0.42 s', '12.3 s']);
	});
});
