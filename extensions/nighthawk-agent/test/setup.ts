/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Lets Node load src/core, whose relative imports have no extension (the
// extension build resolves them), by trying the `.ts` file.
import { registerHooks } from 'node:module';

registerHooks({
	resolve(specifier, context, next) {
		if (/^\.\.?\//.test(specifier) && !/\.[cm]?[jt]s$/.test(specifier)) {
			try {
				return next(`${specifier}.ts`, context);
			} catch {
				// Fall through to the normal resolution.
			}
		}
		return next(specifier, context);
	},
});
