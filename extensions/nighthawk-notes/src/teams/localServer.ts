/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import * as vscode from 'vscode';

/** Starts a notes server when a request finds none, see `NotesClient`. */
export interface ServerStarter {
	ensureRunning(serverUrl: string): Promise<boolean>;
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);

/**
 * Runs the bundled notes server on this machine, so teams work out of the box
 * while the server address is still the default localhost one. The server
 * runs on Nighthawk's own Node and keeps its data in the extension's global
 * storage. It stops with the window that started it; another window starts
 * it again when it next needs it.
 */
export class LocalServer implements ServerStarter, vscode.Disposable {

	private child: ChildProcess | undefined;
	private starting: Promise<boolean> | undefined;
	private readonly log: vscode.LogOutputChannel;

	constructor(private readonly context: vscode.ExtensionContext) {
		this.log = vscode.window.createOutputChannel(vscode.l10n.t('Nighthawk Notes Server'), { log: true });
	}

	/** Whether the address points at this machine, where the bundled server can run. */
	static isLocal(serverUrl: string): boolean {
		try {
			const url = new URL(serverUrl);
			return url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname);
		} catch {
			return false;
		}
	}

	/**
	 * Starts the bundled server for a local address unless one already
	 * answers there. Resolves to whether a server is now reachable.
	 */
	ensureRunning(serverUrl: string): Promise<boolean> {
		if (!LocalServer.isLocal(serverUrl)) {
			return Promise.resolve(false);
		}
		if (!this.starting) {
			this.starting = this.start(serverUrl).finally(() => this.starting = undefined);
		}
		return this.starting;
	}

	private async start(serverUrl: string): Promise<boolean> {
		if (await isUp(serverUrl)) {
			return true;
		}
		const script = await this.serverScript();
		if (!script) {
			this.log.error('The bundled notes server is missing from this build.');
			return false;
		}
		const url = new URL(serverUrl);
		const dataDir = path.join(this.context.globalStorageUri.fsPath, 'server');
		await vscode.workspace.fs.createDirectory(vscode.Uri.file(dataDir));
		this.log.info(`Starting the notes server on ${url.origin} with data in ${dataDir}`);

		const child = spawn(process.execPath, [script], {
			env: {
				...process.env,
				ELECTRON_RUN_AS_NODE: '1',
				HOST: '127.0.0.1',
				PORT: url.port || '80',
				NOTES_DB: path.join(dataDir, 'notes.db'),
				PUBLIC_URL: url.origin,
			},
			stdio: ['ignore', 'pipe', 'pipe'],
			windowsHide: true,
		});
		this.child = child;
		child.stdout?.on('data', data => this.log.info(String(data).trim()));
		child.stderr?.on('data', data => this.log.error(String(data).trim()));
		let exited = false;
		child.on('error', err => this.log.error(err.message));
		child.on('exit', code => {
			exited = true;
			this.log.info(`The notes server stopped (exit code ${code}).`);
			if (this.child === child) {
				this.child = undefined;
			}
		});

		for (let waited = 0; waited < 10_000 && !exited; waited += 200) {
			if (await isUp(serverUrl)) {
				return true;
			}
			await new Promise(resolve => setTimeout(resolve, 200));
		}
		// Another window may have won the race for the port.
		return isUp(serverUrl);
	}

	private async serverScript(): Promise<string | undefined> {
		const candidates = [
			// Release builds bundle the server next to the extension.
			this.context.asAbsolutePath(path.join('dist', 'server.js')),
			// Running from source.
			path.join(this.context.extensionPath, '..', '..', 'notes-server', 'src', 'main.ts'),
		];
		for (const candidate of candidates) {
			try {
				await vscode.workspace.fs.stat(vscode.Uri.file(candidate));
				return candidate;
			} catch {
				// Try the next location.
			}
		}
		return undefined;
	}

	dispose(): void {
		this.child?.kill();
		this.child = undefined;
		this.log.dispose();
	}
}

async function isUp(serverUrl: string): Promise<boolean> {
	try {
		const response = await fetch(`${serverUrl}/api/info`, { signal: AbortSignal.timeout(2000) });
		return JSON.parse(await response.text())?.name === 'Nighthawk Notes';
	} catch {
		return false;
	}
}
