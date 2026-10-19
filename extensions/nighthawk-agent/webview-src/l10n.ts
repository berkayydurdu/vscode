/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

let bundle: Record<string, string> = {};

/** Uses the extension's translations, which it sends with the first message. */
export function setBundle(value: Record<string, string> | undefined): void {
	bundle = value ?? {};
}

/**
 * Translates a message the way `vscode.l10n.t` does: the English text is
 * the key, and `{0}`, `{1}`... are replaced with the arguments.
 */
export function t(message: string, ...args: (string | number)[]): string {
	const text = bundle[message] ?? message;
	return text.replace(/\{(\d+)\}/g, (match, index: string) => {
		const value = args[Number(index)];
		return value === undefined ? match : String(value);
	});
}
