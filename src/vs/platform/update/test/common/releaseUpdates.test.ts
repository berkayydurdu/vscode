/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { findLatestRelease, findReleaseUpdate, IGitHubRelease, parseReleaseTag } from '../../common/releaseUpdates.js';

const commit = (n: number) => String(n).padStart(40, 'a');

function release(build: number, options?: Partial<IGitHubRelease> & { assetNames?: string[] }): IGitHubRelease {
	const tag = `v1.143.0-build.${build}`;
	return {
		tag_name: tag,
		target_commitish: commit(build),
		html_url: `https://github.com/o/r/releases/tag/${tag}`,
		published_at: '2026-10-21T10:00:00Z',
		assets: (options?.assetNames ?? ['Setup.exe', 'app.tar.gz']).map(name => ({
			name,
			browser_download_url: `https://github.com/o/r/releases/download/${tag}/${name}`,
			digest: `sha256:${'AB'.repeat(32)}`,
		})),
		...options,
	};
}

suite('Release updates', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('parses release tags', () => {
		assert.deepStrictEqual(parseReleaseTag('v1.143.0-build.50'), { version: '1.143.0', buildNumber: 50 });
		assert.strictEqual(parseReleaseTag('v1.143.0'), undefined);
		assert.strictEqual(parseReleaseTag('1.143.0-build.50'), undefined);
		assert.strictEqual(parseReleaseTag('v1.143.0-build.50-hotfix'), undefined);
	});

	test('picks the highest build that has the asset, whatever the list order', () => {
		const releases = [release(51), release(53, { assetNames: ['app.tar.gz'] }), release(52), release(49)];
		assert.strictEqual(findLatestRelease(releases, 'Setup.exe')?.buildNumber, 52);
		assert.strictEqual(findLatestRelease(releases, 'app.tar.gz')?.buildNumber, 53);
		assert.strictEqual(findLatestRelease(releases, 'other.zip'), undefined);
	});

	test('skips drafts, prereleases, other tags and malformed entries', () => {
		const releases = [release(60, { draft: true }), release(59, { prerelease: true }), { ...release(58), tag_name: 'nightly' }, null, 'x', release(57)];
		assert.strictEqual(findLatestRelease(releases, 'Setup.exe')?.buildNumber, 57);
		assert.strictEqual(findLatestRelease({ message: 'Not Found' }, 'Setup.exe'), undefined);
	});

	test('offers an update only when the release is newer than the running build', () => {
		const releases = [release(50), release(52)];
		assert.strictEqual(findReleaseUpdate(releases, 'Setup.exe', 52, true), null);
		assert.strictEqual(findReleaseUpdate(releases, 'Setup.exe', 53, true), null);

		assert.deepStrictEqual(findReleaseUpdate(releases, 'Setup.exe', 50, true), {
			version: commit(52),
			productVersion: '1.143.0',
			timestamp: Date.parse('2026-10-21T10:00:00Z'),
			url: 'https://github.com/o/r/releases/download/v1.143.0-build.52/Setup.exe',
			sha256hash: 'ab'.repeat(32),
			buildNumber: 52,
		});
	});

	test('points archives at the release page', () => {
		const update = findReleaseUpdate([release(52)], 'app.tar.gz', 50, false);
		assert.strictEqual(update?.url, 'https://github.com/o/r/releases/tag/v1.143.0-build.52');
	});

	test('falls back to the tag without a commit and skips checksums without a digest', () => {
		const bare = release(52, { target_commitish: 'main' });
		const update = findReleaseUpdate([{ ...bare, assets: bare.assets!.map(a => ({ ...a, digest: null })) }], 'Setup.exe', 50, true);
		assert.strictEqual(update?.version, 'v1.143.0-build.52');
		assert.strictEqual(update?.sha256hash, undefined);
	});
});
