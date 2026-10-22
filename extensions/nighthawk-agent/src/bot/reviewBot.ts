/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The automatic pull request reviewer. "AI: Set Up Automatic PR Reviews"
// copies this file, bundled into one script, into a repository with a
// GitHub workflow that runs it on every pull request push:
//
//   GITHUB_TOKEN, GITHUB_REPOSITORY, PR_NUMBER     from the workflow
//   NIGHTHAWK_REVIEW_API_KEY                       a repository secret
//   NIGHTHAWK_REVIEW_PROVIDER, _MODEL, _BASE_URL   repository variables
//
// It posts only findings no earlier run posted, and says "No issues found"
// only on the first run, so pushes do not fill the pull request with noise.

import { postReview, reviewPullRequest, GitHub } from '../core/prReview';
import { modelStream } from '../core/providers';
import type { ProviderKind } from '../core/types';

const DEFAULT_BASE_URLS: Record<ProviderKind, string> = {
	anthropic: 'https://api.anthropic.com',
	openai: 'https://api.openai.com/v1',
};

async function main(env: Record<string, string | undefined>): Promise<void> {
	const required = (name: string) => {
		const value = env[name]?.trim();
		if (!value) {
			throw new Error(`${name} is not set.`);
		}
		return value;
	};
	if (!env.NIGHTHAWK_REVIEW_API_KEY?.trim()) {
		// Pull requests from forks get no secrets; skip rather than fail their checks.
		console.log('NIGHTHAWK_REVIEW_API_KEY is not available to this run (pull requests from forks get no secrets), so there is no review.');
		return;
	}
	const provider: ProviderKind = env.NIGHTHAWK_REVIEW_PROVIDER?.trim() === 'openai' ? 'openai' : 'anthropic';
	const model = required('NIGHTHAWK_REVIEW_MODEL');
	const endpoint = { name: 'Review', provider, baseUrl: env.NIGHTHAWK_REVIEW_BASE_URL?.trim() || DEFAULT_BASE_URLS[provider], models: [model] };
	const github = new GitHub(required('GITHUB_TOKEN'), env.GITHUB_API_URL);
	const repo = required('GITHUB_REPOSITORY');
	const number = Number(required('PR_NUMBER'));
	const signal = AbortSignal.timeout(10 * 60_000);
	const stream = modelStream(endpoint, model, env.NIGHTHAWK_REVIEW_API_KEY.trim(), { thinking: false });

	const result = await reviewPullRequest(github, repo, number, stream, signal, status => console.log(`${status}...`));
	const found = result.inline.length + result.general.length;
	console.log(`${result.summary}\nNew findings: ${found} (${result.inline.length} on lines). Already posted before: ${result.skipped}.`);
	if (!found && result.reviewedBefore) {
		console.log('Nothing new to post.');
		return;
	}
	const posted = await postReview(github, repo, result, result.inline, result.general, signal);
	console.log(`Posted ${posted.html_url}`);
}

const env = (globalThis as { process?: { env: Record<string, string | undefined>; exitCode?: number } }).process;
main(env?.env ?? {}).catch(err => {
	console.error(`Review failed: ${err instanceof Error ? err.message : String(err)}`);
	if (env) {
		env.exitCode = 1;
	}
});
