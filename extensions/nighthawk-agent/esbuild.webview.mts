/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import path from 'path';
import { run } from '../esbuild-webview-common.mts';

const srcDir = path.join(import.meta.dirname, 'webview-src');
const outDir = path.join(import.meta.dirname, 'media');

run({
	entryPoints: {
		'agent': path.join(srcDir, 'main.ts'),
		'usage': path.join(srcDir, 'usage.ts'),
		'inlineEdit': path.join(srcDir, 'inlineEdit.ts'),
	},
	srcDir,
	outdir: outDir,
}, process.argv);
