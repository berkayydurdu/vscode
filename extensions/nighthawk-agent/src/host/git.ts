/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { cleanCommitMessage, commitMessageRequest } from '../core/commit';
import { modelStream } from '../core/providers';
import type { Endpoints } from './endpoints';
import { isBudgetError, type UsageMeter } from './usage';

/** The parts of the built-in Git extension's API (`extensions/git/src/api/git.d.ts`) used here. */
interface GitRepository {
	readonly rootUri: vscode.Uri;
	readonly inputBox: { value: string };
	readonly state: {
		readonly HEAD: { readonly name?: string; readonly upstream?: { readonly remote: string; readonly name: string } } | undefined;
		readonly indexChanges: readonly unknown[];
		readonly workingTreeChanges: readonly unknown[];
		readonly remotes: readonly { readonly name: string; readonly fetchUrl?: string; readonly pushUrl?: string }[];
	};
	diff(cached?: boolean): Promise<string>;
	log(options?: { maxEntries?: number }): Promise<{ readonly message: string }[]>;
	getMergeBase(ref1: string, ref2: string): Promise<string | undefined>;
}

interface GitApi {
	readonly state: 'uninitialized' | 'initialized';
	readonly onDidChangeState: vscode.Event<'uninitialized' | 'initialized'>;
	readonly repositories: GitRepository[];
	getRepository(uri: vscode.Uri): GitRepository | null;
}

async function gitApi(): Promise<GitApi | undefined> {
	const extension = vscode.extensions.getExtension<{ getAPI(version: 1): GitApi }>('vscode.git');
	if (!extension) {
		return undefined;
	}
	const exports = extension.isActive ? extension.exports : await extension.activate();
	const api = exports.getAPI(1);
	if (api.state !== 'initialized') {
		// Git is still scanning the workspace for repositories; give it a moment.
		await new Promise<void>(resolve => {
			const timer = setTimeout(() => { listener.dispose(); resolve(); }, 10_000);
			const listener = api.onDidChangeState(state => {
				if (state === 'initialized') {
					clearTimeout(timer);
					listener.dispose();
					resolve();
				}
			});
		});
	}
	return api;
}

/**
 * Finds the repository a Source Control command was run on: the argument the
 * SCM title or input menu passes, else the active editor's, else the only one.
 */
export async function pickRepository(arg: unknown): Promise<GitRepository | undefined> {
	const api = await gitApi();
	if (!api) {
		vscode.window.showWarningMessage(vscode.l10n.t('The built-in Git extension is disabled.'));
		return undefined;
	}
	const rootUri = (arg as { rootUri?: vscode.Uri } | undefined)?.rootUri;
	const fromArg = rootUri instanceof vscode.Uri ? api.getRepository(rootUri) : null;
	const editorUri = vscode.window.activeTextEditor?.document.uri;
	const repository = fromArg ?? (editorUri ? api.getRepository(editorUri) : null) ?? (api.repositories.length === 1 ? api.repositories[0] : undefined);
	if (repository) {
		return repository;
	}
	if (!api.repositories.length) {
		vscode.window.showInformationMessage(vscode.l10n.t('Open a folder with a Git repository first.'));
		return undefined;
	}
	const pick = await vscode.window.showQuickPick(api.repositories.map(r => ({ label: vscode.workspace.asRelativePath(r.rootUri), repository: r })), { title: vscode.l10n.t('Choose a Repository') });
	return pick?.repository;
}

/** Writes a commit message for the staged changes (or all changes when nothing is staged) into the Source Control input. */
export async function generateCommitMessage(endpoints: Endpoints, usage: UsageMeter, arg: unknown): Promise<void> {
	const repository = await pickRepository(arg);
	if (!repository) {
		return;
	}
	const choice = endpoints.current();
	if (!choice) {
		const add = vscode.l10n.t('Add Model Endpoint');
		if (await vscode.window.showInformationMessage(vscode.l10n.t('Connect a model to write commit messages.'), add) === add) {
			await vscode.commands.executeCommand('nighthawk.ai.addEndpoint');
		}
		return;
	}
	const staged = repository.state.indexChanges.length > 0;
	const diff = await repository.diff(staged);
	if (!diff.trim()) {
		vscode.window.showInformationMessage(vscode.l10n.t('There are no changes to describe.'));
		return;
	}
	const subjects = (await repository.log({ maxEntries: 15 }).catch(() => [])).map(c => c.message.split('\n')[0]);
	const request = commitMessageRequest(diff, subjects);
	const key = await endpoints.apiKey(choice.endpoint);
	const stream = usage.track(modelStream(choice.endpoint, choice.model, key, { thinking: false }), { endpoint: choice.endpoint, model: choice.model, feature: 'commit' });

	await vscode.window.withProgress({ location: vscode.ProgressLocation.SourceControl, title: vscode.l10n.t('Writing a commit message...'), cancellable: true }, async (_progress, token) => {
		const abort = new AbortController();
		const cancel = token.onCancellationRequested(() => abort.abort());
		const previous = repository.inputBox.value;
		let text = '';
		try {
			for await (const event of stream(request, abort.signal)) {
				if (event.type === 'text') {
					text += event.text;
					repository.inputBox.value = cleanCommitMessage(text);
				}
			}
			repository.inputBox.value = cleanCommitMessage(text) || previous;
		} catch (err) {
			repository.inputBox.value = previous;
			if (isBudgetError(err)) {
				await usage.offerToRaiseLimit(err);
			} else if (!abort.signal.aborted) {
				vscode.window.showErrorMessage(vscode.l10n.t('Could not write a commit message: {0}', err.message ?? String(err)));
			}
		} finally {
			cancel.dispose();
		}
	});
}

/** The ref a branch is compared with: its upstream's default branch when it can be found. */
async function reviewBase(repository: GitRepository): Promise<string | undefined> {
	const remote = repository.state.HEAD?.upstream?.remote ?? 'origin';
	const candidates = [`${remote}/main`, `${remote}/master`, `${remote}/develop`, 'main', 'master'];
	const current = repository.state.HEAD?.name;
	for (const candidate of candidates) {
		if (candidate === current) {
			continue;
		}
		if (await repository.getMergeBase('HEAD', candidate).catch(() => undefined)) {
			return candidate;
		}
	}
	return undefined;
}

/** Asks for the base branch, offering the detected one, and returns it with the current branch name. */
export async function chooseReviewTarget(arg: unknown): Promise<{ base: string; branch: string | undefined } | undefined> {
	const repository = await pickRepository(arg);
	if (!repository) {
		return undefined;
	}
	const detected = await reviewBase(repository);
	const base = await vscode.window.showInputBox({
		title: vscode.l10n.t('Review Branch'),
		prompt: vscode.l10n.t('Compare the current branch with this branch or commit.'),
		value: detected ?? 'origin/main',
		validateInput: value => value.trim() ? undefined : vscode.l10n.t('Enter a branch or commit.'),
	});
	return base ? { base: base.trim(), branch: repository.state.HEAD?.name } : undefined;
}
