/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { CompletionCache, cleanCompletion, completionRequest, isSensitiveFile, parseCompletion, replacesLineSuffix, shouldComplete, type CompletionTarget } from '../core/autocomplete';
import { modelStream } from '../core/providers';
import type { Endpoints, ModelChoice } from './endpoints';
import { isBudgetError, type UsageMeter } from './usage';

const SECTION = 'nighthawk.autocomplete';
/** After a failed request, typing does not ask again for this long. Asking with Alt+\ still does. */
const ERROR_PAUSE_MS = 30_000;
const REQUEST_TIMEOUT_MS = 20_000;

type Status = 'idle' | 'loading' | 'error' | 'limit';

interface Pending {
	document: string;
	target: CompletionTarget;
	done: Promise<void>;
}

/**
 * AI autocomplete: grey suggestions in the editor while typing, written by
 * one of the user's model endpoints and accepted with Tab.
 */
export class Autocomplete implements vscode.InlineCompletionItemProvider, vscode.Disposable {
	private readonly cache = new CompletionCache();
	private readonly pending = new Set<Pending>();
	private readonly item = vscode.window.createStatusBarItem('nighthawk.autocomplete', vscode.StatusBarAlignment.Right, 99);
	private readonly disposables: vscode.Disposable[] = [this.item];
	private status: Status = 'idle';
	private lastError = '';
	private pausedUntil = 0;

	constructor(
		private readonly endpoints: Endpoints,
		private readonly usage: UsageMeter,
		/** The inline edit model, used when autocomplete has no model of its own. */
		private readonly inlineEditModel: () => ModelChoice | undefined,
	) {
		this.item.name = vscode.l10n.t('Autocomplete');
		this.item.command = 'nighthawk.autocomplete.menu';
		this.disposables.push(
			vscode.languages.registerInlineCompletionItemProvider(
				[{ scheme: 'file' }, { scheme: 'untitled' }, { scheme: 'vscode-notebook-cell' }, { scheme: 'vscode-remote' }],
				this,
			),
			vscode.window.onDidChangeActiveTextEditor(() => this.render()),
			vscode.workspace.onDidChangeConfiguration(e => {
				if (e.affectsConfiguration(SECTION) || e.affectsConfiguration('nighthawk.inlineEdit.model')) {
					this.cache.clear();
					this.pausedUntil = 0;
					this.render();
				}
			}),
			endpoints.onDidChange(() => {
				this.cache.clear();
				this.pausedUntil = 0;
				this.render();
			}),
			usage.onDidChange(() => {
				if (this.status === 'limit') {
					this.setStatus('idle');
				}
			}),
		);
		this.render();
	}

	private config(): vscode.WorkspaceConfiguration {
		return vscode.workspace.getConfiguration(SECTION);
	}

	private enabled(): boolean {
		return this.config().get<boolean>('enabled', true);
	}

	private disabledLanguages(): string[] {
		return this.config().get<string[]>('disabledLanguages', []);
	}

	/** The model for autocomplete: `nighthawk.autocomplete.model`, else the inline edit model, else the agent's. */
	model(): ModelChoice | undefined {
		return this.endpoints.resolve(this.config().get<string>('model') ?? '') ?? this.inlineEditModel();
	}

	private enabledFor(document: vscode.TextDocument): boolean {
		return this.enabled() && !this.disabledLanguages().includes(document.languageId) && !isSensitiveFile(document.uri.path);
	}

	async provideInlineCompletionItems(document: vscode.TextDocument, position: vscode.Position, context: vscode.InlineCompletionContext, token: vscode.CancellationToken): Promise<vscode.InlineCompletionItem[] | undefined> {
		const invoked = context.triggerKind === vscode.InlineCompletionTriggerKind.Invoke;
		if (!this.enabledFor(document) || !this.model()) {
			return undefined;
		}
		const offset = document.offsetAt(position);
		const text = document.getText();
		// While the suggestion list is open, the suggestion goes on from the item it selected.
		const selected = context.selectedCompletionInfo;
		const start = selected ? selected.range.start : position;
		if (selected && !selected.range.end.isEqual(position)) {
			return undefined;
		}
		const editor = vscode.window.visibleTextEditors.find(e => e.document === document);
		const target: CompletionTarget = {
			path: vscode.workspace.asRelativePath(document.uri, (vscode.workspace.workspaceFolders?.length ?? 0) > 1),
			languageId: document.languageId,
			prefix: text.slice(0, document.offsetAt(start)) + (selected?.text ?? ''),
			suffix: text.slice(offset),
			indent: editor && typeof editor.options.tabSize === 'number'
				? { insertSpaces: editor.options.insertSpaces !== false, tabSize: editor.options.tabSize }
				: undefined,
		};
		if (!shouldComplete(target)) {
			return undefined;
		}
		const key = document.uri.toString();
		const answer = (completion: string | undefined) => token.isCancellationRequested || !completion
			? undefined
			: this.items(document, start, position, (selected?.text ?? '') + completion, replacesLineSuffix(completion, target));
		const known = this.cache.find(key, target);
		if (known !== undefined) {
			return answer(known);
		}
		if (!invoked) {
			if (Date.now() < this.pausedUntil) {
				return undefined;
			}
			// Waits until typing pauses, so not every key press sends a request.
			const delay = Math.max(0, this.config().get<number>('delay', 300));
			if (await this.wait(delay, token)) {
				return undefined;
			}
		}
		// A request sent a moment ago may already answer this, once the user typed its start.
		for (const pending of [...this.pending]) {
			if (pending.document === key && target.prefix.startsWith(pending.target.prefix) && target.prefix.length - pending.target.prefix.length < 200) {
				await pending.done;
				const answered = this.cache.find(key, target);
				if (answered !== undefined) {
					return answer(answered);
				}
			}
		}
		if (token.isCancellationRequested) {
			return undefined;
		}
		await this.request(key, target);
		return answer(this.cache.find(key, target));
	}

	/** The suggestion, replacing from `start`, and up to the end of the line when it writes the rest of the line again. */
	private items(document: vscode.TextDocument, start: vscode.Position, position: vscode.Position, text: string, toLineEnd: boolean): vscode.InlineCompletionItem[] {
		const end = toLineEnd ? document.lineAt(position.line).range.end : position;
		return [new vscode.InlineCompletionItem(text, new vscode.Range(start, end))];
	}

	/** Resolves to true when cancelled before the time is up. */
	private wait(ms: number, token: vscode.CancellationToken): Promise<boolean> {
		if (token.isCancellationRequested) {
			return Promise.resolve(true);
		}
		return new Promise(resolve => {
			const timer = setTimeout(() => {
				listener.dispose();
				resolve(false);
			}, ms);
			const listener = token.onCancellationRequested(() => {
				clearTimeout(timer);
				listener.dispose();
				resolve(true);
			});
		});
	}

	/**
	 * Asks the model and caches what it suggests. A sent request is not
	 * stopped when the user types on: its answer often still fits, and only
	 * finished requests report the tokens the usage meter counts.
	 */
	private request(key: string, target: CompletionTarget): Promise<void> {
		const choice = this.model();
		if (!choice) {
			return Promise.resolve();
		}
		const pending: Pending = { document: key, target, done: Promise.resolve() };
		pending.done = (async () => {
			this.setStatus('loading');
			try {
				const apiKey = await this.endpoints.apiKey(choice.endpoint);
				const stream = this.usage.track(modelStream(choice.endpoint, choice.model, apiKey, { thinking: false }), { endpoint: choice.endpoint, model: choice.model, feature: 'autocomplete' });
				let reply = '';
				for await (const event of stream(completionRequest(target), AbortSignal.timeout(REQUEST_TIMEOUT_MS))) {
					if (event.type === 'text') {
						reply += event.text;
					}
				}
				this.cache.add(key, target, cleanCompletion(parseCompletion(reply), target));
				this.lastError = '';
				this.pausedUntil = 0;
				this.pending.delete(pending);
				this.setStatus(this.pending.size ? 'loading' : 'idle');
			} catch (err) {
				this.pending.delete(pending);
				if (isBudgetError(err)) {
					this.setStatus('limit');
				} else {
					this.lastError = err instanceof Error ? err.message : String(err);
					this.pausedUntil = Date.now() + ERROR_PAUSE_MS;
					this.setStatus('error');
				}
			}
		})();
		this.pending.add(pending);
		return pending.done;
	}

	private setStatus(status: Status): void {
		this.status = status;
		this.render();
	}

	private render(): void {
		const choice = this.model();
		if (!choice) {
			this.item.hide();
			return;
		}
		const language = vscode.window.activeTextEditor?.document.languageId;
		const off = !this.enabled() || (!!language && this.disabledLanguages().includes(language));
		const label = vscode.l10n.t('Autocomplete');
		if (off) {
			this.item.text = `$(circle-slash) ${label}`;
			this.item.tooltip = !this.enabled()
				? vscode.l10n.t('Autocomplete is off. Click to turn it on.')
				: vscode.l10n.t('Autocomplete is off for {0}. Click to turn it on.', language ?? '');
			this.item.backgroundColor = undefined;
		} else if (this.status === 'loading') {
			this.item.text = `$(loading~spin) ${label}`;
			this.item.tooltip = vscode.l10n.t('Getting a suggestion from {0}...', choice.model);
			this.item.backgroundColor = undefined;
		} else if (this.status === 'error') {
			this.item.text = `$(warning) ${label}`;
			this.item.tooltip = vscode.l10n.t('The last suggestion failed: {0}', this.lastError);
			this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
		} else if (this.status === 'limit') {
			this.item.text = `$(warning) ${label}`;
			this.item.tooltip = vscode.l10n.t('Paused: you reached your monthly AI limit.');
			this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
		} else {
			this.item.text = `$(sparkle) ${label}`;
			this.item.tooltip = vscode.l10n.t('Autocomplete with {0} on {1}. Tab accepts a suggestion, Ctrl+Right one word of it.', choice.model, choice.endpoint.name);
			this.item.backgroundColor = undefined;
		}
		this.item.show();
	}

	async toggle(): Promise<void> {
		await this.config().update('enabled', !this.enabled(), vscode.ConfigurationTarget.Global);
	}

	private async toggleLanguage(language: string): Promise<void> {
		const disabled = this.disabledLanguages();
		const next = disabled.includes(language) ? disabled.filter(l => l !== language) : [...disabled, language];
		await this.config().update('disabledLanguages', next, vscode.ConfigurationTarget.Global);
	}

	/** The menu behind the status bar item. */
	async menu(): Promise<void> {
		const language = vscode.window.activeTextEditor?.document.languageId;
		const choice = this.model();
		type Item = vscode.QuickPickItem & { run?: () => unknown };
		const items: Item[] = [];
		if (this.status === 'error' && this.lastError) {
			items.push({ label: `$(warning) ${vscode.l10n.t('The last suggestion failed')}`, detail: this.lastError });
		}
		if (this.status === 'limit') {
			items.push({ label: `$(warning) ${vscode.l10n.t('Paused: monthly AI limit reached')}`, description: vscode.l10n.t('Change Limit'), run: () => this.usage.editLimit() });
		}
		items.push({
			label: this.enabled() ? `$(circle-slash) ${vscode.l10n.t('Turn Off Autocomplete')}` : `$(sparkle) ${vscode.l10n.t('Turn On Autocomplete')}`,
			run: () => this.toggle(),
		});
		if (language && this.enabled()) {
			const off = this.disabledLanguages().includes(language);
			items.push({
				label: `$(symbol-file) ${off ? vscode.l10n.t('Turn On for {0}', language) : vscode.l10n.t('Turn Off for {0}', language)}`,
				run: () => this.toggleLanguage(language),
			});
		}
		items.push(
			{ label: `$(hubot) ${vscode.l10n.t('Change Model...')}`, description: choice ? `${choice.model} (${choice.endpoint.name})` : undefined, run: () => this.pickModel() },
			{ label: `$(graph) ${vscode.l10n.t('Show AI Usage')}`, run: () => vscode.commands.executeCommand('nighthawk.ai.showUsage') },
			{ label: `$(gear) ${vscode.l10n.t('Autocomplete Settings')}`, run: () => vscode.commands.executeCommand('workbench.action.openSettings', SECTION) },
		);
		const pick = await vscode.window.showQuickPick(items, { title: vscode.l10n.t('Autocomplete') });
		await pick?.run?.();
	}

	async pickModel(): Promise<void> {
		const setting = this.config().get<string>('model') ?? '';
		const fallback = this.inlineEditModel();
		type Item = vscode.QuickPickItem & { ref?: string; add?: boolean };
		const items: Item[] = [
			{ label: vscode.l10n.t('Same as Inline Edits'), description: fallback?.model, ref: '', picked: !setting },
			...this.endpoints.list().flatMap(endpoint => endpoint.models.map<Item>(model => ({
				label: model,
				description: endpoint.name,
				ref: `${endpoint.name}/${model}`,
			}))),
			{ label: `$(add) ${vscode.l10n.t('Add Model Endpoint...')}`, add: true },
		];
		const pick = await vscode.window.showQuickPick(items, {
			title: vscode.l10n.t('Model for Autocomplete'),
			placeHolder: vscode.l10n.t('Pick a small, fast model: suggestions should appear within a second'),
		});
		if (pick?.add) {
			await vscode.commands.executeCommand('nighthawk.ai.addEndpoint');
		} else if (pick && pick.ref !== undefined) {
			await this.config().update('model', pick.ref, vscode.ConfigurationTarget.Global);
		}
	}

	dispose(): void {
		this.disposables.forEach(d => d.dispose());
	}
}
