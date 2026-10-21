/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { hostname } from 'node:os';
import { applyEdits, modify, parse, type ParseError } from 'jsonc-parser';
import * as vscode from 'vscode';
import { canonical, isIgnored, MACHINE_SETTINGS, mergeLists, mergeMaps, parseContent, SYNC_RESOURCES, type SyncResourceName } from './core/settingsSync';
import type { Account } from './teams/account';
import { NotesServerError } from './teams/client';

const STATE_KEY = 'nighthawk.notes.settingsSync';
const SYNC_EVERY_MS = 5 * 60_000;
const CHANGE_DELAY_MS = 3000;

/** A synced resource as the server keeps it. */
interface RemoteResource {
	resource: string;
	content: string;
	version: number;
	updatedAt: number;
	machine: string;
}

/** What this computer last agreed on with the server, per account. */
interface AccountState {
	versions: Partial<Record<SyncResourceName, number>>;
	/** Content of each resource after the last sync, the base for merging. */
	base: Partial<Record<SyncResourceName, string>>;
	lastSync?: number;
}

interface State {
	enabled: boolean;
	resources: SyncResourceName[];
	/** Keyed by server and user, so switching accounts starts over. */
	accounts: Record<string, AccountState>;
}

interface Summary {
	changedHere: number;
	conflicts: string[];
}

/**
 * Keeps settings, keyboard shortcuts, snippets and extensions the same on
 * all of a person's computers, through the notes server they sign in to.
 * API keys stay in each computer's keychain and are never synced.
 */
export class SettingsSync implements vscode.Disposable {
	private state: State;
	private readonly userDir: vscode.Uri;
	private readonly log = vscode.window.createOutputChannel(vscode.l10n.t('Nighthawk Settings Sync'), { log: true });
	private readonly status = vscode.window.createStatusBarItem('nighthawk.notes.settingsSync', vscode.StatusBarAlignment.Right, 50);
	private readonly disposables: vscode.Disposable[] = [this.log, this.status];
	private running: Promise<Summary | undefined> | undefined;
	private again = false;
	private changeTimer: ReturnType<typeof setTimeout> | undefined;
	/** Set while this class writes the user's files, so its own writes don't start another sync. */
	private writing = 0;

	constructor(private readonly context: vscode.ExtensionContext, private readonly account: Account) {
		this.state = context.globalState.get<State>(STATE_KEY) ?? { enabled: false, resources: [...SYNC_RESOURCES], accounts: {} };
		// Global storage sits in the profile's folder, next to its settings.json.
		this.userDir = vscode.Uri.joinPath(context.globalStorageUri, '..', '..');
		this.status.name = vscode.l10n.t('Settings Sync');
		this.status.command = 'nighthawk.notes.sync.showLog';
		const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(this.userDir, '{settings.json,keybindings.json,snippets/*}'));
		const changed = () => this.onLocalChange();
		const timer = setInterval(() => this.sync(), SYNC_EVERY_MS);
		this.disposables.push(
			watcher, watcher.onDidChange(changed), watcher.onDidCreate(changed), watcher.onDidDelete(changed),
			vscode.extensions.onDidChange(changed),
			account.onDidChange(() => this.sync()),
			{ dispose: () => clearInterval(timer) },
			{ dispose: () => clearTimeout(this.changeTimer) },
		);
		vscode.commands.executeCommand('setContext', 'nighthawk.notes.settingsSyncOn', this.state.enabled);
		this.sync();
	}

	dispose(): void {
		this.disposables.forEach(d => d.dispose());
	}

	get enabled(): boolean {
		return this.state.enabled;
	}

	private async save(): Promise<void> {
		await this.context.globalState.update(STATE_KEY, this.state);
		await vscode.commands.executeCommand('setContext', 'nighthawk.notes.settingsSyncOn', this.state.enabled);
	}

	private accountKey(): string | undefined {
		return this.account.user && `${this.account.client.serverUrl}|${this.account.user.id}`;
	}

	private onLocalChange(): void {
		if (this.writing || !this.state.enabled) {
			return;
		}
		clearTimeout(this.changeTimer);
		this.changeTimer = setTimeout(() => this.sync(), CHANGE_DELAY_MS);
	}

	/** Asks what to sync, then syncs, signing in first if needed. */
	async turnOn(): Promise<void> {
		if (!this.account.user) {
			await vscode.commands.executeCommand('nighthawk.notes.teams.signIn');
			if (!this.account.user) {
				return;
			}
		}
		const labels: Record<SyncResourceName, string> = {
			settings: vscode.l10n.t('Settings'),
			keybindings: vscode.l10n.t('Keyboard Shortcuts'),
			snippets: vscode.l10n.t('Snippets'),
			extensions: vscode.l10n.t('Extensions'),
		};
		const picks = await vscode.window.showQuickPick(SYNC_RESOURCES.map(resource => ({ label: labels[resource], resource, picked: this.state.resources.includes(resource) })), {
			canPickMany: true,
			title: vscode.l10n.t('Settings Sync'),
			placeHolder: vscode.l10n.t('Choose what to keep the same on all your computers, through {0}', this.account.client.serverUrl),
		});
		if (!picks?.length) {
			return;
		}
		this.state.enabled = true;
		this.state.resources = picks.map(pick => pick.resource);
		await this.save();
		const summary = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Turning on Settings Sync...') }, () => this.sync());
		if (summary) {
			vscode.window.showInformationMessage(summary.changedHere
				? vscode.l10n.t('Settings Sync is on. {0} changes from your other computers were applied here.', summary.changedHere)
				: vscode.l10n.t('Settings Sync is on. Your other computers get these settings when they turn it on too.'));
		}
	}

	async turnOff(): Promise<void> {
		const turnOff = vscode.l10n.t('Turn Off');
		const deleteData = vscode.l10n.t('Turn Off and Delete Synced Data');
		const pick = await vscode.window.showInformationMessage(vscode.l10n.t('Turn off Settings Sync on this computer?'), {
			modal: true,
			detail: vscode.l10n.t('Your settings stay as they are here. Deleting the synced data removes it from the notes server for all your computers.'),
		}, turnOff, deleteData);
		if (!pick) {
			return;
		}
		if (pick === deleteData && this.account.user) {
			await this.account.client.call('DELETE', '/api/me/sync');
			this.state.accounts = {};
		}
		this.state.enabled = false;
		await this.save();
		this.status.hide();
		this.log.info(pick === deleteData ? 'Turned off and deleted the synced data' : 'Turned off');
	}

	showLog(): void {
		this.log.show();
	}

	/** Syncs now, or once more after a sync already running. */
	sync(): Promise<Summary | undefined> {
		if (!this.state.enabled || !this.account.user) {
			return Promise.resolve(undefined);
		}
		if (this.running) {
			this.again = true;
			return this.running;
		}
		this.running = this.syncAll().finally(() => {
			this.running = undefined;
			if (this.again) {
				this.again = false;
				this.sync();
			}
		});
		return this.running;
	}

	private async syncAll(): Promise<Summary | undefined> {
		const key = this.accountKey();
		if (!key) {
			return undefined;
		}
		const accountState = this.state.accounts[key] ??= { versions: {}, base: {} };
		const summary: Summary = { changedHere: 0, conflicts: [] };
		this.status.text = `$(sync~spin) ${vscode.l10n.t('Syncing Settings')}`;
		this.status.tooltip = undefined;
		this.status.backgroundColor = undefined;
		const shown = setTimeout(() => this.status.show(), 500);
		try {
			for (let attempt = 0; ; attempt++) {
				try {
					const { resources } = await this.account.client.call<{ resources: RemoteResource[] }>('GET', '/api/me/sync');
					for (const name of this.state.resources) {
						const result = await this.syncResource(name, resources.find(r => r.resource === name), accountState);
						summary.changedHere += result.changedHere;
						summary.conflicts.push(...result.conflicts);
					}
					break;
				} catch (err) {
					// Another computer synced at the same moment: merge with its data.
					if (!(err instanceof NotesServerError && err.status === 409) || attempt >= 2) {
						throw err;
					}
				}
			}
			accountState.lastSync = Date.now();
			await this.save();
			this.status.hide();
			if (summary.changedHere || summary.conflicts.length) {
				this.log.info(`Synced: ${summary.changedHere} changes applied here${summary.conflicts.length ? `, changed on both sides: ${summary.conflicts.join(', ')}` : ''}`);
			}
			return summary;
		} catch (err) {
			this.log.error(`Sync failed: ${err.message}`);
			this.status.text = `$(sync-ignored) ${vscode.l10n.t('Settings Sync')}`;
			this.status.tooltip = vscode.l10n.t('Settings Sync failed: {0}. It tries again in a few minutes; click to see the log.', err.message);
			this.status.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
			this.status.show();
			return undefined;
		} finally {
			clearTimeout(shown);
		}
	}

	private async syncResource(name: SyncResourceName, remote: RemoteResource | undefined, accountState: AccountState): Promise<Summary> {
		// Without data on the server, any base is stale (it was deleted): start over.
		const baseContent = remote ? accountState.base[name] : undefined;
		let merged: unknown;
		/** What to remember as agreed, when it differs from what was merged. */
		let agreed: unknown;
		let remoteValue: unknown;
		let summary: Summary;
		switch (name) {
			case 'settings': {
				const local = await this.readSettings();
				remoteValue = parseContent<Record<string, unknown>>(remote?.content) ?? {};
				const result = mergeMaps(parseContent<Record<string, unknown>>(baseContent), local, remoteValue as Record<string, unknown>);
				merged = result.merged;
				summary = { changedHere: await this.writeSettings(local, result.merged), conflicts: result.conflicts.map(key => vscode.l10n.t('setting {0}', key)) };
				break;
			}
			case 'keybindings': {
				const local = await this.readJson<unknown[]>('keybindings.json', []);
				remoteValue = parseContent<unknown[]>(remote?.content) ?? [];
				merged = mergeLists(parseContent<unknown[]>(baseContent), local, remoteValue as unknown[]);
				summary = { changedHere: await this.writeKeybindings(local, merged as unknown[]), conflicts: [] };
				break;
			}
			case 'snippets': {
				const local = await this.readSnippets();
				remoteValue = parseContent<Record<string, string>>(remote?.content) ?? {};
				const result = mergeMaps(parseContent<Record<string, string>>(baseContent), local, remoteValue as Record<string, string>);
				merged = result.merged;
				summary = { changedHere: await this.writeSnippets(local, result.merged), conflicts: result.conflicts.map(file => vscode.l10n.t('snippets {0}', file)) };
				break;
			}
			case 'extensions': {
				const local = this.installedExtensions();
				remoteValue = parseContent<string[]>(remote?.content) ?? [];
				const list = mergeLists(parseContent<string[]>(baseContent), local, remoteValue as string[], id => id.toLowerCase());
				const result = await this.applyExtensions(local, list);
				merged = list;
				// An extension that failed to install here is not "removed here"
				// next time, and one that failed to uninstall is not "added".
				agreed = [...list.filter(id => !result.notInstalled.includes(id)), ...result.notUninstalled];
				summary = { changedHere: result.changed, conflicts: [] };
				break;
			}
		}
		const content = canonical(merged);
		let version = remote?.version ?? 0;
		if (!remote || canonical(remoteValue) !== content) {
			const saved = await this.account.client.call<{ resource: RemoteResource }>('PUT', `/api/me/sync/${name}`, { baseVersion: version, content, machine: hostname() });
			version = saved.resource.version;
			this.log.info(`Uploaded ${name} (version ${version})`);
		}
		accountState.base[name] = agreed === undefined ? content : canonical(agreed);
		accountState.versions[name] = version;
		return summary;
	}

	// --- settings.json

	private ignoredSettings(): string[] {
		return [...MACHINE_SETTINGS, ...vscode.workspace.getConfiguration('settingsSync').get<string[]>('ignoredSettings', [])];
	}

	private async readText(path: string): Promise<string | undefined> {
		try {
			return new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(this.userDir, path)));
		} catch {
			return undefined;
		}
	}

	private async writeText(path: string, text: string | undefined): Promise<void> {
		const uri = vscode.Uri.joinPath(this.userDir, path);
		this.writing++;
		try {
			if (text === undefined) {
				await vscode.workspace.fs.delete(uri);
			} else {
				await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(text));
			}
		} finally {
			// Let the file watcher report the change before listening again.
			setTimeout(() => this.writing--, 1000);
		}
	}

	private async readJson<T>(path: string, fallback: T): Promise<T> {
		const text = await this.readText(path);
		if (!text?.trim()) {
			return fallback;
		}
		const errors: ParseError[] = [];
		const value = parse(text, errors, { allowTrailingComma: true });
		if (errors.length) {
			throw new Error(vscode.l10n.t('{0} has errors; fix them so it can be synced', path));
		}
		return value ?? fallback;
	}

	/** The person's own settings, without the ones that stay on this computer. */
	private async readSettings(): Promise<Record<string, unknown>> {
		const all = await this.readJson<Record<string, unknown>>('settings.json', {});
		const ignored = this.ignoredSettings();
		return Object.fromEntries(Object.entries(all).filter(([key]) => !isIgnored(key, ignored)));
	}

	/** Writes changed settings into settings.json, keeping its comments and layout. Returns how many changed. */
	private async writeSettings(local: Record<string, unknown>, merged: Record<string, unknown>): Promise<number> {
		const keys = [...new Set([...Object.keys(local), ...Object.keys(merged)])].filter(key => canonical(local[key]) !== canonical(merged[key]));
		if (!keys.length) {
			return 0;
		}
		const existing = await this.readText('settings.json');
		let text = existing?.trim() ? existing : '{\n}';
		// Indent the way the file already is.
		const indent = /^(?<indent>[ \t]+)\S/m.exec(text)?.groups?.indent ?? '\t';
		const formattingOptions = { insertSpaces: indent[0] === ' ', tabSize: indent[0] === ' ' ? indent.length : 4, eol: text.includes('\r\n') ? '\r\n' : '\n' };
		for (const key of keys) {
			text = applyEdits(text, modify(text, [key], merged[key], { formattingOptions }));
			this.log.info(`Setting ${key}: ${merged[key] === undefined ? 'removed' : 'updated'} from another computer`);
		}
		await this.writeText('settings.json', text);
		return keys.length;
	}

	// --- keybindings.json

	private async writeKeybindings(local: unknown[], merged: unknown[]): Promise<number> {
		if (canonical(local) === canonical(merged)) {
			return 0;
		}
		const header = '// Place your key bindings in this file to override the defaults\n';
		await this.writeText('keybindings.json', header + JSON.stringify(merged, undefined, '\t') + '\n');
		this.log.info(`Keyboard shortcuts updated from another computer (${merged.length} in all)`);
		return 1;
	}

	// --- snippets

	private async readSnippets(): Promise<Record<string, string>> {
		const result: Record<string, string> = {};
		let entries: [string, vscode.FileType][] = [];
		try {
			entries = await vscode.workspace.fs.readDirectory(vscode.Uri.joinPath(this.userDir, 'snippets'));
		} catch {
			return result;
		}
		for (const [name, type] of entries) {
			if (type === vscode.FileType.File && /\.(json|code-snippets)$/.test(name)) {
				result[name] = await this.readText(`snippets/${name}`) ?? '';
			}
		}
		return result;
	}

	private async writeSnippets(local: Record<string, string>, merged: Record<string, string>): Promise<number> {
		let changed = 0;
		for (const name of new Set([...Object.keys(local), ...Object.keys(merged)])) {
			if (local[name] !== merged[name] && !/[\\/]|^\.\.?$/.test(name)) {
				await this.writeText(`snippets/${name}`, merged[name]);
				this.log.info(`Snippets ${name}: ${merged[name] === undefined ? 'removed' : 'updated'} from another computer`);
				changed++;
			}
		}
		return changed;
	}

	// --- extensions

	/** Extensions the person installed, not the ones Nighthawk comes with. */
	private installedExtensions(): string[] {
		const ignored = vscode.workspace.getConfiguration('settingsSync').get<string[]>('ignoredExtensions', []).map(id => id.toLowerCase());
		return vscode.extensions.all
			.filter(extension => !extension.packageJSON.isBuiltin && !extension.id.startsWith('vscode.') && !ignored.includes(extension.id.toLowerCase()))
			.map(extension => extension.id);
	}

	private async applyExtensions(local: string[], merged: string[]): Promise<{ changed: number; notInstalled: string[]; notUninstalled: string[] }> {
		const has = (list: string[], id: string) => list.some(other => other.toLowerCase() === id.toLowerCase());
		const notInstalled: string[] = [];
		const notUninstalled: string[] = [];
		let changed = 0;
		for (const id of merged.filter(id => !has(local, id))) {
			try {
				await vscode.commands.executeCommand('workbench.extensions.installExtension', id);
				this.log.info(`Installed extension ${id}, as on another computer`);
				changed++;
			} catch (err) {
				this.log.warn(`Could not install extension ${id}: ${err.message}`);
				notInstalled.push(id);
			}
		}
		for (const id of local.filter(id => !has(merged, id))) {
			try {
				await vscode.commands.executeCommand('workbench.extensions.uninstallExtension', id);
				this.log.info(`Uninstalled extension ${id}, as on another computer`);
				changed++;
			} catch (err) {
				this.log.warn(`Could not uninstall extension ${id}: ${err.message}`);
				notUninstalled.push(id);
			}
		}
		return { changed, notInstalled, notUninstalled };
	}
}
