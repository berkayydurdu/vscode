/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHash } from 'node:crypto';
import * as vscode from 'vscode';
import type { PermissionMode } from './core/permissions';
import { AgentViewProvider, DiffContentProvider, openAgentPanel, type ControllerHost } from './host/agentView';
import { Autocomplete } from './host/autocomplete';
import { BackgroundAgents } from './host/background';
import type { BackgroundTask } from './core/background';
import { Endpoints, type QuickSetup } from './host/endpoints';
import { chooseReviewTarget, generateCommitMessage } from './host/git';
import { InlineEditController } from './host/inlineEdit';
import { branchReviewPrompt } from './core/commit';
import { Checkpoints } from './host/checkpoints';
import { CodebaseIndexer } from './host/codeIndex';
import { McpManager } from './host/mcpManager';
import { SessionStore } from './host/session';
import { TerminalAssistant } from './host/terminal';
import { UsageMeter } from './host/usage';
import { UsagePanel } from './host/usageView';

function workspaceKey(): string {
	const folders = (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.toString()).sort().join('|');
	return folders ? createHash('sha256').update(folders).digest('hex').slice(0, 16) : 'no-folder';
}

export function activate(context: vscode.ExtensionContext): void {
	const endpoints = new Endpoints(context);
	const mcp = new McpManager(context);
	const diffs = DiffContentProvider.register();
	const usage = new UsageMeter(context, () => !!endpoints.current());
	const codeIndex = new CodebaseIndexer(context, endpoints, usage, workspaceKey());
	const host: ControllerHost = {
		context,
		endpoints,
		mcp,
		usage,
		codeIndex,
		checkpoints: new Checkpoints(context.globalStorageUri),
		store: new SessionStore(context.globalStorageUri, workspaceKey()),
		diffs: diffs.provider,
	};
	const view = new AgentViewProvider(host);
	const background = new BackgroundAgents(host);
	host.liveSession = id => background.live(id);
	const terminal = new TerminalAssistant(endpoints, usage, async (shown, prompt) => {
		const controller = await view.show();
		controller.startNew();
		await controller.session.sendTask(shown, prompt);
	});
	const inlineEdit = new InlineEditController(context, endpoints, usage);
	const autocomplete = new Autocomplete(endpoints, usage, () => inlineEdit.model());
	const task = (handler: (task: BackgroundTask) => unknown) => (task?: BackgroundTask) => task?.id ? handler(task) : undefined;

	const status = vscode.window.createStatusBarItem('nighthawk.agent.model', vscode.StatusBarAlignment.Right, 100);
	status.name = vscode.l10n.t('Agent Model');
	status.command = 'nighthawk.ai.selectModel';
	const updateStatus = () => {
		const current = endpoints.current();
		status.text = `$(sparkle) ${current?.model ?? vscode.l10n.t('Connect a model')}`;
		status.tooltip = current ? vscode.l10n.t('Agent model: {0} on {1}. Click to switch.', current.model, current.endpoint.name) : vscode.l10n.t('Set up a model endpoint for the agent');
		status.show();
	};
	updateStatus();

	context.subscriptions.push(
		endpoints, mcp, view, status, usage, codeIndex, background, terminal, inlineEdit, autocomplete, diffs.disposable,
		vscode.window.registerTreeDataProvider('nighthawk.agent.background', background),
		vscode.commands.registerCommand('nighthawk.agent.background.start', (prompt?: string) => background.start(typeof prompt === 'string' ? prompt : undefined)),
		vscode.commands.registerCommand('nighthawk.agent.background.open', task(t => background.open(t))),
		vscode.commands.registerCommand('nighthawk.agent.background.resume', task(t => background.resume(t))),
		vscode.commands.registerCommand('nighthawk.agent.background.review', task(t => background.review(t))),
		vscode.commands.registerCommand('nighthawk.agent.background.merge', task(t => background.merge(t))),
		vscode.commands.registerCommand('nighthawk.agent.background.openFolder', task(t => background.openFolder(t))),
		vscode.commands.registerCommand('nighthawk.agent.background.stop', task(t => background.stop(t))),
		vscode.commands.registerCommand('nighthawk.agent.background.discard', task(t => background.remove(t))),
		endpoints.onDidChange(updateStatus),
		endpoints.onDidChange(() => usage.refresh()),
		vscode.window.registerWebviewViewProvider(AgentViewProvider.viewId, view, { webviewOptions: { retainContextWhenHidden: true } }),
		vscode.commands.registerCommand('nighthawk.agent.open', async () => (await view.show()).focusInput()),
		vscode.commands.registerCommand('nighthawk.agent.openInEditor', () => openAgentPanel(host)),
		vscode.commands.registerCommand('nighthawk.agent.newSession', async () => {
			const controller = await view.show();
			controller.startNew();
			controller.focusInput();
		}),
		vscode.commands.registerCommand('nighthawk.agent.history', async () => (await view.show()).showHistory()),
		vscode.commands.registerCommand('nighthawk.agent.restoreCheckpoint', () => host.checkpoints.pickAndRestore((vscode.workspace.workspaceFolders ?? []).filter(f => f.uri.scheme === 'file').map(f => f.uri.fsPath))),
		vscode.commands.registerCommand('nighthawk.agent.undoRestore', async () => {
			if (!await host.checkpoints.undo()) {
				vscode.window.showInformationMessage(vscode.l10n.t('There is no checkpoint restore to undo.'));
			}
		}),
		vscode.commands.registerCommand('nighthawk.agent.addSelection', async () => {
			const editor = vscode.window.activeTextEditor;
			if (!editor) {
				return;
			}
			const rel = vscode.workspace.asRelativePath(editor.document.uri, (vscode.workspace.workspaceFolders?.length ?? 0) > 1);
			const ref = editor.selection.isEmpty
				? `@${rel}`
				: `@${rel}#L${editor.selection.start.line + 1}${editor.selection.end.line !== editor.selection.start.line ? `-${editor.selection.end.line + 1}` : ''}`;
			(await view.show()).prefill(`${ref} `);
		}),
		vscode.commands.registerCommand('nighthawk.agent.fixProblems', async (uri?: vscode.Uri) => {
			const target = uri ?? vscode.window.activeTextEditor?.document.uri;
			const rel = target ? vscode.workspace.asRelativePath(target) : undefined;
			const controller = await view.show();
			await controller.session.send(rel
				? `Fix the errors and warnings the Diagnostics tool reports for @${rel}, then check it again.`
				: 'Fix the errors the Diagnostics tool reports in this workspace, then check again.');
		}),
		vscode.commands.registerCommand('nighthawk.agent.setPermissionMode', async () => {
			const modes: { id: PermissionMode; label: string; detail: string }[] = [
				{ id: 'default', label: vscode.l10n.t('Ask before edits'), detail: vscode.l10n.t('Reads run freely; edits and commands ask first.') },
				{ id: 'acceptEdits', label: vscode.l10n.t('Auto-accept edits'), detail: vscode.l10n.t('Edits in the workspace run freely; commands ask first.') },
				{ id: 'plan', label: vscode.l10n.t('Plan'), detail: vscode.l10n.t('Read only: the agent researches and proposes a plan.') },
				{ id: 'bypassPermissions', label: vscode.l10n.t('Full auto'), detail: vscode.l10n.t('Everything runs without asking. Use with care.') },
			];
			const pick = await vscode.window.showQuickPick(modes, { title: vscode.l10n.t('Agent Permission Mode') });
			if (pick) {
				(await view.show()).session.setMode(pick.id);
			}
		}),
		vscode.commands.registerCommand('nighthawk.agent.restartMcp', async () => {
			await mcp.restart();
			vscode.window.showInformationMessage(vscode.l10n.t('MCP servers restarted.'));
		}),
		vscode.commands.registerCommand('nighthawk.ai.generateCommitMessage', (repository?: unknown) => generateCommitMessage(endpoints, usage, repository)),
		vscode.commands.registerCommand('nighthawk.ai.showUsage', () => UsagePanel.show(context, usage, async id => (await view.show()).open(id))),
		vscode.commands.registerCommand('nighthawk.ai.setMonthlyLimit', () => usage.editLimit()),
		vscode.commands.registerCommand('nighthawk.agent.reviewBranch', async (repository?: unknown) => {
			const target = await chooseReviewTarget(repository);
			if (!target) {
				return;
			}
			const controller = await view.show();
			controller.startNew();
			const shown = target.branch
				? vscode.l10n.t('Review the branch {0} against {1} before it is pushed.', target.branch, target.base)
				: vscode.l10n.t('Review this branch against {0} before it is pushed.', target.base);
			await controller.session.sendTask(shown, branchReviewPrompt(target.base, target.branch));
		}),
		vscode.commands.registerCommand('nighthawk.inlineEdit.start', () => inlineEdit.start()),
		vscode.commands.registerCommand('nighthawk.inlineEdit.accept', (uri?: vscode.Uri) => inlineEdit.acceptAll(uri)),
		vscode.commands.registerCommand('nighthawk.inlineEdit.reject', (uri?: vscode.Uri) => inlineEdit.rejectAll(uri)),
		vscode.commands.registerCommand('nighthawk.inlineEdit.acceptChange', (uri: vscode.Uri, id: number) => inlineEdit.acceptHunk(uri, id)),
		vscode.commands.registerCommand('nighthawk.inlineEdit.rejectChange', (uri: vscode.Uri, id: number) => inlineEdit.rejectHunk(uri, id)),
		vscode.commands.registerCommand('nighthawk.inlineEdit.cancel', () => inlineEdit.cancel()),
		vscode.commands.registerCommand('nighthawk.inlineEdit.selectModel', () => inlineEdit.pickModel()),
		vscode.commands.registerCommand('nighthawk.autocomplete.menu', () => autocomplete.menu()),
		vscode.commands.registerCommand('nighthawk.autocomplete.toggle', () => autocomplete.toggle()),
		vscode.commands.registerCommand('nighthawk.autocomplete.selectModel', () => autocomplete.pickModel()),
		vscode.commands.registerCommand('nighthawk.index.search', (query?: unknown) => codeIndex.searchCommand(typeof query === 'string' ? query : undefined)),
		vscode.commands.registerCommand('nighthawk.index.menu', () => codeIndex.menu()),
		vscode.commands.registerCommand('nighthawk.index.rebuild', () => codeIndex.rebuild()),
		vscode.commands.registerCommand('nighthawk.index.selectEmbeddingModel', () => codeIndex.pickEmbeddingModel()),
		vscode.commands.registerCommand('nighthawk.terminal.askForCommand', (ask?: unknown) => terminal.askForCommand(typeof ask === 'string' ? ask : undefined)),
		vscode.commands.registerCommand('nighthawk.terminal.explainError', (argument?: { commandLine?: string; output?: string }) => terminal.explainError(argument)),
		vscode.commands.registerCommand('nighthawk.ai.addEndpoint', (setup?: QuickSetup) => setup?.preset ? endpoints.quickSetup(setup) : endpoints.add()),
		vscode.commands.registerCommand('nighthawk.ai.selectModel', () => endpoints.pickModel()),
		vscode.commands.registerCommand('nighthawk.ai.setApiKey', () => endpoints.setKey()),
		vscode.commands.registerCommand('nighthawk.ai.removeEndpoint', () => endpoints.remove()),
		vscode.commands.registerCommand('nighthawk.ai.manageEndpoints', () => endpoints.manage()),
	);
}

export function deactivate(): void { }
