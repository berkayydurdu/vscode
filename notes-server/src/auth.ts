/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHash, randomBytes, randomInt, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt) as (password: string, salt: Buffer, keylen: number) => Promise<Buffer>;

const KEY_LENGTH = 64;

/** Hashes a password as `scrypt$<salt>$<hash>`, both base64url. */
export async function hashPassword(password: string): Promise<string> {
	const salt = randomBytes(16);
	const hash = await scryptAsync(password, salt, KEY_LENGTH);
	return `scrypt$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
	const [scheme, salt, hash] = stored.split('$');
	if (scheme !== 'scrypt' || !salt || !hash) {
		return false;
	}
	const expected = Buffer.from(hash, 'base64url');
	const actual = await scryptAsync(password, Buffer.from(salt, 'base64url'), expected.length);
	return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** A random bearer token. Only its SHA-256 is stored, so a leaked database does not leak sessions. */
export function newToken(): string {
	return randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
	return createHash('sha256').update(token).digest('hex');
}

/** Invite codes avoid look-alike characters so they can be read out or typed. */
const INVITE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function newInviteCode(): string {
	let code = '';
	for (let i = 0; i < 12; i++) {
		code += INVITE_ALPHABET[randomInt(INVITE_ALPHABET.length)];
	}
	return `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8, 12)}`;
}

/**
 * Counts failed attempts per key in a sliding window, to slow down
 * password guessing without needing any external service.
 */
export class AttemptLimiter {

	private readonly attempts = new Map<string, number[]>();
	private readonly max: number;
	private readonly windowMs: number;

	constructor(max: number, windowMs: number) {
		this.max = max;
		this.windowMs = windowMs;
	}

	isBlocked(key: string, now = Date.now()): boolean {
		return this.recent(key, now).length >= this.max;
	}

	fail(key: string, now = Date.now()): void {
		const recent = this.recent(key, now);
		recent.push(now);
		this.attempts.set(key, recent);
	}

	reset(key: string): void {
		this.attempts.delete(key);
	}

	private recent(key: string, now: number): number[] {
		return (this.attempts.get(key) ?? []).filter(time => now - time < this.windowMs);
	}
}
