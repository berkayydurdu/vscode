/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { isWeb } from '../utils/platform';

export const file = 'file';
export const untitled = 'untitled';
export const git = 'git';
export const github = 'github';
export const azurerepos = 'azurerepos';
export const chatEditingTextModel = 'chat-editing-text-model';

/** Live share scheme */
export const vsls = 'vsls';
export const walkThroughSnippet = 'walkThroughSnippet';
export const vscodeNotebookCell = 'vscode-notebook-cell';
export const officeScript = 'office-script';

/** Nighthawk's multibuffers: excerpts of many files in one document, which is never valid code as a whole */
export const nighthawkMultibuffer = 'nighthawk-multibuffer';

/** Used for code blocks in chat by vs code core */
export const chatCodeBlock = 'vscode-chat-code-block';

export function getSemanticSupportedSchemes() {
	const alwaysSupportedSchemes = [
		untitled,
		walkThroughSnippet,
		vscodeNotebookCell,
		chatCodeBlock,
	];

	if (isWeb()) {
		return [
			...(vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri.scheme),
			...alwaysSupportedSchemes,
		];
	}

	return [
		file,
		...alwaysSupportedSchemes,
	];
}

/**
 * File scheme for which JS/TS language feature should be disabled
 */
export const disabledSchemes = new Set([
	git,
	vsls,
	github,
	azurerepos,
	chatEditingTextModel,
	nighthawkMultibuffer,
]);

export function isOfScheme(uri: vscode.Uri, ...schemes: string[]): boolean {
	const normalizedUriScheme = uri.scheme.toLowerCase();
	return schemes.some(scheme => normalizedUriScheme === scheme);
}
