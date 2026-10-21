/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IUpdate } from './update.js';

/**
 * Updates from GitHub Releases. Each release is tagged `v<version>-build.<N>`, where `N` is the
 * CI run number the product was built from (`product.buildNumber`), and carries one asset per
 * platform. A release is an update when its build number is higher than the running one.
 */

/** The parts of a release from the GitHub REST API (`GET /repos/{owner}/{repo}/releases`) used here. */
export interface IGitHubRelease {
	readonly tag_name: string;
	readonly target_commitish?: string;
	readonly html_url: string;
	readonly draft?: boolean;
	readonly prerelease?: boolean;
	readonly published_at?: string | null;
	readonly assets?: readonly IGitHubReleaseAsset[];
}

export interface IGitHubReleaseAsset {
	readonly name: string;
	readonly browser_download_url: string;
	/** `sha256:<hex>`, set by GitHub for assets uploaded since mid 2025. */
	readonly digest?: string | null;
}

export interface IReleaseBuild {
	readonly version: string;
	readonly buildNumber: number;
}

const releaseTagPattern = /^v(\d+\.\d+\.\d+)-build\.(\d+)$/;

export function parseReleaseTag(tag: string): IReleaseBuild | undefined {
	const match = releaseTagPattern.exec(tag);
	if (!match) {
		return undefined;
	}
	const buildNumber = Number(match[2]);
	return Number.isSafeInteger(buildNumber) ? { version: match[1], buildNumber } : undefined;
}

export interface ILatestRelease extends IReleaseBuild {
	readonly release: IGitHubRelease;
	readonly asset: IGitHubReleaseAsset;
}

/** The published release with the highest build number that has the given asset. */
export function findLatestRelease(releases: unknown, assetName: string): ILatestRelease | undefined {
	if (!Array.isArray(releases)) {
		return undefined;
	}

	let latest: ILatestRelease | undefined;
	for (const release of releases as IGitHubRelease[]) {
		if (!release || typeof release.tag_name !== 'string' || release.draft || release.prerelease) {
			continue;
		}
		const build = parseReleaseTag(release.tag_name);
		const asset = Array.isArray(release.assets) ? release.assets.find(a => a?.name === assetName && typeof a.browser_download_url === 'string') : undefined;
		if (build && asset && (!latest || build.buildNumber > latest.buildNumber)) {
			latest = { ...build, release, asset };
		}
	}
	return latest;
}

const sha256Pattern = /^sha256:([0-9a-f]{64})$/i;
const commitPattern = /^[0-9a-f]{40}$/i;

/**
 * Describes a release as an update. `download` points `url` at the asset itself (for updates
 * that are downloaded and installed); otherwise it points at the release page.
 */
export function toUpdate(latest: ILatestRelease, download: boolean): IUpdate {
	const { release, asset } = latest;
	const commit = release.target_commitish && commitPattern.test(release.target_commitish) ? release.target_commitish : undefined;
	const published = release.published_at ? Date.parse(release.published_at) : NaN;
	return {
		// `version` names the update package on disk and is compared on restart, so it must
		// identify the build; use the commit it was built from, or the tag when that is unknown.
		version: commit ?? release.tag_name,
		productVersion: latest.version,
		timestamp: isNaN(published) ? undefined : published,
		url: download ? asset.browser_download_url : release.html_url,
		sha256hash: asset.digest ? sha256Pattern.exec(asset.digest)?.[1]?.toLowerCase() : undefined,
		buildNumber: latest.buildNumber,
	};
}

/** The update to offer, or `null` when the running build is the latest. */
export function findReleaseUpdate(releases: unknown, assetName: string, currentBuildNumber: number, download: boolean): IUpdate | null {
	const latest = findLatestRelease(releases, assetName);
	return latest && latest.buildNumber > currentBuildNumber ? toUpdate(latest, download) : null;
}
