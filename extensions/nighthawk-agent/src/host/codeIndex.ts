/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFile } from 'node:child_process';
import { access, readdir } from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { defaultEmbeddingModel, isEmbeddingModel, requestEmbeddingsWithRetry } from '../core/embeddings';
import { SKIPPED_DIRS } from '../core/glob';
import { CodeIndex, type Embedder, type IndexStatus, type SearchOptions } from '../core/indexing';
import { listModels } from '../core/providers';
import type { CodebaseSearchResult } from '../core/tools';
import type { Endpoint } from '../core/types';
import { formatCost, isLocalEndpoint } from '../core/usage';
import { isInside } from '../core/workspace';
import type { Endpoints } from './endpoints';
import { findRipgrep } from './project';
import { isBudgetError, type UsageMeter } from './usage';

const SECTION = 'nighthawk.index';
/** Files this tool's users commonly use to keep files away from AI tools, read like .gitignore. */
const IGNORE_FILES = ['.nighthawkignore', '.cursorignore', '.aiignore'];
/** Folders never indexed, even outside a git repository. */
const EXCLUDED_DIRS = [...SKIPPED_DIRS, 'venv', 'bower_components', '.gradle', '.idea', '.vs', '.terraform'];

interface EmbeddingChoice {
	endpoint: Endpoint;
	model: string;
	/** Chosen automatically rather than set by the user. */
	automatic: boolean;
}

function runRipgrep(rg: string, args: string[], cwd: string, signal: AbortSignal): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(rg, args, { cwd, maxBuffer: 200 * 1024 * 1024, signal, windowsHide: true }, (err, stdout, stderr) => {
			// Exit code 1 means no files.
			if (err && (err as { code?: unknown }).code !== 1) {
				reject(new Error(stderr.trim() || err.message));
			} else {
				resolve(stdout);
			}
		});
	});
}

async function exists(file: string): Promise<boolean> {
	try {
		await access(file);
		return true;
	} catch {
		return false;
	}
}

/**
 * Keeps an index of the workspace's code on this computer, up to date as
 * files change, for the agent's CodebaseSearch tool and the "Search
 * Codebase" command. Ranks by words always, and by meaning with an
 * embedding model when one of the user's endpoints offers it.
 */
export class CodebaseIndexer implements vscode.Disposable {
	private index: CodeIndex | undefined;
	private status: IndexStatus | undefined;
	private embedding: EmbeddingChoice | undefined;
	private embedderId: string | undefined;
	private readonly item = vscode.window.createStatusBarItem('nighthawk.index', vscode.StatusBarAlignment.Right, 98);
	private readonly disposables: vscode.Disposable[] = [this.item];
	private watcher: vscode.Disposable | undefined;
	private readonly changed = new Set<string>();
	private rescan = false;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private lastRescan = 0;
	private askedThisSession = false;
	private unrecorded = { tokens: 0, endpoint: undefined as Endpoint | undefined, model: '' };
	private recordTimer: ReturnType<typeof setTimeout> | undefined;
	private readonly ripgrep = findRipgrep();

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly endpoints: Endpoints,
		private readonly usage: UsageMeter,
		private readonly storageKey: string,
	) {
		this.item.name = vscode.l10n.t('Codebase Index');
		this.item.command = 'nighthawk.index.menu';
		this.disposables.push(
			vscode.workspace.onDidChangeConfiguration(e => {
				if (e.affectsConfiguration(`${SECTION}.enabled`) || e.affectsConfiguration(`${SECTION}.exclude`) || e.affectsConfiguration(`${SECTION}.maxFiles`)) {
					this.restart();
				} else if (e.affectsConfiguration(`${SECTION}.embeddingModel`)) {
					this.updateEmbedder(true);
				}
			}),
			vscode.workspace.onDidChangeWorkspaceFolders(() => this.restart()),
			endpoints.onDidChange(() => this.updateEmbedder(false)),
		);
		// Started after the window settles, so indexing never slows down opening it.
		const start = setTimeout(() => this.restart(), 3000);
		this.disposables.push({ dispose: () => clearTimeout(start) });
	}

	dispose(): void {
		this.stop();
		this.flushUsage();
		this.disposables.forEach(d => d.dispose());
	}

	private config(): vscode.WorkspaceConfiguration {
		return vscode.workspace.getConfiguration(SECTION);
	}

	enabled(): boolean {
		return this.config().get<boolean>('enabled', true) && !!this.roots().length;
	}

	private roots(): string[] {
		return (vscode.workspace.workspaceFolders ?? []).filter(f => f.uri.scheme === 'file').map(f => f.uri.fsPath);
	}

	private stop(): void {
		this.index?.cancel();
		this.index = undefined;
		this.status = undefined;
		this.embedderId = undefined;
		this.watcher?.dispose();
		this.watcher = undefined;
		clearTimeout(this.timer);
		this.changed.clear();
		this.rescan = false;
	}

	private async restart(): Promise<void> {
		this.stop();
		if (!this.enabled()) {
			this.render();
			return;
		}
		const roots = this.roots();
		const index = this.index = new CodeIndex({
			roots,
			storageDir: path.join(this.context.globalStorageUri.fsPath, 'index', this.storageKey),
			listFiles: signal => this.listFiles(roots, signal),
			onStatus: status => {
				if (this.index === index) {
					this.status = status;
					this.render();
				}
			},
		});
		this.status = index.getStatus();
		this.render();
		this.watch(roots);
		await index.load();
		await this.updateEmbedder(false, true);
		await index.sync();
		if (this.index === index) {
			this.offerEmbeddings();
		}
	}

	// --- Files

	private async listFiles(roots: string[], signal: AbortSignal): Promise<string[]> {
		const exclude = this.config().get<string[]>('exclude', []);
		const max = Math.max(1, this.config().get<number>('maxFiles', 50_000));
		const rg = await this.ripgrep;
		const files: string[] = [];
		for (const root of roots) {
			if (rg) {
				const args = ['--files', '--hidden', '--no-messages', '--glob', '!.git'];
				for (const dir of EXCLUDED_DIRS) {
					args.push('--glob', `!**/${dir}/**`);
				}
				for (const pattern of exclude) {
					args.push('--glob', `!${pattern}`);
				}
				for (const name of IGNORE_FILES) {
					const file = path.join(root, name);
					if (await exists(file)) {
						args.push('--ignore-file', file);
					}
				}
				const out = await runRipgrep(rg, args, root, signal);
				files.push(...out.split(/\r?\n/).filter(Boolean).map(f => path.join(root, f)));
			} else {
				await walk(root, files, max, signal);
			}
			if (files.length >= max) {
				break;
			}
		}
		return files.slice(0, max);
	}

	private watch(roots: string[]): void {
		const watcher = vscode.workspace.createFileSystemWatcher('**/*');
		const excluded = new Set(EXCLUDED_DIRS);
		const inScope = (uri: vscode.Uri) => {
			if (uri.scheme !== 'file') {
				return false;
			}
			const root = roots.find(r => isInside(r, uri.fsPath));
			return !!root && !path.relative(root, uri.fsPath).split(/[\\/]/).some(part => excluded.has(part));
		};
		const onChange = (uri: vscode.Uri) => {
			// A change to a file that is not indexed is to an ignored or too large file.
			if (inScope(uri) && this.index?.has(uri.fsPath)) {
				this.changed.add(uri.fsPath);
				this.schedule();
			}
		};
		const onCreateOrDelete = (uri: vscode.Uri) => {
			if (!inScope(uri)) {
				return;
			}
			if (this.index?.has(uri.fsPath)) {
				this.changed.add(uri.fsPath);
			} else {
				// A new file, or a deleted folder: list the files again to see which are indexed.
				this.rescan = true;
			}
			this.schedule();
		};
		this.watcher = vscode.Disposable.from(
			watcher,
			watcher.onDidChange(onChange),
			watcher.onDidCreate(onCreateOrDelete),
			watcher.onDidDelete(onCreateOrDelete),
		);
	}

	private schedule(): void {
		clearTimeout(this.timer);
		// Listing every file is cheap but not free, so rescans wait longer.
		const delay = this.rescan ? Math.max(2000, 10_000 - (Date.now() - this.lastRescan)) : 1500;
		this.timer = setTimeout(() => this.applyChanges(), delay);
	}

	private async applyChanges(): Promise<void> {
		const index = this.index;
		if (!index) {
			return;
		}
		const files = [...this.changed];
		this.changed.clear();
		if (this.rescan) {
			this.rescan = false;
			this.lastRescan = Date.now();
			await index.sync();
		} else if (files.length) {
			await index.update(files);
		}
	}

	// --- Embeddings

	/** The embedding model from the setting, or one found on the user's endpoints. */
	private async findEmbedding(): Promise<EmbeddingChoice | undefined> {
		const setting = (this.config().get<string>('embeddingModel') ?? '').trim();
		if (setting === 'off') {
			return undefined;
		}
		if (setting) {
			const choice = this.endpoints.resolve(setting);
			return choice ? { ...choice, automatic: false } : undefined;
		}
		const current = this.endpoints.current()?.endpoint;
		const endpoints = this.endpoints.list().sort((a, b) => Number(b.name === current?.name) - Number(a.name === current?.name));
		for (const endpoint of endpoints) {
			let model = defaultEmbeddingModel(endpoint);
			if (!model && endpoint.provider === 'openai' && isLocalEndpoint(endpoint.baseUrl)) {
				// Ollama and LM Studio list the embedding models that are installed.
				const available = await listModels(endpoint, await this.endpoints.apiKey(endpoint), AbortSignal.timeout(3000)).catch(() => []);
				model = defaultEmbeddingModel(endpoint, available);
			}
			if (model) {
				return { endpoint, model, automatic: true };
			}
		}
		return undefined;
	}

	/** Whether code may be sent to this model for indexing without asking: chosen by the user, or running on this computer. */
	private allowed(choice: EmbeddingChoice): boolean {
		return !choice.automatic || isLocalEndpoint(choice.endpoint.baseUrl);
	}

	/** Picks up a changed embedding model or endpoint; `force` applies it even when it looks the same. */
	private async updateEmbedder(force: boolean, starting = false): Promise<void> {
		const index = this.index;
		if (!index) {
			return;
		}
		const choice = await this.findEmbedding();
		if (index !== this.index) {
			return;
		}
		this.embedding = choice;
		const usable = choice && this.allowed(choice) ? choice : undefined;
		const id = usable ? `${usable.endpoint.baseUrl}|${usable.model}` : undefined;
		// After an error, such as a missing API key, a changed endpoint is worth another try.
		if (id === this.embedderId && !force && !index.getStatus().embedError) {
			this.render();
			return;
		}
		this.embedderId = id;
		index.setEmbedder(usable ? this.embedder(usable) : undefined);
		if (!starting) {
			await index.sync();
			if (!usable) {
				this.offerEmbeddings();
			}
		}
	}

	private embedder(choice: EmbeddingChoice): Embedder {
		const { endpoint, model } = choice;
		return {
			id: `${endpoint.baseUrl}|${model}`,
			embed: async (texts, signal) => {
				await this.usage.ensureWithinLimit();
				const key = await this.endpoints.apiKey(endpoint);
				const result = await requestEmbeddingsWithRetry(endpoint, model, key, texts, signal);
				this.addUsage(endpoint, model, result.tokens);
				return result.vectors;
			},
		};
	}

	/** Usage is recorded every few seconds rather than per batch, so a first run is a few lines in the log, not thousands. */
	private addUsage(endpoint: Endpoint, model: string, tokens: number): void {
		if (this.unrecorded.endpoint && (this.unrecorded.endpoint.name !== endpoint.name || this.unrecorded.model !== model)) {
			this.flushUsage();
		}
		this.unrecorded.endpoint = endpoint;
		this.unrecorded.model = model;
		this.unrecorded.tokens += tokens;
		if (!this.recordTimer) {
			this.recordTimer = setTimeout(() => this.flushUsage(), 5000);
		}
	}

	private flushUsage(): void {
		clearTimeout(this.recordTimer);
		this.recordTimer = undefined;
		const { endpoint, model, tokens } = this.unrecorded;
		if (endpoint && tokens) {
			this.usage.recordUsage({ endpoint, model, feature: 'index' }, { inputTokens: tokens, outputTokens: 0 });
		}
		this.unrecorded = { tokens: 0, endpoint: undefined, model: '' };
	}

	/**
	 * Asks once per window before sending the project's code to a cloud
	 * embedding model the user did not pick, with what it would cost.
	 */
	private async offerEmbeddings(): Promise<void> {
		const choice = this.embedding;
		const index = this.index;
		if (!choice || this.allowed(choice) || !index || this.askedThisSession) {
			return;
		}
		this.askedThisSession = true;
		const tokens = Math.ceil(index.pendingEmbeddingChars() / 4);
		const price = this.usage.priceOf(choice.endpoint, choice.model);
		const dollars = price ? tokens * price.input / 1_000_000 : undefined;
		const cost = dollars === undefined ? undefined : dollars < 0.01 ? vscode.l10n.t('less than a cent') : vscode.l10n.t('about {0}', formatCost(dollars));
		const yes = vscode.l10n.t('Index by Meaning');
		const no = vscode.l10n.t('Words Only');
		const message = cost
			? vscode.l10n.t('Nighthawk indexed this project by words. To also find code by meaning, it can send the code (not ignored files or secrets) to {0} on {1} once ({2}), then only files that change. The index stays on this computer.', choice.model, choice.endpoint.name, cost)
			: vscode.l10n.t('Nighthawk indexed this project by words. To also find code by meaning, it can send the code (not ignored files or secrets) to {0} on {1} once, then only files that change. The index stays on this computer.', choice.model, choice.endpoint.name);
		const pick = await vscode.window.showInformationMessage(message, yes, no);
		if (pick === yes) {
			await this.config().update('embeddingModel', `${choice.endpoint.name}/${choice.model}`, vscode.ConfigurationTarget.Global);
		} else if (pick === no) {
			await this.config().update('embeddingModel', 'off', vscode.ConfigurationTarget.Global);
		}
	}

	// --- Searching

	/** Searches the index for the agent; results under `roots` when the agent works in other folders, such as a worktree. */
	async search(query: string, options: SearchOptions, signal: AbortSignal): Promise<CodebaseSearchResult> {
		const index = this.index;
		if (!index) {
			return { results: [], byMeaning: false, note: 'The codebase index is not available yet. Use Grep and Glob instead.' };
		}
		const status = index.getStatus();
		const { results, byMeaning } = await index.search(query, options, signal);
		let note: string | undefined;
		if (status.state === 'starting' || status.state === 'scanning' || status.state === 'indexing') {
			note = `The index is still being built (${status.files} files so far); results may be incomplete.`;
		} else if (status.state === 'embedding' && status.total) {
			note = `Indexing by meaning is ${Math.round((status.done ?? 0) / status.total * 100)}% done; results may be incomplete.`;
		}
		return { results, byMeaning, note };
	}

	private state(): string {
		const status = this.status;
		if (!status) {
			return '';
		}
		const percent = status.total ? ` ${Math.floor((status.done ?? 0) / status.total * 100)}%` : '';
		switch (status.state) {
			case 'starting':
			case 'scanning': return vscode.l10n.t('Indexing');
			case 'indexing': return vscode.l10n.t('Indexing{0}', percent);
			case 'embedding': return vscode.l10n.t('Indexing by meaning{0}', percent);
			default: return '';
		}
	}

	private render(): void {
		const status = this.status;
		if (!this.enabled() || !status) {
			this.item.hide();
			return;
		}
		const busy = this.state();
		const failed = status.state === 'error' || !!status.embedError;
		this.item.text = busy ? `$(sync~spin) ${busy}` : failed ? '$(database) $(warning)' : '$(database)';
		const tooltip = new vscode.MarkdownString(undefined, true);
		tooltip.appendMarkdown(`**${vscode.l10n.t('Codebase index')}**\n\n`);
		tooltip.appendMarkdown(`${vscode.l10n.t('{0} files in {1} chunks, kept on this computer.', status.files.toLocaleString(), status.chunks.toLocaleString())}\n\n`);
		const choice = this.embedding;
		if (choice && this.allowed(choice) && !status.embedError) {
			tooltip.appendMarkdown(vscode.l10n.t('Finds code by meaning with {0} on {1} ({2} of {3} chunks), and by words.', choice.model, choice.endpoint.name, status.embedded.toLocaleString(), status.chunks.toLocaleString()));
		} else {
			tooltip.appendMarkdown(vscode.l10n.t('Finds code by words and names. Choose an embedding model to also find code by meaning.'));
		}
		if (status.embedError) {
			tooltip.appendMarkdown(`\n\n$(warning) ${vscode.l10n.t('Indexing by meaning stopped: {0}', status.embedError)}`);
		}
		if (status.error) {
			tooltip.appendMarkdown(`\n\n$(warning) ${status.error}`);
		}
		tooltip.appendMarkdown(`\n\n${vscode.l10n.t('Click for options.')}`);
		this.item.tooltip = tooltip;
		this.item.show();
	}

	// --- Commands

	async menu(): Promise<void> {
		type Item = vscode.QuickPickItem & { run?: () => unknown };
		if (!this.enabled()) {
			const pick = await vscode.window.showQuickPick<Item>([
				{ label: `$(check) ${vscode.l10n.t('Turn On Codebase Indexing')}`, run: () => this.config().update('enabled', true, vscode.ConfigurationTarget.Global) },
			], { title: vscode.l10n.t('Codebase Index') });
			await pick?.run?.();
			return;
		}
		const choice = this.embedding;
		const meaning = choice && this.allowed(choice) ? `${choice.model} (${choice.endpoint.name})` : vscode.l10n.t('none, words only');
		const items: Item[] = [
			{ label: `$(search) ${vscode.l10n.t('Search Codebase...')}`, run: () => this.searchCommand() },
			{ label: `$(sparkle) ${vscode.l10n.t('Choose Embedding Model...')}`, description: meaning, run: () => this.pickEmbeddingModel() },
			{ label: `$(refresh) ${vscode.l10n.t('Rebuild Index')}`, run: () => this.rebuild() },
			{ label: `$(circle-slash) ${vscode.l10n.t('Turn Off Codebase Indexing')}`, run: () => this.config().update('enabled', false, vscode.ConfigurationTarget.Global) },
			{ label: `$(gear) ${vscode.l10n.t('Index Settings')}`, run: () => vscode.commands.executeCommand('workbench.action.openSettings', SECTION) },
		];
		const pick = await vscode.window.showQuickPick(items, { title: vscode.l10n.t('Codebase Index') });
		await pick?.run?.();
	}

	async rebuild(): Promise<void> {
		const index = this.index;
		if (!index) {
			return this.restart();
		}
		await index.clear();
		await this.updateEmbedder(true, true);
		await index.sync();
	}

	async pickEmbeddingModel(): Promise<void> {
		const setting = (this.config().get<string>('embeddingModel') ?? '').trim();
		type Item = vscode.QuickPickItem & { ref?: string; add?: boolean };
		const items: Item[] = [
			{ label: vscode.l10n.t('Automatic'), description: vscode.l10n.t('an embedding model one of your endpoints offers'), ref: '', picked: !setting },
			{ label: vscode.l10n.t('None: find code by words only'), description: vscode.l10n.t('nothing is sent anywhere'), ref: 'off', picked: setting === 'off' },
		];
		const quickPick = vscode.window.createQuickPick<Item>();
		quickPick.title = vscode.l10n.t('Embedding Model for the Codebase Index');
		quickPick.placeholder = vscode.l10n.t('Embedding models turn code into vectors so it can be found by meaning');
		quickPick.items = [...items, { label: vscode.l10n.t('Looking for embedding models...'), kind: vscode.QuickPickItemKind.Separator }];
		quickPick.busy = true;
		quickPick.show();
		const found: Item[] = [];
		for (const endpoint of this.endpoints.list().filter(e => e.provider === 'openai')) {
			const available = await listModels(endpoint, await this.endpoints.apiKey(endpoint), AbortSignal.timeout(5000)).catch(() => [] as string[]);
			const models = new Set([...endpoint.models, ...available].filter(isEmbeddingModel));
			const known = defaultEmbeddingModel(endpoint);
			if (known) {
				models.add(known);
			}
			for (const model of models) {
				found.push({ label: model, description: endpoint.name, ref: `${endpoint.name}/${model}`, picked: setting === `${endpoint.name}/${model}` });
			}
		}
		quickPick.busy = false;
		const heading: Item = { label: vscode.l10n.t('Embedding models on your endpoints'), kind: vscode.QuickPickItemKind.Separator };
		quickPick.items = [
			...items,
			...(found.length ? [heading, ...found] : []),
			{ label: '', kind: vscode.QuickPickItemKind.Separator },
			{ label: `$(add) ${vscode.l10n.t('Add Model Endpoint...')}`, detail: found.length ? undefined : vscode.l10n.t('OpenAI, Gemini, Mistral, Voyage or a local Ollama or LM Studio with an embedding model such as nomic-embed-text'), add: true },
		];
		const pick = await new Promise<Item | undefined>(resolve => {
			quickPick.onDidAccept(() => resolve(quickPick.selectedItems[0]));
			quickPick.onDidHide(() => resolve(undefined));
		});
		quickPick.dispose();
		if (pick?.add) {
			await vscode.commands.executeCommand('nighthawk.ai.addEndpoint');
		} else if (pick && pick.ref !== undefined) {
			await this.config().update('embeddingModel', pick.ref, vscode.ConfigurationTarget.Global);
		}
	}

	/** A quick pick that searches as you type and opens the chosen result. */
	async searchCommand(initial?: string): Promise<void> {
		if (!this.index) {
			const turnOn = vscode.l10n.t('Turn On');
			if (await vscode.window.showInformationMessage(vscode.l10n.t('Codebase indexing is off, or no folder is open.'), turnOn) === turnOn) {
				await this.config().update('enabled', true, vscode.ConfigurationTarget.Global);
			}
			return;
		}
		type Item = vscode.QuickPickItem & { file?: string; start?: number; end?: number };
		const quickPick = vscode.window.createQuickPick<Item>();
		quickPick.title = vscode.l10n.t('Search Codebase');
		quickPick.placeholder = vscode.l10n.t('Describe what you are looking for, like "where do we handle sign-in"');
		quickPick.matchOnDescription = false;
		quickPick.matchOnDetail = false;
		let run = 0;
		let abort: AbortController | undefined;
		const search = async (query: string) => {
			const mine = ++run;
			abort?.abort();
			abort = new AbortController();
			if (!query.trim()) {
				quickPick.items = [];
				quickPick.busy = false;
				return;
			}
			quickPick.busy = true;
			try {
				const { results } = await this.search(query, { limit: 30 }, abort.signal);
				if (mine !== run) {
					return;
				}
				quickPick.items = results.map(r => {
					const rel = vscode.workspace.asRelativePath(r.file, this.roots().length > 1);
					const firstLine = r.text.split('\n').find(l => l.trim())?.trim() ?? '';
					return {
						label: `$(file-code) ${path.basename(r.file)}:${r.start}`,
						description: path.dirname(rel) === '.' ? '' : path.dirname(rel),
						detail: r.symbols.length ? r.symbols.slice(0, 6).join(', ') : firstLine.slice(0, 120),
						// Results are ranked by the index; the quick pick must not filter them again.
						alwaysShow: true,
						file: r.file,
						start: r.start,
						end: r.end,
					};
				});
			} catch (err) {
				if (isBudgetError(err)) {
					this.usage.offerToRaiseLimit(err);
				}
			} finally {
				if (mine === run) {
					quickPick.busy = false;
				}
			}
		};
		let typing: ReturnType<typeof setTimeout> | undefined;
		quickPick.onDidChangeValue(value => {
			clearTimeout(typing);
			typing = setTimeout(() => search(value), 300);
		});
		quickPick.onDidAccept(async () => {
			const pick = quickPick.selectedItems[0];
			if (!pick?.file) {
				return;
			}
			quickPick.hide();
			const editor = await vscode.window.showTextDocument(vscode.Uri.file(pick.file), { preview: true });
			const range = new vscode.Range(pick.start! - 1, 0, pick.start! - 1, 0);
			editor.selection = new vscode.Selection(range.start, range.start);
			editor.revealRange(new vscode.Range(pick.start! - 1, 0, pick.end! - 1, 0), vscode.TextEditorRevealType.AtTop);
		});
		quickPick.onDidHide(() => {
			clearTimeout(typing);
			abort?.abort();
			quickPick.dispose();
		});
		if (initial) {
			quickPick.value = initial;
			search(initial);
		}
		quickPick.show();
	}
}

/** Lists files without ripgrep: no .gitignore support, but heavy folders are skipped. */
async function walk(dir: string, out: string[], max: number, signal: AbortSignal): Promise<void> {
	let entries;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		if (signal.aborted || out.length >= max) {
			return;
		}
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (!EXCLUDED_DIRS.includes(entry.name) && entry.name !== '.git') {
				await walk(full, out, max, signal);
			}
		} else if (entry.isFile()) {
			out.push(full);
		}
	}
}
