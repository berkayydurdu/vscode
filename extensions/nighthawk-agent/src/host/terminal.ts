/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path';
import * as vscode from 'vscode';
import { modelStream } from '../core/providers';
import { commandRequest, explainFailurePrompt, parseCommandReply, type CommandFailure, type SuggestedCommand, type TerminalContext } from '../core/terminal';
import type { Endpoints } from './endpoints';
import { isBudgetError, type UsageMeter } from './usage';

/** Output kept while a command runs; only its end is sent to the model. */
const MAX_TRACKED_OUTPUT = 32_000;
const MAX_RECENT_COMMANDS = 10;
const FAILURE_CONTEXT_KEY = 'nighthawk.terminal.hasFailure';

/** A command running in a terminal, with the output read so far. */
interface Running {
	terminal: vscode.Terminal;
	output: string;
	done: Promise<void>;
}

/** A command to explain: the command line and the lines of output the terminal matched. */
interface QuickFixArgument {
	commandLine?: string;
	output?: string;
}

/**
 * The terminal assistant: turns a request in plain English into a command,
 * and has the agent explain commands that failed. It follows commands
 * through shell integration to know each terminal's shell, folder, recent
 * commands and last failure.
 */
export class TerminalAssistant implements vscode.Disposable {
	private readonly disposables: vscode.Disposable[] = [];
	private readonly running = new Map<vscode.TerminalShellExecution, Running>();
	private readonly recent = new Map<vscode.Terminal, string[]>();
	private readonly failures = new Map<vscode.Terminal, CommandFailure>();
	private lastQuickFix: QuickFixArgument | undefined;

	constructor(
		private readonly endpoints: Endpoints,
		private readonly usage: UsageMeter,
		private readonly explain: (shown: string, prompt: string) => Promise<void>,
	) {
		this.disposables.push(
			vscode.window.onDidStartTerminalShellExecution(e => this.started(e)),
			vscode.window.onDidEndTerminalShellExecution(e => this.ended(e)),
			vscode.window.onDidChangeActiveTerminal(() => this.updateContext()),
			vscode.window.onDidCloseTerminal(terminal => {
				this.recent.delete(terminal);
				this.failures.delete(terminal);
				this.updateContext();
			}),
			vscode.window.registerTerminalQuickFixProvider('nighthawk.agent.explainError', {
				provideTerminalQuickFixes: match => {
					// A command stopped with Ctrl+C did not fail on its own.
					if (match.commandLine.endsWith('^C')) {
						return [];
					}
					// Quick fixes run their command without arguments, so the match is kept for it.
					this.lastQuickFix = { commandLine: match.commandLine, output: match.outputMatch?.outputLines.join('\n') };
					return [{ command: 'nighthawk.terminal.explainError', title: vscode.l10n.t('Explain with the Agent') }];
				},
			}),
		);
	}

	private started(e: vscode.TerminalShellExecutionStartEvent): void {
		const record: Running = { terminal: e.terminal, output: '', done: Promise.resolve() };
		record.done = (async () => {
			try {
				for await (const chunk of e.execution.read()) {
					record.output += chunk;
					if (record.output.length > MAX_TRACKED_OUTPUT * 2) {
						record.output = record.output.slice(-MAX_TRACKED_OUTPUT);
					}
				}
			} catch {
				// The terminal was closed while the command ran.
			}
		})();
		this.running.set(e.execution, record);
	}

	private async ended(e: vscode.TerminalShellExecutionEndEvent): Promise<void> {
		const record = this.running.get(e.execution);
		this.running.delete(e.execution);
		const commandLine = e.execution.commandLine.value.trim();
		if (!commandLine) {
			return;
		}
		const recent = this.recent.get(e.terminal) ?? [];
		recent.push(commandLine);
		this.recent.set(e.terminal, recent.slice(-MAX_RECENT_COMMANDS));
		if (e.exitCode === undefined || e.exitCode === 0) {
			this.failures.delete(e.terminal);
		} else {
			// The output stream can finish just after the end event.
			await Promise.race([record?.done, new Promise(resolve => setTimeout(resolve, 500))]);
			this.failures.set(e.terminal, {
				commandLine,
				exitCode: e.exitCode,
				cwd: e.execution.cwd?.fsPath,
				output: (record?.output ?? '').slice(-MAX_TRACKED_OUTPUT),
				shell: e.terminal.state.shell,
			});
		}
		this.updateContext();
	}

	private updateContext(): void {
		const terminal = vscode.window.activeTerminal;
		vscode.commands.executeCommand('setContext', FAILURE_CONTEXT_KEY, !!terminal && this.failures.has(terminal));
	}

	private contextOf(terminal: vscode.Terminal | undefined): TerminalContext {
		const shellPath = vscode.env.shell;
		return {
			platform: process.platform,
			shell: terminal?.state.shell ?? (shellPath ? path.basename(shellPath).replace(/\.exe$/i, '') : process.platform === 'win32' ? 'pwsh' : 'bash'),
			cwd: terminal?.shellIntegration?.cwd?.fsPath ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
			recentCommands: terminal ? this.recent.get(terminal) ?? [] : [],
		};
	}

	/** Asks what to do in plain English, then offers the command the model suggests. */
	async askForCommand(initial?: string): Promise<void> {
		const choice = this.endpoints.current();
		if (!choice) {
			const add = vscode.l10n.t('Add Model Endpoint');
			if (await vscode.window.showInformationMessage(vscode.l10n.t('Connect a model to get terminal commands from plain English.'), add) === add) {
				await vscode.commands.executeCommand('nighthawk.ai.addEndpoint');
			}
			return;
		}
		let ask = initial;
		for (; ;) {
			ask = await vscode.window.showInputBox({
				title: vscode.l10n.t('Ask for a Terminal Command'),
				prompt: vscode.l10n.t('Describe what you want to do, for example "find files over 100 MB" or "undo my last commit but keep the changes".'),
				value: ask,
				ignoreFocusOut: true,
			});
			if (!ask?.trim()) {
				return;
			}
			const terminal = vscode.window.activeTerminal;
			const suggestion = await this.suggest(ask.trim(), terminal);
			if (!suggestion) {
				return;
			}
			if (!suggestion.command) {
				vscode.window.showInformationMessage(suggestion.explanation || vscode.l10n.t('The model did not suggest a command for that.'));
				continue;
			}
			if (await this.offer(suggestion, terminal) !== 'again') {
				return;
			}
		}
	}

	private async suggest(ask: string, terminal: vscode.Terminal | undefined): Promise<SuggestedCommand | undefined> {
		const choice = this.endpoints.current();
		if (!choice) {
			return undefined;
		}
		const key = await this.endpoints.apiKey(choice.endpoint);
		const stream = this.usage.track(modelStream(choice.endpoint, choice.model, key, { thinking: false }), { endpoint: choice.endpoint, model: choice.model, feature: 'terminal' });
		const request = commandRequest(ask, this.contextOf(terminal));
		return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Writing a command...'), cancellable: true }, async (_progress, token) => {
			const abort = new AbortController();
			const cancel = token.onCancellationRequested(() => abort.abort());
			let text = '';
			try {
				for await (const event of stream(request, abort.signal)) {
					if (event.type === 'text') {
						text += event.text;
					}
				}
				const suggestion = parseCommandReply(text);
				if (!suggestion) {
					vscode.window.showErrorMessage(vscode.l10n.t('The model did not answer with a command.'));
				}
				return suggestion;
			} catch (err) {
				if (isBudgetError(err)) {
					await this.usage.offerToRaiseLimit(err);
				} else if (!abort.signal.aborted) {
					vscode.window.showErrorMessage(vscode.l10n.t('Could not get a command: {0}', err.message ?? String(err)));
				}
				return undefined;
			} finally {
				cancel.dispose();
			}
		});
	}

	/** Shows the suggested command with what it does, and runs, inserts or copies it. */
	private async offer(suggestion: SuggestedCommand, terminal: vscode.Terminal | undefined): Promise<'again' | undefined> {
		type Action = 'run' | 'insert' | 'copy' | 'again';
		const items: (vscode.QuickPickItem & { action: Action })[] = [
			{
				action: 'run',
				label: `$(play) ${vscode.l10n.t('Run')}`,
				description: suggestion.risky ? vscode.l10n.t('asks first: this command can delete or change things') : undefined,
			},
			{ action: 'insert', label: `$(insert) ${vscode.l10n.t('Insert Without Running')}`, description: vscode.l10n.t('to edit it first') },
			{ action: 'copy', label: `$(copy) ${vscode.l10n.t('Copy')}` },
			{ action: 'again', label: `$(edit) ${vscode.l10n.t('Change the Request')}` },
		];
		const quickPick = vscode.window.createQuickPick<typeof items[number]>();
		quickPick.title = suggestion.command;
		// The prompt wraps, unlike the placeholder, so the whole explanation shows.
		quickPick.prompt = suggestion.explanation;
		quickPick.placeholder = vscode.l10n.t('What should happen with this command?');
		quickPick.items = items;
		quickPick.ignoreFocusOut = true;
		const pick = await new Promise<typeof items[number] | undefined>(resolve => {
			quickPick.onDidAccept(() => resolve(quickPick.selectedItems[0]));
			quickPick.onDidHide(() => resolve(undefined));
			quickPick.show();
		});
		quickPick.dispose();
		switch (pick?.action) {
			case 'run': {
				if (suggestion.risky) {
					const run = vscode.l10n.t('Run');
					const confirmed = await vscode.window.showWarningMessage(
						vscode.l10n.t('Run this command?'),
						{ modal: true, detail: vscode.l10n.t('{0}\n\nIt can delete or change files, history or settings. {1}', suggestion.command, suggestion.explanation) },
						run,
					);
					if (confirmed !== run) {
						return undefined;
					}
				}
				const target = terminal ?? vscode.window.createTerminal();
				target.show();
				if (target.shellIntegration) {
					target.shellIntegration.executeCommand(suggestion.command);
				} else {
					target.sendText(suggestion.command, true);
				}
				return undefined;
			}
			case 'insert': {
				const target = terminal ?? vscode.window.createTerminal();
				target.show();
				target.sendText(suggestion.command, false);
				return undefined;
			}
			case 'copy':
				await vscode.env.clipboard.writeText(suggestion.command);
				return undefined;
			case 'again':
				return 'again';
			default:
				return undefined;
		}
	}

	/** Has the agent explain why the last command failed, in the agent panel. */
	async explainError(argument: QuickFixArgument | undefined = this.lastQuickFix): Promise<void> {
		this.lastQuickFix = undefined;
		const terminal = vscode.window.activeTerminal;
		const tracked = terminal ? this.failures.get(terminal) : undefined;
		let failure: CommandFailure | undefined = tracked;
		// The quick fix names the command it was shown for; its own output lines are used when shell integration missed it.
		const commandLine = typeof argument?.commandLine === 'string' ? argument.commandLine.trim() : '';
		if (commandLine && tracked?.commandLine !== commandLine) {
			failure = { commandLine, output: typeof argument?.output === 'string' ? argument.output : '', shell: terminal?.state.shell };
		}
		if (!failure) {
			vscode.window.showInformationMessage(vscode.l10n.t('No failed command to explain in this terminal. Run the command again with shell integration on, or use the lightbulb next to it.'));
			return;
		}
		await this.explain(vscode.l10n.t('Explain why `{0}` failed and how to fix it.', failure.commandLine), explainFailurePrompt(failure));
	}

	dispose(): void {
		this.disposables.forEach(d => d.dispose());
		this.running.clear();
	}
}
