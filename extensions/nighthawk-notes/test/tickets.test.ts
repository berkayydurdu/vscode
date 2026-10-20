/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { findTicketKeys, mentionsTicket, ticketBranchName, ticketPrefix } from '../src/core/tickets.ts';
import { ticketPrefix as pagePrefix } from '../webview-src/workspace/util.ts';

describe('tickets linked to code', () => {
	it('derives the same prefix as the workspace page', () => {
		const names = ['Nighthawk Core', 'Design', 'a b c d e', '\u00c9quipe Rouge', '42 Labs', ''];
		assert.deepEqual(names.map(ticketPrefix), ['NC', 'DES', 'ABCD', '\u00c9R', '4L', 'T']);
		assert.deepEqual(names.map(pagePrefix), names.map(ticketPrefix));
	});

	it('finds keys in branch names and messages', () => {
		const keys = (text: string) => findTicketKeys(text, ['NC', 'DES']).map(ref => ref.key);
		assert.deepEqual(
			['nc-12-fix-login', 'feature/NC-12', 'NC_7 and nc 8', 'Fix crash (DES-3), see NC-120', 'sync-12', 'xnc-12', 'NC-0'].map(keys),
			[['NC-12'], ['NC-12'], ['NC-7', 'NC-8'], ['DES-3', 'NC-120'], [], [], []],
		);
		assert.equal(mentionsTicket('Fix NC-120', 'NC-12'), false);
		assert.equal(mentionsTicket('nc-12: fix', 'NC-12'), true);
	});

	it('names branches after the ticket', () => {
		assert.equal(ticketBranchName('NC-12', 'Fix the login redirect after sign-out on Safari'), 'nc-12-fix-the-login-redirect-after-sign-out-on');
		assert.equal(ticketBranchName('NC-3', '\u00dcn\u00efcode \u2713'), 'nc-3-unicode');
		assert.equal(ticketBranchName('NC-4', '!!!'), 'nc-4');
	});
});
