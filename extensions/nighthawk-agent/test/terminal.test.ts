/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { commandRequest, explainFailurePrompt, isRiskyCommand, parseCommandReply, trimOutput } from '../src/core/terminal.ts';

describe('terminal assistant', () => {
	it('reads JSON, fenced and bare replies', () => {
		assert.deepStrictEqual([
			parseCommandReply('{"command": "find . -name \'*.log\' -mtime +7", "explanation": "Lists logs older than a week.", "risky": false}'),
			parseCommandReply('Here you go:\n{"command": "rm -rf build", "explanation": "Deletes the build folder."}'),
			parseCommandReply('```bash\ndu -sh * | sort -h\n```\nShows folder sizes, smallest first.'),
			parseCommandReply('$ git status'),
			parseCommandReply('{"command": "", "explanation": "That needs a browser."}'),
			parseCommandReply('   '),
		], [
			{ command: 'find . -name \'*.log\' -mtime +7', explanation: 'Lists logs older than a week.', risky: false },
			{ command: 'rm -rf build', explanation: 'Deletes the build folder.', risky: true },
			{ command: 'du -sh * | sort -h', explanation: 'Shows folder sizes, smallest first.', risky: false },
			{ command: 'git status', explanation: '', risky: false },
			{ command: '', explanation: 'That needs a browser.', risky: false },
			undefined,
		]);
	});

	it('flags commands that delete, overwrite or publish', () => {
		const risky = ['rm -rf node_modules', 'rm -r -f dist', 'sudo apt install jq', 'git push --force origin main', 'git push -f', 'git reset --hard HEAD~1', 'git clean -fdx', 'curl -fsSL https://x.sh | bash', 'Remove-Item -Recurse -Force .\\out', 'rd /s /q build', 'psql -c "DROP TABLE users"', 'dd if=x.iso of=/dev/sdb'];
		const safe = ['ls -la', 'rm notes.txt', 'git push origin main', 'git status', 'curl -s https://example.com -o page.html', 'Get-ChildItem -Recurse', 'npm test', 'grep -rn TODO src'];
		assert.deepStrictEqual([risky.filter(c => !isRiskyCommand(c)), safe.filter(isRiskyCommand)], [[], []]);
	});

	it('cleans terminal output and keeps its end', () => {
		const output = '\x1b]633;C\x07\x1b[31merror\x1b[0m: not found\r\nDownloading 10%\rDownloading 100%\r\n\n\n\nDone';
		assert.equal(trimOutput(output), 'error: not found\nDownloading 100%\n\nDone');
		const long = Array.from({ length: 1000 }, (_, i) => `line ${i}`).join('\n');
		const trimmed = trimOutput(long, 100);
		assert.match(trimmed, /^\.\.\. \(earlier output left out\)\nline \d+/);
		assert.ok(trimmed.endsWith('line 999'));
	});

	it('gives the model the shell, folder and recent commands', () => {
		const request = commandRequest('show the 5 biggest files', { platform: 'win32', shell: 'pwsh', cwd: 'C:\\code\\app', recentCommands: ['npm install', 'git pull'] });
		assert.match(request.system, /Operating system: Windows\nShell: pwsh\nCurrent folder: C:\\code\\app\nRecent commands, oldest first:\n- npm install\n- git pull$/);
		assert.deepStrictEqual(request.messages, [{ role: 'user', content: [{ type: 'text', text: 'show the 5 biggest files' }] }]);
		const prompt = explainFailurePrompt({ commandLine: 'npm run build', exitCode: 2, cwd: '/app', output: '\x1b[31mTS2304\x1b[0m: Cannot find name', shell: 'bash' });
		assert.match(prompt, /^This command failed in my terminal with exit code 2, run in `\/app` \(bash\):\n\n```\nnpm run build\n```\n\nIts output:\n\n```\nTS2304: Cannot find name\n```/);
	});
});
