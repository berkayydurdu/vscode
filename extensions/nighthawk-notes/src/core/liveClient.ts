/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The editor's side of live note editing, without 'vscode' so it can be
// tested with Node. The server puts every edit in order; this keeps at most
// one of our edits on its way at a time and adjusts what is still unsent
// for edits others made meanwhile.

import { apply, compose, transform, type TextOperation } from './textOperation';

export class LiveDocumentState {
	/** The last server revision we know of. */
	revision: number;
	/** The note's text at `revision`, without our edits that are not confirmed. */
	confirmed: string;
	/** Sent and waiting for the server to confirm. */
	outstanding: TextOperation | undefined;
	/** Made while `outstanding` is on its way; sent once it is confirmed. */
	buffer: TextOperation | undefined;

	constructor(revision: number, content: string) {
		this.revision = revision;
		this.confirmed = content;
	}

	/** True while some of our edits have not been confirmed. */
	get pending(): boolean {
		return !!this.outstanding;
	}

	/** Records an edit made in the editor. Returns it when it should be sent now. */
	local(op: TextOperation): TextOperation | undefined {
		if (!this.outstanding) {
			this.outstanding = op;
			return op;
		}
		this.buffer = this.buffer ? compose(this.buffer, op) : op;
		return undefined;
	}

	/**
	 * What a remote edit becomes in the editor, which has our unconfirmed edits.
	 * Does not change anything, so it can be computed again if the editor
	 * changes before the result is applied.
	 */
	incoming(op: TextOperation): TextOperation {
		return this.adjust(op).editorOp;
	}

	/** Takes in a remote edit once it is in the editor. */
	remote(op: TextOperation): void {
		const { outstanding, buffer } = this.adjust(op);
		this.outstanding = outstanding;
		this.buffer = buffer;
		this.confirmed = apply(this.confirmed, op);
		this.revision++;
	}

	private adjust(op: TextOperation): { editorOp: TextOperation; outstanding?: TextOperation; buffer?: TextOperation } {
		if (!this.outstanding) {
			return { editorOp: op };
		}
		const [outstanding, afterOutstanding] = transform(this.outstanding, op);
		if (!this.buffer) {
			return { editorOp: afterOutstanding, outstanding };
		}
		const [buffer, afterBuffer] = transform(this.buffer, afterOutstanding);
		return { editorOp: afterBuffer, outstanding, buffer };
	}

	/** The server confirmed our outstanding edit. Returns the next one to send, if any. */
	acknowledged(): TextOperation | undefined {
		if (this.outstanding) {
			this.confirmed = apply(this.confirmed, this.outstanding);
		}
		this.revision++;
		this.outstanding = this.buffer;
		this.buffer = undefined;
		return this.outstanding;
	}
}

export interface StreamEvent {
	event: string;
	data: string;
}

/**
 * Reads server-sent events from text as it arrives. Returns the complete
 * events and what is left over for the next chunk.
 */
export function parseEvents(text: string): { events: StreamEvent[]; rest: string } {
	const events: StreamEvent[] = [];
	const blocks = text.replace(/\r\n/g, '\n').split('\n\n');
	const rest = blocks.pop() ?? '';
	for (const block of blocks) {
		let event = 'message';
		const data: string[] = [];
		for (const line of block.split('\n')) {
			if (line.startsWith('event:')) {
				event = line.slice(6).trim();
			} else if (line.startsWith('data:')) {
				data.push(line.slice(5).replace(/^ /, ''));
			}
		}
		if (data.length) {
			events.push({ event, data: data.join('\n') });
		}
	}
	return { events, rest };
}
