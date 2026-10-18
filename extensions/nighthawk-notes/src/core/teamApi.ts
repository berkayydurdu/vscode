/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

const METHODS = new Set(['GET', 'POST', 'PATCH', 'DELETE']);

/**
 * Whether the team workspace page may make this request: only calls within
 * its own team, so the page can never reach other teams or the account.
 */
export function isAllowedRequest(teamId: string, method: string, path: string): boolean {
	if (!METHODS.has(method)) {
		return false;
	}
	const prefix = `/api/teams/${encodeURIComponent(teamId)}`;
	if (path !== prefix && !path.startsWith(prefix + '/') && !path.startsWith(prefix + '?')) {
		return false;
	}
	const [route] = path.slice(prefix.length).split('?');
	return /^(\/[A-Za-z0-9_-]+)*$/.test(route) && !/[#\\]/.test(path);
}
