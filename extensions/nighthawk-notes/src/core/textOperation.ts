/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Operational transformation for plain text, used to edit a note together
// live. The same file lives in notes-server/src/textOperation.ts and
// extensions/nighthawk-notes/src/core/textOperation.ts; a test keeps them equal.
//
// An operation walks the whole document once: a positive number keeps that
// many characters, a negative number deletes that many, and a string
// inserts itself. Offsets count UTF-16 code units, like JavaScript strings
// and the editor's document offsets.

export type TextOperation = (number | string)[];

/** Appends one component to an operation, merging it with the last one where possible. */
function push(op: TextOperation, part: number | string): void {
	if (part === 0 || part === '') {
		return;
	}
	const last = op[op.length - 1];
	if (typeof part === 'string') {
		if (typeof last === 'string') {
			op[op.length - 1] = last + part;
		} else if (typeof last === 'number' && last < 0) {
			// Keep inserts before deletes, so equal operations look the same.
			const beforeLast = op[op.length - 2];
			if (typeof beforeLast === 'string') {
				op[op.length - 2] = beforeLast + part;
			} else {
				op.splice(op.length - 1, 0, part);
			}
		} else {
			op.push(part);
		}
	} else if (typeof last === 'number' && (last > 0) === (part > 0)) {
		op[op.length - 1] = last + part;
	} else {
		op.push(part);
	}
}

/** Drops a trailing retain, which changes nothing. */
function trim(op: TextOperation): TextOperation {
	const last = op[op.length - 1];
	if (typeof last === 'number' && last > 0) {
		op.pop();
	}
	return op;
}

/** Characters the operation expects the document to have. */
export function baseLength(op: TextOperation): number {
	let length = 0;
	for (const part of op) {
		if (typeof part === 'number') {
			length += Math.abs(part);
		}
	}
	return length;
}

/** True when the operation is well formed: only integers and non-empty strings. */
export function isTextOperation(value: unknown): value is TextOperation {
	return Array.isArray(value) && value.every(part => typeof part === 'string' ? part.length > 0 : Number.isInteger(part) && part !== 0);
}

/** The operation that replaces `deleteLength` characters at `offset` with `text`. */
export function replaceOperation(offset: number, deleteLength: number, text: string): TextOperation {
	const op: TextOperation = [];
	push(op, offset);
	push(op, text);
	push(op, -deleteLength);
	return op;
}

/**
 * One operation for several non-overlapping replacements, each given
 * against the same document, such as the changes of one editor event.
 */
export function replacementsOperation(changes: readonly { offset: number; deleteLength: number; text: string }[]): TextOperation {
	const op: TextOperation = [];
	let position = 0;
	for (const change of [...changes].sort((a, b) => a.offset - b.offset)) {
		push(op, change.offset - position);
		push(op, change.text);
		push(op, -change.deleteLength);
		position = change.offset + change.deleteLength;
	}
	return op;
}

/** The smallest operation that turns `before` into `after`: common start and end kept. */
export function diffOperation(before: string, after: string): TextOperation {
	let start = 0;
	const max = Math.min(before.length, after.length);
	while (start < max && before.charCodeAt(start) === after.charCodeAt(start)) {
		start++;
	}
	let end = 0;
	while (end < max - start && before.charCodeAt(before.length - 1 - end) === after.charCodeAt(after.length - 1 - end)) {
		end++;
	}
	return replaceOperation(start, before.length - start - end, after.slice(start, after.length - end));
}

/** Applies an operation to a document. Throws when it does not fit. */
export function apply(text: string, op: TextOperation): string {
	let result = '';
	let index = 0;
	for (const part of op) {
		if (typeof part === 'string') {
			result += part;
		} else if (part > 0) {
			if (index + part > text.length) {
				throw new Error('The operation is longer than the document');
			}
			result += text.slice(index, index + part);
			index += part;
		} else {
			index -= part;
			if (index > text.length) {
				throw new Error('The operation deletes past the end of the document');
			}
		}
	}
	// A trailing retain may be left out.
	return result + text.slice(index);
}

/** Reads an operation one component at a time, cutting components as needed. */
class Reader {
	private index = 0;
	/** How much of the current component was already taken. */
	private used = 0;
	private readonly op: TextOperation;

	constructor(op: TextOperation) {
		this.op = op;
	}

	/** The rest of the current component; undefined at the end. */
	peek(): number | string | undefined {
		const part = this.op[this.index];
		if (typeof part === 'string') {
			return part.slice(this.used);
		}
		return part === undefined ? undefined : part > 0 ? part - this.used : part + this.used;
	}

	/** Takes `length` characters of the current component, or all of it. */
	take(length = Infinity): void {
		const part = this.op[this.index];
		const size = typeof part === 'string' ? part.length : Math.abs(part);
		if (this.used + length < size) {
			this.used += length;
		} else {
			this.index++;
			this.used = 0;
		}
	}
}

/** Applies `a` then `b` as one operation. `b` must fit the document `a` produces. */
export function compose(a: TextOperation, b: TextOperation): TextOperation {
	const result: TextOperation = [];
	const ra = new Reader(a);
	const rb = new Reader(b);
	for (; ;) {
		let pa = ra.peek();
		let pb = rb.peek();
		if (typeof pa === 'number' && pa < 0) {
			push(result, pa);
			ra.take();
			continue;
		}
		if (typeof pb === 'string') {
			push(result, pb);
			rb.take();
			continue;
		}
		// Both operations leave the rest of the document as it is.
		pa ??= Infinity;
		pb ??= Infinity;
		if (pa === Infinity && pb === Infinity) {
			return trim(result);
		}
		const length = Math.min(typeof pa === 'string' ? pa.length : pa, Math.abs(pb));
		if (typeof pa === 'string') {
			// Text `a` inserted, which `b` keeps or deletes.
			if (pb > 0) {
				push(result, pa.slice(0, length));
			}
		} else {
			push(result, pb > 0 ? length : -length);
		}
		ra.take(length);
		rb.take(length);
	}
}

/**
 * Given `a` and `b` made on the same document, returns `[a2, b2]` so that
 * `a` then `b2` gives the same document as `b` then `a2`. Where both insert
 * at the same place, `a`'s text comes first.
 */
export function transform(a: TextOperation, b: TextOperation): [TextOperation, TextOperation] {
	const a2: TextOperation = [];
	const b2: TextOperation = [];
	const ra = new Reader(a);
	const rb = new Reader(b);
	for (; ;) {
		let pa = ra.peek();
		let pb = rb.peek();
		if (typeof pa === 'string') {
			push(a2, pa);
			push(b2, pa.length);
			ra.take();
			continue;
		}
		if (typeof pb === 'string') {
			push(a2, pb.length);
			push(b2, pb);
			rb.take();
			continue;
		}
		pa ??= Infinity;
		pb ??= Infinity;
		if (pa === Infinity && pb === Infinity) {
			return [trim(a2), trim(b2)];
		}
		const length = Math.min(Math.abs(pa), Math.abs(pb));
		if (pa > 0 && pb > 0) {
			push(a2, length);
			push(b2, length);
		} else if (pa < 0 && pb > 0) {
			push(a2, -length);
		} else if (pa > 0 && pb < 0) {
			push(b2, -length);
		}
		// Both deleted the same text: nothing left to do for either.
		ra.take(length);
		rb.take(length);
	}
}

/** Where an offset ends up after an operation; text inserted at the offset pushes it along. */
export function transformOffset(offset: number, op: TextOperation): number {
	let position = 0;
	let result = offset;
	for (const part of op) {
		if (position > offset) {
			break;
		}
		if (typeof part === 'string') {
			result += part.length;
		} else if (part > 0) {
			position += part;
		} else {
			result -= Math.min(-part, offset - position);
			position -= part;
		}
	}
	return result;
}
