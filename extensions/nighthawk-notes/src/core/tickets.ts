/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Short ticket prefix from a team name: "Nighthawk Core" is NC. The
 * workspace page computes the same in `Model.prefix`; a test keeps them equal.
 */
export function ticketPrefix(teamName: string): string {
	const words = teamName.replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
	const prefix = words.length > 1 ? words.map(w => w[0]).join('').slice(0, 4) : (words[0] ?? 'T').slice(0, 3);
	return prefix.toUpperCase();
}

export interface TicketRef {
	prefix: string;
	number: number;
	/** "NC-12" */
	key: string;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Finds ticket keys such as "NC-12" in a branch name or commit message,
 * case-insensitively and in the order they appear, without duplicates.
 * `nc-12-fix-login`, `feature/NC-12`, `NC_12` and "Fix crash (NC-12)" all match.
 */
export function findTicketKeys(text: string, prefixes: readonly string[]): TicketRef[] {
	if (!prefixes.length) {
		return [];
	}
	const alternatives = [...new Set(prefixes)].sort((a, b) => b.length - a.length).map(escapeRegExp).join('|');
	const pattern = new RegExp(`(?<![\\p{L}\\p{N}])(?<prefix>${alternatives})[-_ ]?(?<number>\\d+)(?!\\d)`, 'giu');
	const found = new Map<string, TicketRef>();
	for (const match of text.matchAll(pattern)) {
		const prefix = match.groups!.prefix.toUpperCase();
		const number = Number(match.groups!.number);
		const key = `${prefix}-${number}`;
		if (number > 0 && !found.has(key)) {
			found.set(key, { prefix, number, key });
		}
	}
	return [...found.values()];
}

/** True when `text` mentions the ticket `key` ("NC-12"), with the same matching as {@link findTicketKeys}. */
export function mentionsTicket(text: string, key: string): boolean {
	const [prefix] = key.split('-');
	return findTicketKeys(text, [prefix]).some(ref => ref.key === key.toUpperCase());
}

/** A branch name for a ticket: "nc-12-fix-the-login-redirect". */
export function ticketBranchName(key: string, title: string): string {
	const words = title
		.normalize('NFKD')
		.replace(/\p{M}/gu, '')
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter(Boolean);
	let slug = '';
	for (const word of words) {
		const next = slug ? `${slug}-${word}` : word;
		if (next.length > 40) {
			break;
		}
		slug = next;
	}
	return slug ? `${key.toLowerCase()}-${slug}` : key.toLowerCase();
}
