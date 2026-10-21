/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { MemoryFile, type Memory, type MemoryScope } from '../core/memories';
import type { MemoryChange } from '../core/tools';

/**
 * The agent's memories: facts about the user, kept for every project, and
 * about this workspace. Saved in the extension's storage, never in the
 * project, so they are not committed.
 */
export class Memories implements vscode.Disposable {
	private readonly files: Record<MemoryScope, MemoryFile>;
	private readonly changed = new vscode.EventEmitter<void>();
	readonly onDidChange = this.changed.event;
	private readonly disposables: vscode.Disposable[] = [this.changed];

	constructor(storage: vscode.Uri, workspaceKey: string) {
		const dir = vscode.Uri.joinPath(storage, 'memories');
		this.files = {
			user: new MemoryFile(vscode.Uri.joinPath(dir, 'user.json').fsPath, 'user'),
			project: new MemoryFile(vscode.Uri.joinPath(dir, `project-${workspaceKey}.json`).fsPath, 'project'),
		};
		// Another window may save memories too.
		const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(dir, '*.json'));
		const reload = () => {
			this.files.user.reload();
			this.files.project.reload();
			this.changed.fire();
		};
		this.disposables.push(watcher, watcher.onDidChange(reload), watcher.onDidCreate(reload), watcher.onDidDelete(reload));
	}

	dispose(): void {
		this.disposables.forEach(d => d.dispose());
	}

	enabled(): boolean {
		return vscode.workspace.getConfiguration('nighthawk.agent').get<boolean>('memories', true);
	}

	/** User memories first, then the project's, oldest first. */
	async list(): Promise<Memory[]> {
		return [...await this.files.user.list(), ...await this.files.project.list()];
	}

	private async find(id: string): Promise<MemoryFile | undefined> {
		for (const file of [this.files.project, this.files.user]) {
			if ((await file.list()).some(m => m.id === id)) {
				return file;
			}
		}
		return undefined;
	}

	/** Runs the agent's Memory tool call and says what happened. */
	async apply(change: MemoryChange, source?: string): Promise<string> {
		if (change.action === 'save') {
			const memory = await this.files[change.scope].add(change.text, source);
			this.changed.fire();
			return change.scope === 'user' ? `Remembered for all projects [${memory.id}]: ${memory.text}` : `Remembered for this project [${memory.id}]: ${memory.text}`;
		}
		const file = await this.find(change.id);
		if (!file) {
			return `There is no memory ${change.id}. The Memories section of your instructions lists the ids.`;
		}
		if (change.action === 'delete') {
			await file.remove(change.id);
			this.changed.fire();
			return `Forgot memory ${change.id}.`;
		}
		const memory = await file.update(change.id, change.text);
		this.changed.fire();
		return `Updated memory ${change.id}: ${memory?.text ?? change.text}`;
	}

	/** Lists the memories to edit or delete them, add one, or turn memories off. */
	async manage(): Promise<void> {
		type Item = vscode.QuickPickItem & { memory?: Memory; run?: () => Thenable<unknown> };
		const edit: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('edit'), tooltip: vscode.l10n.t('Edit') };
		const remove: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('trash'), tooltip: vscode.l10n.t('Forget') };
		const pick = vscode.window.createQuickPick<Item>();
		pick.title = vscode.l10n.t('Agent Memories');
		pick.placeholder = vscode.l10n.t('Facts the agent saved and reads in every conversation. Edit or forget any of them.');
		pick.matchOnDetail = true;
		const render = async () => {
			const memories = await this.list();
			const section = (scope: MemoryScope): Item[] => {
				const own = memories.filter(m => m.scope === scope).reverse();
				return own.length ? [
					{ label: scope === 'user' ? vscode.l10n.t('About you (all projects)') : vscode.l10n.t('About this project'), kind: vscode.QuickPickItemKind.Separator },
					...own.map<Item>(memory => ({
						label: memory.text,
						description: new Date(memory.updated).toLocaleDateString(),
						detail: memory.source ? vscode.l10n.t('From "{0}"', memory.source) : undefined,
						memory,
						buttons: [edit, remove],
					})),
				] : [];
			};
			pick.items = [
				...section('project'),
				...section('user'),
				{ label: '', kind: vscode.QuickPickItemKind.Separator },
				{ label: `$(add) ${vscode.l10n.t('Add a Memory...')}`, alwaysShow: true, run: () => this.addByHand() },
				...(memories.length ? [{ label: `$(clear-all) ${vscode.l10n.t('Forget All Project Memories')}`, alwaysShow: true, run: () => this.clear('project') }] : []),
				{
					label: this.enabled() ? `$(circle-slash) ${vscode.l10n.t('Turn Off Memories')}` : `$(lightbulb) ${vscode.l10n.t('Turn On Memories')}`,
					detail: this.enabled() ? vscode.l10n.t('The agent stops reading and saving memories. Saved ones are kept.') : undefined,
					alwaysShow: true,
					run: () => vscode.workspace.getConfiguration('nighthawk.agent').update('memories', !this.enabled(), vscode.ConfigurationTarget.Global),
				},
			];
		};
		await render();
		pick.onDidTriggerItemButton(async e => {
			const memory = e.item.memory;
			if (!memory) {
				return;
			}
			if (e.button === remove) {
				await this.files[memory.scope].remove(memory.id);
			} else {
				pick.hide();
				const text = await vscode.window.showInputBox({ title: vscode.l10n.t('Edit Memory'), value: memory.text, ignoreFocusOut: true });
				if (text?.trim()) {
					await this.files[memory.scope].update(memory.id, text);
				}
			}
			this.changed.fire();
			await render();
		});
		pick.onDidAccept(async () => {
			const item = pick.selectedItems[0];
			pick.hide();
			if (item?.run) {
				await item.run();
			} else if (item?.memory) {
				const text = await vscode.window.showInputBox({ title: vscode.l10n.t('Edit Memory'), value: item.memory.text, ignoreFocusOut: true });
				if (text?.trim()) {
					await this.files[item.memory.scope].update(item.memory.id, text);
					this.changed.fire();
				}
			}
		});
		pick.onDidHide(() => pick.dispose());
		pick.show();
	}

	private async addByHand(): Promise<void> {
		const text = await vscode.window.showInputBox({
			title: vscode.l10n.t('Add a Memory'),
			placeHolder: vscode.l10n.t('A fact for the agent to keep in mind, like "run tests with pnpm test"'),
			ignoreFocusOut: true,
		});
		if (!text?.trim()) {
			return;
		}
		const scope = await vscode.window.showQuickPick([
			{ label: vscode.l10n.t('This project'), scope: 'project' as const },
			{ label: vscode.l10n.t('All projects'), description: vscode.l10n.t('About you, like a preference'), scope: 'user' as const },
		], { title: vscode.l10n.t('Remember It For') });
		if (scope) {
			await this.files[scope.scope].add(text);
			this.changed.fire();
		}
	}

	private async clear(scope: MemoryScope): Promise<void> {
		const yes = vscode.l10n.t('Forget All');
		if (await vscode.window.showWarningMessage(vscode.l10n.t('Forget every memory about this project?'), { modal: true }, yes) === yes) {
			await this.files[scope].clear();
			this.changed.fire();
		}
	}
}
