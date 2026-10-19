/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export interface SseEvent {
	event: string;
	data: string;
}

/** Splits a server-sent events body into events. */
export async function* readSse(body: AsyncIterable<Uint8Array>): AsyncGenerator<SseEvent> {
	const decoder = new TextDecoder();
	let buffer = '';
	let event = '';
	let data: string[] = [];
	const flush = (): SseEvent | undefined => {
		if (!data.length) {
			event = '';
			return undefined;
		}
		const result = { event: event || 'message', data: data.join('\n') };
		event = '';
		data = [];
		return result;
	};
	const lines = function* (final: boolean): Generator<string> {
		let index: number;
		while ((index = buffer.search(/\r\n|\r|\n/)) >= 0) {
			if (!final && index === buffer.length - 1 && buffer[index] === '\r') {
				break; // May be the first half of \r\n.
			}
			const line = buffer.slice(0, index);
			buffer = buffer.slice(index + (buffer.startsWith('\r\n', index) ? 2 : 1));
			yield line;
		}
		if (final && buffer) {
			const line = buffer;
			buffer = '';
			yield line;
		}
	};
	const handle = (line: string): SseEvent | undefined => {
		if (!line) {
			return flush();
		}
		if (line.startsWith(':')) {
			return undefined;
		}
		const colon = line.indexOf(':');
		const field = colon < 0 ? line : line.slice(0, colon);
		let value = colon < 0 ? '' : line.slice(colon + 1);
		if (value.startsWith(' ')) {
			value = value.slice(1);
		}
		if (field === 'event') {
			event = value;
		} else if (field === 'data') {
			data.push(value);
		}
		return undefined;
	};
	for await (const chunk of body) {
		buffer += decoder.decode(chunk, { stream: true });
		for (const line of lines(false)) {
			const result = handle(line);
			if (result) {
				yield result;
			}
		}
	}
	buffer += decoder.decode();
	for (const line of lines(true)) {
		const result = handle(line);
		if (result) {
			yield result;
		}
	}
	const last = flush();
	if (last) {
		yield last;
	}
}
