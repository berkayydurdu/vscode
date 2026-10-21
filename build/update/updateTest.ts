/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// End-to-end test of updates from GitHub Releases, against a local server that pretends to be
// the GitHub API. It lowers the build number of an installed build so that the same build looks
// like a newer release, then checks what the running app does with it:
//
// - win32 (user setup): the app downloads the installer, installs it in the background and,
//   after "Restart to Update", the installer swaps the files and starts the app again.
// - linux (archive): the app offers the update with a link to the release page.
//
// Usage:
//   node build/update/updateTest.ts win32 <NighthawkUserSetup-x64.exe> <screenshot dir>
//   node build/update/updateTest.ts linux <VSCode-linux-x64 folder> <screenshot dir>

import { spawn, spawnSync } from 'child_process';
import { createHash } from 'crypto';
import fs from 'fs';
import http from 'http';
import type { AddressInfo } from 'net';
import os from 'os';
import path from 'path';
import { _electron } from 'playwright-core';

const [platform, target, screenshotDir] = process.argv.slice(2);
if (!['win32', 'linux'].includes(platform) || !target || !screenshotDir) {
	console.error('usage: node build/update/updateTest.ts <win32|linux> <installer or app folder> <screenshot dir>');
	process.exit(2);
}
fs.mkdirSync(screenshotDir, { recursive: true });

const log = (...args: unknown[]) => console.log(`[${new Date().toISOString()}]`, ...args);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor<T>(what: string, check: () => T | Promise<T>, timeoutMs: number): Promise<T> {
	const end = Date.now() + timeoutMs;
	while (Date.now() < end) {
		const value = await check();
		if (value) {
			return value;
		}
		await sleep(1000);
	}
	throw new Error(`Timed out waiting for ${what}`);
}

// --- the app under test ---------------------------------------------------------------

let appDir: string;
if (platform === 'win32') {
	log('Installing', target);
	const installLog = path.join(os.tmpdir(), 'nighthawk-install.log');
	const result = spawnSync(target, ['/verysilent', '/mergetasks=!runcode', `/log=${installLog}`], { stdio: 'inherit' });
	if (result.status !== 0) {
		throw new Error(`Installer exited with ${result.status}`);
	}
	appDir = path.join(process.env['LOCALAPPDATA'] ?? '', 'Programs', 'Nighthawk');
} else {
	appDir = target;
}

const productPath = path.join(appDir, 'resources', 'app', 'product.json');
const product = JSON.parse(fs.readFileSync(productPath, 'utf8'));
const releasedBuild = product.buildNumber;
if (!releasedBuild || !product.releaseUpdates) {
	throw new Error('The build has no buildNumber or releaseUpdates in product.json');
}

// --- a fake GitHub API with one newer release -------------------------------------------

const assetName = product.releaseUpdates.assets[platform === 'win32' ? 'win32-x64-user' : 'linux-x64'];
const assetPath = platform === 'win32' ? target : undefined;
const tag = `v${product.version}-build.${releasedBuild}`;
const requests: string[] = [];

const server = http.createServer((req, res) => {
	const request = `${req.method} ${req.url} (${req.headers['user-agent']})`.replace(/\n|\r/g, '');
	requests.push(request);
	log('server:', request);
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	if (req.url?.startsWith('/releases?')) {
		const digest = assetPath ? `sha256:${createHash('sha256').update(fs.readFileSync(assetPath)).digest('hex')}` : null;
		res.setHeader('Content-Type', 'application/json');
		res.end(JSON.stringify([{
			tag_name: tag,
			target_commitish: 'f'.repeat(40),
			html_url: `${base}/release-page/${tag}`,
			draft: false,
			prerelease: false,
			published_at: new Date().toISOString(),
			assets: [{ name: assetName, browser_download_url: `${base}/download/${assetName}`, digest }],
		}]));
	} else if (assetPath && req.url === `/download/${assetName}`) {
		res.setHeader('Content-Length', fs.statSync(assetPath).size);
		fs.createReadStream(assetPath).pipe(res);
	} else {
		res.statusCode = 404;
		res.end();
	}
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
const port = (server.address() as AddressInfo).port;

// Make the installed build one older than the "release" and point it at the fake API.
fs.writeFileSync(productPath, JSON.stringify({
	...product,
	buildNumber: releasedBuild - 1,
	releaseUpdates: { ...product.releaseUpdates, url: `http://127.0.0.1:${port}/releases` },
}, null, '\t'));
log(`Installed build now reports ${releasedBuild - 1}; the fake release is ${tag}`);

// --- run the app ------------------------------------------------------------------------

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nh-update-ud-'));
fs.mkdirSync(path.join(userDataDir, 'User'), { recursive: true });
fs.writeFileSync(path.join(userDataDir, 'User', 'settings.json'), JSON.stringify({
	'workbench.startupEditor': 'none',
	'workbench.welcomePage.experimentalOnboarding': false,
	'security.workspace.trust.enabled': false,
}));

const executablePath = platform === 'win32' ? path.join(appDir, 'Nighthawk.exe') : path.join(appDir, 'nighthawk');
log('Launching', executablePath);
const app = await _electron.launch({
	executablePath,
	args: [`--user-data-dir=${userDataDir}`, '--password-store=basic', '--disable-workspace-trust'],
	env: { ...process.env, VSCODE_SKIP_PRELAUNCH: '1' },
	timeout: 120_000,
});
const window = await app.firstWindow({ timeout: 120_000 });
await window.waitForSelector('.monaco-workbench', { timeout: 120_000 });
log('Workbench is up');

function mainLog(): string {
	const logsDir = path.join(userDataDir, 'logs');
	const found: string[] = [];
	const walk = (dir: string) => {
		for (const entry of fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : []) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				walk(full);
			} else if (entry.name === 'main.log') {
				found.push(fs.readFileSync(full, 'utf8'));
			}
		}
	};
	walk(logsDir);
	return found.join('\n');
}

async function runCommand(title: string) {
	await window.keyboard.press('F1');
	await window.waitForSelector('.quick-input-widget input', { timeout: 10_000 });
	await window.keyboard.type(title);
	await sleep(1500);
	await window.keyboard.press('Enter');
}

try {
	// Nothing to click: the first automatic check runs 30 seconds after startup.
	if (platform === 'linux') {
		await waitFor('the update to be offered', () => mainLog().includes('update#setState available for download'), 3 * 60_000);
		await sleep(2000);
		await window.screenshot({ path: path.join(screenshotDir, 'update-linux-available.png') });
		log('Linux: update offered');
	} else {
		await waitFor('the update to be installed in the background', () => {
			const text = mainLog();
			if (/update#setState idle[\s\S]*error/i.test(text) && !text.includes('update#setState downloading')) {
				throw new Error(`Update check failed:\n${text}`);
			}
			return text.includes('update#setState ready');
		}, 20 * 60_000);
		await sleep(2000);
		await window.screenshot({ path: path.join(screenshotDir, 'update-win32-ready.png') });
		log('Windows: update ready, restarting');

		await runCommand('Nighthawk: Restart to Update');
		await waitFor('the app to quit', async () => {
			try {
				await window.title();
				return false;
			} catch {
				return true;
			}
		}, 120_000);

		// The installer swaps in the new files and starts the app again.
		await waitFor('the update to be applied', () => {
			const updated = JSON.parse(fs.readFileSync(productPath, 'utf8'));
			return updated.buildNumber === releasedBuild && !fs.existsSync(path.join(appDir, '_'));
		}, 10 * 60_000);
		log('Windows: new files in place');

		await waitFor('the app to start again', () => {
			const tasks = spawnSync('tasklist', ['/FI', 'IMAGENAME eq Nighthawk.exe', '/FO', 'CSV', '/NH'], { encoding: 'utf8' }).stdout;
			return tasks.includes('Nighthawk.exe');
		}, 5 * 60_000);
		log('Windows: app restarted after the update');
	}

	const apiRequest = requests.find(r => r.startsWith('GET /releases?per_page=20'));
	if (!apiRequest) {
		throw new Error(`The app never asked for the releases:\n${requests.join('\n')}`);
	}
	log('PASS');
} catch (error) {
	console.error(error);
	console.error('--- requests ---\n' + requests.join('\n'));
	console.error('--- main.log ---\n' + mainLog());
	await window.screenshot({ path: path.join(screenshotDir, 'failure.png') }).catch(() => { });
	process.exitCode = 1;
} finally {
	await app.close().catch(() => { });
	if (platform === 'win32') {
		spawn('taskkill', ['/F', '/IM', 'Nighthawk.exe'], { stdio: 'ignore' });
	}
	server.close();
	setTimeout(() => process.exit(), 3000).unref();
}
