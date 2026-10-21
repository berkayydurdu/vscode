/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path';
import * as vscode from 'vscode';
import { currentPhase, openTasks, parseSpecState, parseTasks, phaseOf, phasePrompt, revisePrompt, shownRequest, specFile, specSlug, SPECS_DIR, taskPrompt, titleFrom, type SpecInfo, type SpecPhase } from '../core/spec';
import type { AgentController } from './agentView';

interface Spec extends SpecInfo {
	/** The spec's folder. */
	uri: vscode.Uri;
	/** The workspace folder it belongs to. */
	root: vscode.WorkspaceFolder;
}

function phaseName(phase: SpecPhase): string {
	switch (phase) {
		case 'requirements': return vscode.l10n.t('requirements');
		case 'design': return vscode.l10n.t('design');
		case 'tasks': return vscode.l10n.t('tasks');
	}
}

/**
 * Spec mode: the agent writes requirements, a design and tasks in
 * .nighthawk/specs/<name>/, each approved with a button at the top of the
 * document, then does the tasks one at a time from buttons in tasks.md.
 */
export class Specs implements vscode.CodeLensProvider, vscode.Disposable {
	private readonly changed = new vscode.EventEmitter<void>();
	readonly onDidChangeCodeLenses = this.changed.event;
	private readonly disposables: vscode.Disposable[] = [this.changed];

	constructor(private readonly agent: () => Promise<AgentController>) {
		const watcher = vscode.workspace.createFileSystemWatcher(`**/${SPECS_DIR}/*/spec.json`);
		this.disposables.push(
			watcher,
			watcher.onDidChange(() => this.changed.fire()),
			watcher.onDidCreate(() => this.changed.fire()),
			watcher.onDidDelete(() => this.changed.fire()),
			vscode.languages.registerCodeLensProvider({ language: 'markdown', pattern: `**/${SPECS_DIR}/*/*.md` }, this),
		);
	}

	dispose(): void {
		this.disposables.forEach(d => d.dispose());
	}

	/** The spec a file in a spec folder belongs to. */
	private async specOf(uri: vscode.Uri): Promise<Spec | undefined> {
		const folder = vscode.Uri.joinPath(uri, '..');
		const root = vscode.workspace.getWorkspaceFolder(uri);
		if (!root) {
			return undefined;
		}
		const dir = path.posix.relative(root.uri.path, folder.path);
		if (path.posix.dirname(dir) !== SPECS_DIR) {
			return undefined;
		}
		return this.load(root, folder);
	}

	private async load(root: vscode.WorkspaceFolder, folder: vscode.Uri): Promise<Spec | undefined> {
		try {
			const state = parseSpecState(new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(folder, 'spec.json'))));
			return state && { uri: folder, root, dir: path.posix.relative(root.uri.path, folder.path), state };
		} catch {
			return undefined;
		}
	}

	private async save(spec: Spec): Promise<void> {
		await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(spec.uri, 'spec.json'), new TextEncoder().encode(`${JSON.stringify(spec.state, null, '\t')}\n`));
		this.changed.fire();
	}

	private async exists(uri: vscode.Uri): Promise<boolean> {
		try {
			await vscode.workspace.fs.stat(uri);
			return true;
		} catch {
			return false;
		}
	}

	/** Every spec in the workspace. */
	async list(): Promise<Spec[]> {
		const specs: Spec[] = [];
		for (const root of vscode.workspace.workspaceFolders ?? []) {
			const base = vscode.Uri.joinPath(root.uri, SPECS_DIR);
			let entries: [string, vscode.FileType][] = [];
			try {
				entries = await vscode.workspace.fs.readDirectory(base);
			} catch {
				continue;
			}
			for (const [name, type] of entries) {
				if (type === vscode.FileType.Directory) {
					const spec = await this.load(root, vscode.Uri.joinPath(base, name));
					if (spec) {
						specs.push(spec);
					}
				}
			}
		}
		return specs.sort((a, b) => b.state.created - a.state.created);
	}

	async provideCodeLenses(document: vscode.TextDocument): Promise<vscode.CodeLens[]> {
		const phase = phaseOf(document.uri.path);
		const spec = phase && await this.specOf(document.uri);
		if (!phase || !spec) {
			return [];
		}
		const top = new vscode.Range(0, 0, 0, 0);
		const lenses: vscode.CodeLens[] = [];
		const current = currentPhase(spec.state);
		if (spec.state.approved[phase]) {
			lenses.push(new vscode.CodeLens(top, { title: `$(check) ${vscode.l10n.t('Approved')}`, command: '' }));
		} else if (phase === current) {
			const next = phase === 'requirements' ? vscode.l10n.t('Approve and Write the Design') : phase === 'design' ? vscode.l10n.t('Approve and Write the Tasks') : vscode.l10n.t('Approve the Tasks');
			lenses.push(
				new vscode.CodeLens(top, { title: `$(check) ${next}`, command: 'nighthawk.spec.approve', arguments: [document.uri] }),
				new vscode.CodeLens(top, { title: `$(comment) ${vscode.l10n.t('Ask for Changes')}`, command: 'nighthawk.spec.revise', arguments: [document.uri] }),
			);
		} else if (current) {
			lenses.push(new vscode.CodeLens(top, { title: vscode.l10n.t('Waiting for the {0} to be approved', phaseName(current)), command: '' }));
		}
		if (phase === 'tasks' && !current) {
			const tasks = parseTasks(document.getText());
			const open = openTasks(tasks);
			const done = tasks.filter(t => t.done).length;
			lenses.push(new vscode.CodeLens(top, { title: vscode.l10n.t('{0} of {1} done', done, tasks.length), command: '' }));
			if (open.length) {
				lenses.push(new vscode.CodeLens(top, { title: `$(run-all) ${vscode.l10n.t('Run All Open Tasks')}`, command: 'nighthawk.spec.runAll', arguments: [document.uri] }));
			}
			for (const task of open) {
				lenses.push(new vscode.CodeLens(new vscode.Range(task.line, 0, task.line, 0), { title: `$(play) ${vscode.l10n.t('Start Task')}`, command: 'nighthawk.spec.runTask', arguments: [document.uri, task.line] }));
			}
		}
		return lenses;
	}

	/** Starts a spec from what the user wants built. */
	async create(request?: string): Promise<void> {
		const folders = vscode.workspace.workspaceFolders?.filter(f => f.uri.scheme === 'file') ?? [];
		if (!folders.length) {
			vscode.window.showWarningMessage(vscode.l10n.t('Open a folder first: specs are saved in it.'));
			return;
		}
		request ??= await vscode.window.showInputBox({
			title: vscode.l10n.t('New Spec'),
			prompt: vscode.l10n.t('The agent writes requirements, a design and tasks for you to approve, then builds it task by task.'),
			placeHolder: vscode.l10n.t('What should be built? For example: let users export their notes as PDF'),
			ignoreFocusOut: true,
		});
		if (!request?.trim()) {
			return;
		}
		const root = folders.length === 1 ? folders[0] : await vscode.window.showWorkspaceFolderPick({ placeHolder: vscode.l10n.t('Which folder is the spec for?') });
		if (!root) {
			return;
		}
		const title = titleFrom(request);
		const base = vscode.Uri.joinPath(root.uri, SPECS_DIR);
		let slug = specSlug(title);
		for (let n = 2; await this.exists(vscode.Uri.joinPath(base, slug)); n++) {
			slug = `${specSlug(title)}-${n}`;
		}
		const folder = vscode.Uri.joinPath(base, slug);
		await vscode.workspace.fs.createDirectory(folder);
		const spec: Spec = { uri: folder, root, dir: `${SPECS_DIR}/${slug}`, state: { title, request: request.trim(), created: Date.now(), approved: {} } };
		const controller = await this.agent();
		controller.startNew();
		spec.state.chat = controller.session.id;
		await this.save(spec);
		await this.send(controller, spec, shownRequest(title), phasePrompt(spec, 'requirements'), true);
	}

	/** Approves the document and has the agent write the next one. */
	async approve(uri: vscode.Uri): Promise<void> {
		const spec = await this.specOf(uri);
		const phase = phaseOf(uri.path);
		if (!spec || !phase || phase !== currentPhase(spec.state)) {
			return;
		}
		await vscode.workspace.textDocuments.find(d => d.uri.toString() === uri.toString())?.save();
		spec.state.approved[phase] = Date.now();
		await this.save(spec);
		if (phase === 'tasks') {
			vscode.window.showInformationMessage(vscode.l10n.t('Tasks approved. Start them one at a time with Start Task above each, or run them all.'));
			return;
		}
		const next: SpecPhase = phase === 'requirements' ? 'design' : 'tasks';
		const controller = await this.conversation(spec);
		await this.send(controller, spec, vscode.l10n.t('Approved the {0}. Write the {1}.', phaseName(phase), phaseName(next)), phasePrompt(spec, next), true);
	}

	/** Asks what to change in the document and has the agent revise it. */
	async revise(uri: vscode.Uri): Promise<void> {
		const spec = await this.specOf(uri);
		const phase = phaseOf(uri.path);
		if (!spec || !phase) {
			return;
		}
		const feedback = await vscode.window.showInputBox({
			title: vscode.l10n.t('Ask for Changes to the {0}', phaseName(phase)),
			placeHolder: vscode.l10n.t('What should change? You can also edit the document yourself.'),
			ignoreFocusOut: true,
		});
		if (!feedback?.trim()) {
			return;
		}
		await vscode.workspace.textDocuments.find(d => d.uri.toString() === uri.toString())?.save();
		const controller = await this.conversation(spec);
		await this.send(controller, spec, feedback.trim(), revisePrompt(spec, phase, feedback.trim()), true);
	}

	/** Has the agent do one task of tasks.md, or every open one when `line` is undefined. */
	async runTask(uri: vscode.Uri, line?: number): Promise<void> {
		const spec = await this.specOf(uri);
		if (!spec || currentPhase(spec.state)) {
			return;
		}
		const document = await vscode.workspace.openTextDocument(uri);
		await document.save();
		const task = line === undefined ? undefined : parseTasks(document.getText()).find(t => t.line === line);
		if (line !== undefined && !task) {
			return;
		}
		const controller = await this.conversation(spec);
		const shown = task
			? vscode.l10n.t('Do task {0} of {1}: {2}', task.number, spec.state.title, task.title)
			: vscode.l10n.t('Do the open tasks of {0}', spec.state.title);
		await this.send(controller, spec, shown, taskPrompt(spec, task), false);
	}

	/** Lists the specs and opens the one picked, at the document it is at. */
	async open(): Promise<void> {
		const specs = await this.list();
		type Item = vscode.QuickPickItem & { spec?: Spec };
		const items: Item[] = [];
		for (const spec of specs) {
			const phase = currentPhase(spec.state);
			let detail = phase ? vscode.l10n.t('Writing the {0}', phaseName(phase)) : '';
			if (!phase) {
				try {
					const tasks = parseTasks(new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(spec.uri, specFile('tasks')))));
					const done = tasks.filter(t => t.done).length;
					detail = done === tasks.length ? vscode.l10n.t('All {0} tasks done', tasks.length) : vscode.l10n.t('{0} of {1} tasks done', done, tasks.length);
				} catch {
					detail = vscode.l10n.t('Tasks approved');
				}
			}
			items.push({ label: `$(checklist) ${spec.state.title}`, description: spec.dir, detail, spec });
		}
		items.push({ label: `$(add) ${vscode.l10n.t('New Spec...')}` });
		const pick = await vscode.window.showQuickPick(items, { title: vscode.l10n.t('Specs'), matchOnDescription: true });
		if (!pick) {
			return;
		}
		if (!pick.spec) {
			return this.create();
		}
		const phase = currentPhase(pick.spec.state) ?? 'tasks';
		const file = vscode.Uri.joinPath(pick.spec.uri, specFile(phase));
		if (await this.exists(file)) {
			await vscode.window.showTextDocument(file);
		} else {
			await this.conversation(pick.spec);
		}
	}

	/** The spec's conversation, opened in the agent; a new one when it is gone. */
	private async conversation(spec: Spec): Promise<AgentController> {
		const controller = await this.agent();
		if (spec.state.chat && controller.session.id !== spec.state.chat) {
			if (await controller.openIfSaved(spec.state.chat)) {
				return controller;
			}
		}
		if (controller.session.id !== spec.state.chat) {
			controller.startNew();
			spec.state.chat = controller.session.id;
			await this.save(spec);
		}
		return controller;
	}

	private async send(controller: AgentController, spec: Spec, shown: string, prompt: string, writing: boolean): Promise<void> {
		if (controller.session.mode === 'plan') {
			controller.session.setMode('default');
		}
		await controller.session.sendTask(shown, prompt, { specFolder: writing ? spec.uri.fsPath : undefined });
		if (writing) {
			const phase = currentPhase(spec.state);
			const file = phase && vscode.Uri.joinPath(spec.uri, specFile(phase));
			if (file && await this.exists(file)) {
				await vscode.window.showTextDocument(file, { preview: false });
			}
		}
	}
}
