/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { readFile } from 'node:fs/promises';
import * as vscode from 'vscode';
import { GitHub, githubRepo, postReview, reviewPullRequest, type Finding, type PullRequest, type ReviewResult } from '../core/prReview';
import { modelStream, PRESETS } from '../core/providers';
import type { Endpoints } from './endpoints';
import { pickRepository } from './git';
import { isBudgetError, type UsageMeter } from './usage';

const SEVERITY_ICON: Record<Finding['severity'], string> = { high: '$(error)', medium: '$(warning)', low: '$(info)' };

/**
 * Pull request reviews: "AI: Review Pull Request..." reviews a GitHub pull
 * request with the current model and posts the findings you tick as review
 * comments; "AI: Set Up Automatic PR Reviews..." adds a workflow that does
 * the same on every push.
 */
export class PullRequestReviews {
	constructor(private readonly context: vscode.ExtensionContext, private readonly endpoints: Endpoints, private readonly usage: UsageMeter) { }

	/** The workspace's GitHub repository (`owner/repo`) and its folder. */
	private async repository(): Promise<{ repo: string; root: vscode.Uri } | undefined> {
		const repository = await pickRepository(undefined);
		if (!repository) {
			return undefined;
		}
		const remotes = repository.state.remotes;
		const sorted = [...remotes].sort((a, b) => Number(b.name === 'origin') - Number(a.name === 'origin'));
		const repos = [...new Set(sorted.flatMap(r => [r.fetchUrl, r.pushUrl]).flatMap(url => url ? [githubRepo(url)] : []).filter((r): r is string => !!r))];
		if (!repos.length) {
			vscode.window.showWarningMessage(vscode.l10n.t('This repository has no GitHub remote.'));
			return undefined;
		}
		const repo = repos.length === 1 ? repos[0] : (await vscode.window.showQuickPick(repos, { title: vscode.l10n.t('Choose a GitHub Repository') }));
		return repo ? { repo, root: repository.rootUri } : undefined;
	}

	private async github(): Promise<GitHub | undefined> {
		try {
			const session = await vscode.authentication.getSession('github', ['repo'], { createIfNone: true });
			return new GitHub(session.accessToken);
		} catch {
			vscode.window.showWarningMessage(vscode.l10n.t('Reviewing pull requests needs you signed in to GitHub.'));
			return undefined;
		}
	}

	/** Reviews a pull request: picks it, runs the model, and posts the findings you keep. */
	async review(number?: number): Promise<void> {
		const choice = this.endpoints.current();
		if (!choice) {
			const add = vscode.l10n.t('Add Model Endpoint');
			if (await vscode.window.showInformationMessage(vscode.l10n.t('Connect a model to review pull requests.'), add) === add) {
				await vscode.commands.executeCommand('nighthawk.ai.addEndpoint');
			}
			return;
		}
		const target = await this.repository();
		const github = target && await this.github();
		if (!target || !github) {
			return;
		}
		number ??= await this.pickPullRequest(github, target.repo);
		if (!number) {
			return;
		}
		const key = await this.endpoints.apiKey(choice.endpoint);
		const stream = this.usage.track(modelStream(choice.endpoint, choice.model, key, { thinking: false }), { endpoint: choice.endpoint, model: choice.model, feature: 'prReview' });
		let result: ReviewResult | undefined;
		await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Reviewing pull request #{0}', number), cancellable: true }, async (progress, token) => {
			const abort = new AbortController();
			const cancel = token.onCancellationRequested(() => abort.abort());
			try {
				result = await reviewPullRequest(github, target.repo, number, stream, abort.signal, status => progress.report({ message: status === 'Reading the pull request' ? vscode.l10n.t('Reading the pull request...') : vscode.l10n.t('Reviewing the changes with {0}...', choice.model) }));
			} catch (err) {
				if (isBudgetError(err)) {
					await this.usage.offerToRaiseLimit(err);
				} else if (!abort.signal.aborted) {
					vscode.window.showErrorMessage(vscode.l10n.t('Could not review the pull request: {0}', (err as Error).message));
				}
			} finally {
				cancel.dispose();
			}
		});
		if (result) {
			await this.choose(github, target, result);
		}
	}

	private async pickPullRequest(github: GitHub, repo: string): Promise<number | undefined> {
		const pick = vscode.window.createQuickPick<vscode.QuickPickItem & { pr?: PullRequest }>();
		pick.title = vscode.l10n.t('Review Pull Request in {0}', repo);
		pick.placeholder = vscode.l10n.t('Pick an open pull request, or type its number');
		pick.busy = true;
		pick.show();
		github.pullRequests(repo).then(prs => {
			pick.items = prs.map(pr => ({ label: `#${pr.number} ${pr.title}`, description: `${pr.user?.login ?? ''}${pr.draft ? ` · ${vscode.l10n.t('draft')}` : ''}`, detail: `${pr.head.ref} → ${pr.base.ref}`, pr }));
			pick.busy = false;
		}, err => {
			pick.busy = false;
			pick.placeholder = vscode.l10n.t('Could not list pull requests ({0}); type a number', (err as Error).message);
		});
		return new Promise(resolve => {
			pick.onDidAccept(() => {
				const typed = /^#?(?<number>\d+)$/.exec(pick.value.trim())?.groups?.number;
				const number = pick.selectedItems[0]?.pr?.number ?? (typed ? Number(typed) : undefined);
				pick.hide();
				resolve(number);
			});
			pick.onDidHide(() => {
				pick.dispose();
				resolve(undefined);
			});
		});
	}

	/** Lists the findings, all ticked, to choose which to post; each can be opened at its line first. */
	private async choose(github: GitHub, target: { repo: string; root: vscode.Uri }, result: ReviewResult): Promise<void> {
		const all = [...result.inline, ...result.general];
		const already = result.skipped ? ` ${vscode.l10n.t('({0} found before and already posted)', result.skipped)}` : '';
		if (!all.length) {
			const post = vscode.l10n.t('Post "No Issues Found"');
			if (await vscode.window.showInformationMessage(vscode.l10n.t('No new issues in #{0}.{1}', result.pr.number, already), { detail: result.summary }, post) === post) {
				await this.post(github, target.repo, result, [], []);
			}
			return;
		}
		type Item = vscode.QuickPickItem & { finding: Finding };
		const openButton: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('go-to-file'), tooltip: vscode.l10n.t('Open the Line') };
		const items: Item[] = all.map(finding => ({
			label: `${SEVERITY_ICON[finding.severity]} ${finding.title}`,
			description: `${finding.path}:${finding.line}${result.general.includes(finding) ? ` · ${vscode.l10n.t('in the summary')}` : ''}`,
			detail: finding.body,
			picked: true,
			buttons: [openButton],
			finding,
		}));
		const pick = vscode.window.createQuickPick<Item>();
		pick.title = vscode.l10n.t('Review of #{0}: tick the findings to post', result.pr.number);
		pick.placeholder = `${result.summary}${already}`;
		pick.canSelectMany = true;
		pick.matchOnDescription = true;
		pick.matchOnDetail = true;
		pick.ignoreFocusOut = true;
		pick.items = items;
		pick.selectedItems = items;
		pick.onDidTriggerItemButton(async e => {
			const uri = vscode.Uri.joinPath(target.root, e.item.finding.path);
			const line = Math.max(0, e.item.finding.line - 1);
			await vscode.window.showTextDocument(uri, { preview: true, preserveFocus: true, selection: new vscode.Range(line, 0, line, 0) }).then(undefined, () => vscode.window.showWarningMessage(vscode.l10n.t('{0} is not in this checkout.', e.item.finding.path)));
		});
		const chosen = await new Promise<Finding[] | undefined>(resolve => {
			pick.onDidAccept(() => {
				const findings = pick.selectedItems.map(i => i.finding);
				pick.hide();
				resolve(findings);
			});
			pick.onDidHide(() => {
				pick.dispose();
				resolve(undefined);
			});
			pick.show();
		});
		if (!chosen?.length) {
			return;
		}
		const confirm = vscode.l10n.t('Post Review');
		if (await vscode.window.showInformationMessage(vscode.l10n.t('Post {0} comments on #{1} as you?', chosen.length, result.pr.number), { modal: true, detail: vscode.l10n.t('They are posted to GitHub as one review, which everyone on the pull request can see.') }, confirm) !== confirm) {
			return;
		}
		await this.post(github, target.repo, result, result.inline.filter(f => chosen.includes(f)), result.general.filter(f => chosen.includes(f)));
	}

	private async post(github: GitHub, repo: string, result: ReviewResult, inline: Finding[], general: Finding[]): Promise<void> {
		try {
			const posted = await postReview(github, repo, result, inline, general);
			const open = vscode.l10n.t('Open on GitHub');
			if (await vscode.window.showInformationMessage(vscode.l10n.t('Posted the review on #{0}.', result.pr.number), open) === open) {
				await vscode.env.openExternal(vscode.Uri.parse(posted.html_url || result.pr.html_url));
			}
		} catch (err) {
			vscode.window.showErrorMessage(vscode.l10n.t('Could not post the review: {0}', (err as Error).message));
		}
	}

	/** Adds the workflow and script that review every pull request push, and says which secret to add. */
	async setUpBot(): Promise<void> {
		const target = await this.repository();
		if (!target) {
			return;
		}
		// GitHub's runners cannot reach a model on this computer, and Copilot needs an editor
		// sign-in, so those fall back to Claude.
		const choice = this.endpoints.current();
		const local = !!choice && /\/\/(localhost|127\.|0\.0\.0\.0|\[::1\])/.test(choice.endpoint.baseUrl);
		const cloud = local || choice?.endpoint.provider === 'copilot' ? undefined : choice;
		const provider = cloud?.endpoint.provider ?? 'anthropic';
		const model = cloud?.model ?? PRESETS[0].models[1];
		const baseUrl = cloud?.endpoint.baseUrl ?? '';
		const script = await readFile(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'reviewBot.mjs').fsPath, 'utf8');
		const workflow = workflowYaml(provider, model, baseUrl);
		const files: [string, string][] = [
			['.github/workflows/nighthawk-review.yml', workflow],
			['.github/nighthawk/review.mjs', script],
		];
		const instructions = vscode.Uri.joinPath(target.root, '.nighthawk', 'review.md');
		const hasInstructions = await vscode.workspace.fs.stat(instructions).then(() => true, () => false);
		if (!hasInstructions) {
			files.push(['.nighthawk/review.md', INSTRUCTIONS_TEMPLATE]);
		}
		const edit = new vscode.WorkspaceEdit();
		for (const [file, text] of files) {
			edit.createFile(vscode.Uri.joinPath(target.root, file), { overwrite: true, contents: new TextEncoder().encode(text) });
		}
		if (!await vscode.workspace.applyEdit(edit)) {
			return;
		}
		await vscode.window.showTextDocument(vscode.Uri.joinPath(target.root, files[0][0]));
		const secrets = vscode.l10n.t('Open Secrets Settings');
		const message = local
			? vscode.l10n.t('Added the review workflow. GitHub cannot reach your local model, so it uses {0} from Anthropic: add an Anthropic API key as the repository secret NIGHTHAWK_REVIEW_API_KEY (or set the variables NIGHTHAWK_REVIEW_PROVIDER, _MODEL and _BASE_URL for another provider), then commit and push.', model)
			: vscode.l10n.t('Added the review workflow, set to {0}. Add your API key as the repository secret NIGHTHAWK_REVIEW_API_KEY, then commit and push. Every pull request push gets a review.', model);
		if (await vscode.window.showInformationMessage(message, { modal: false }, secrets) === secrets) {
			await vscode.env.openExternal(vscode.Uri.parse(`https://github.com/${target.repo}/settings/secrets/actions/new`));
		}
	}
}

function workflowYaml(provider: string, model: string, baseUrl: string): string {
	const quote = (value: string) => `'${value.replace(/'/g, '\'\'')}'`;
	return `# Reviews every pull request with a model and posts the findings as review comments.
# Added by Nighthawk's "AI: Set Up Automatic PR Reviews". Needs the repository secret
# NIGHTHAWK_REVIEW_API_KEY; the variables NIGHTHAWK_REVIEW_PROVIDER (anthropic or openai),
# NIGHTHAWK_REVIEW_MODEL and NIGHTHAWK_REVIEW_BASE_URL change the defaults below.
# The repository's own review instructions go in .nighthawk/review.md.
name: Nighthawk Review

on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]

permissions:
  contents: read
  pull-requests: write

concurrency:
  group: nighthawk-review-\${{ github.event.pull_request.number }}
  cancel-in-progress: true

jobs:
  review:
    if: github.event.pull_request.draft == false
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v4
        with:
          sparse-checkout: .github/nighthawk
          persist-credentials: false
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - name: Review
        run: node .github/nighthawk/review.mjs
        env:
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          PR_NUMBER: \${{ github.event.pull_request.number }}
          NIGHTHAWK_REVIEW_API_KEY: \${{ secrets.NIGHTHAWK_REVIEW_API_KEY }}
          NIGHTHAWK_REVIEW_PROVIDER: \${{ vars.NIGHTHAWK_REVIEW_PROVIDER || ${quote(provider)} }}
          NIGHTHAWK_REVIEW_MODEL: \${{ vars.NIGHTHAWK_REVIEW_MODEL || ${quote(model)} }}
          NIGHTHAWK_REVIEW_BASE_URL: \${{ vars.NIGHTHAWK_REVIEW_BASE_URL || ${quote(baseUrl)} }}
`;
}

const INSTRUCTIONS_TEMPLATE = `# Review instructions

Nighthawk's pull request reviewer reads this file (from the pull request's branch) and follows it before its own rules. Write what matters in this repository, for example:

- Every API handler checks the caller's permissions before reading data.
- Database migrations must be reversible.
- Ignore files under \`generated/\`.
`;
