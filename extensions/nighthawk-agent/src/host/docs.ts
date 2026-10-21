/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { crawl, DocsLibrary, MAX_PAGES, normalizeUrl, sourceId, type DocResult, type DocSource, type Fetcher } from '../core/docs';
import type { Embedder } from '../core/indexing';

const FETCH_TIMEOUT_MS = 20_000;
const MAX_BODY = 5 * 1024 * 1024;

const fetchPage: Fetcher = async (url, signal) => {
	const response = await fetch(url, {
		signal: AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]),
		headers: { 'user-agent': 'Nighthawk-Docs/1.0', accept: 'text/html,text/plain,text/markdown;q=0.9,*/*;q=0.5' },
	});
	return { url: response.url || url, status: response.status, contentType: response.headers.get('content-type') ?? '', body: (await response.text()).slice(0, MAX_BODY) };
};

/** A short name for docs at a URL: the site without www. and docs. */
function defaultName(url: string): string {
	const host = new URL(url).hostname.replace(/^(www|docs|developer|developers)\./, '');
	const name = host.split('.')[0];
	return name.charAt(0).toUpperCase() + name.slice(1);
}

/**
 * Documentation the user added by URL, read into a search index on this
 * computer, for the agent's DocsSearch tool and `@docs:Name` mentions.
 */
export class Docs implements vscode.Disposable {
	readonly library: DocsLibrary;
	private readonly changed = new vscode.EventEmitter<void>();
	readonly onDidChange = this.changed.event;

	constructor(storage: vscode.Uri, private readonly embedder: () => Embedder | undefined) {
		this.library = new DocsLibrary(vscode.Uri.joinPath(storage, 'docs').fsPath);
	}

	dispose(): void {
		this.changed.dispose();
	}

	async names(): Promise<string[]> {
		return (await this.library.list()).map(s => s.name);
	}

	search(query: string, sources: string[], signal: AbortSignal): Promise<DocResult[]> {
		return this.library.search(query, { sources, embedder: this.embedder(), signal });
	}

	/** Asks for a URL and a name, then reads and indexes the docs. */
	async add(url?: string): Promise<void> {
		url ??= await vscode.window.showInputBox({
			title: vscode.l10n.t('Add Documentation'),
			prompt: vscode.l10n.t('Nighthawk reads the pages under this address, up to {0}, and keeps them searchable for the agent.', MAX_PAGES),
			placeHolder: 'https://react.dev/reference/react',
			ignoreFocusOut: true,
			validateInput: value => normalizeUrl(value.trim()) ? undefined : vscode.l10n.t('Enter a web address starting with https://'),
		});
		const start = url && normalizeUrl(url.trim());
		if (!start) {
			return;
		}
		const existing = (await this.library.list()).find(s => s.url === start);
		const name = existing?.name ?? await vscode.window.showInputBox({
			title: vscode.l10n.t('Name the Documentation'),
			prompt: vscode.l10n.t('Mention it as @docs:Name in the agent.'),
			value: defaultName(start),
			ignoreFocusOut: true,
			validateInput: value => /^[\w .+-]{1,40}$/.test(value.trim()) ? undefined : vscode.l10n.t('Use letters, numbers, spaces, dots and dashes.'),
		});
		if (!name?.trim()) {
			return;
		}
		await this.index({ id: existing?.id ?? sourceId(start), name: name.trim(), url: start, prefix: existing?.prefix });
	}

	/** Reads the source's pages again and indexes them; without a prefix, the crawl decides it from the start page. */
	private async index(source: Omit<DocSource, 'pages' | 'chunks' | 'indexed' | 'embedder' | 'prefix'> & { prefix?: string }): Promise<void> {
		const saved = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Indexing {0} docs', source.name), cancellable: true }, async (progress, token) => {
			const abort = new AbortController();
			token.onCancellationRequested(() => abort.abort());
			let reported = 0;
			const { pages, prefix } = await crawl(source.url, fetchPage, {
				prefix: source.prefix,
				signal: abort.signal,
				onPage: done => {
					progress.report({ message: vscode.l10n.t('{0} pages read', done), increment: (done - reported) / MAX_PAGES * 80 });
					reported = done;
				},
			});
			if (abort.signal.aborted) {
				return undefined;
			}
			if (!pages.length) {
				throw new Error(vscode.l10n.t('No readable pages were found at {0}.', source.url));
			}
			progress.report({ message: vscode.l10n.t('Indexing {0} pages...', pages.length) });
			return this.library.save({ ...source, prefix }, pages, this.embedder(), abort.signal, (done, total) => progress.report({ message: vscode.l10n.t('Embedding {0} of {1} sections...', done, total) }));
		}).then(undefined, (err: Error) => {
			vscode.window.showErrorMessage(vscode.l10n.t('Could not index the docs: {0}', err.message));
			return undefined;
		});
		if (!saved) {
			return;
		}
		this.changed.fire();
		const search = vscode.l10n.t('Search Them');
		const answer = await vscode.window.showInformationMessage(vscode.l10n.t('{0}: {1} pages indexed. The agent can now look things up in them, or mention @docs:{2}.', saved.name, saved.pages, saved.name.replace(/\s+/g, '')), search);
		if (answer === search) {
			await this.searchCommand(saved.name);
		}
	}

	/** Lists the documentation to search, refresh, rename or remove it. */
	async manage(): Promise<void> {
		const sources = await this.library.list();
		type Item = vscode.QuickPickItem & { source?: DocSource; add?: boolean };
		const refresh: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('refresh'), tooltip: vscode.l10n.t('Read Again') };
		const rename: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('edit'), tooltip: vscode.l10n.t('Rename') };
		const remove: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('trash'), tooltip: vscode.l10n.t('Remove') };
		const pick = vscode.window.createQuickPick<Item>();
		pick.title = vscode.l10n.t('Documentation');
		pick.placeholder = vscode.l10n.t('Docs the agent can search. Pick one to search it.');
		pick.items = [
			...sources.map<Item>(source => ({
				label: `$(book) ${source.name}`,
				description: source.prefix,
				detail: vscode.l10n.t('{0} pages, {1} sections, read {2}{3}', source.pages, source.chunks, new Date(source.indexed).toLocaleDateString(), source.embedder ? vscode.l10n.t(', searchable by meaning') : ''),
				buttons: [refresh, rename, remove],
				source,
			})),
			{ label: `$(add) ${vscode.l10n.t('Add Documentation...')}`, add: true, alwaysShow: true },
		];
		pick.onDidTriggerItemButton(async e => {
			const source = e.item.source;
			if (!source) {
				return;
			}
			pick.hide();
			if (e.button === refresh) {
				await this.index(source);
			} else if (e.button === rename) {
				const name = await vscode.window.showInputBox({ title: vscode.l10n.t('Rename Documentation'), value: source.name });
				if (name?.trim()) {
					await this.library.rename(source.id, name.trim());
					this.changed.fire();
				}
			} else {
				await this.library.remove(source.id);
				this.changed.fire();
			}
		});
		pick.onDidAccept(async () => {
			const item = pick.selectedItems[0];
			pick.hide();
			if (item?.add) {
				await this.add();
			} else if (item?.source) {
				await this.searchCommand(item.source.name);
			}
		});
		pick.onDidHide(() => pick.dispose());
		pick.show();
	}

	/** Searches the docs and opens the picked section's page. */
	async searchCommand(source?: string): Promise<void> {
		if (!(await this.library.list()).length) {
			const add = vscode.l10n.t('Add Documentation...');
			if (await vscode.window.showInformationMessage(vscode.l10n.t('No documentation added yet.'), add) === add) {
				await this.add();
			}
			return;
		}
		const query = await vscode.window.showInputBox({ title: source ? vscode.l10n.t('Search {0} Docs', source) : vscode.l10n.t('Search Documentation'), placeHolder: vscode.l10n.t('What do you want to know?') });
		if (!query?.trim()) {
			return;
		}
		const results = await this.search(query, source ? [source] : [], new AbortController().signal);
		const pick = await vscode.window.showQuickPick(results.map(r => ({
			label: r.heading ? r.heading.split(' > ').pop() ?? r.title : r.title,
			description: `${r.source} · ${r.title}`,
			detail: r.text.replace(/\s+/g, ' ').slice(0, 200),
			url: r.url,
		})), { title: vscode.l10n.t('{0} sections found', results.length), matchOnDescription: true, matchOnDetail: true });
		if (pick) {
			await vscode.env.openExternal(vscode.Uri.parse(pick.url));
		}
	}
}
