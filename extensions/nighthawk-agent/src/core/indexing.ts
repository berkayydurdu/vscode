/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The codebase index: splits the project's files into chunks of code and
// ranks them for a question. Ranking combines BM25 over identifiers (always
// available, nothing leaves the computer) with similarity of embeddings when
// an embedding model is configured. The index is saved on this computer.

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { isSensitiveFile } from './autocomplete';

/** Turns texts into vectors; the host wraps an endpoint and records usage. */
export interface Embedder {
	/** Changes when the model changes, so old vectors are not mixed with new ones. */
	readonly id: string;
	embed(texts: string[], signal: AbortSignal): Promise<number[][]>;
}

export interface Chunk {
	/** 1-based, inclusive. */
	start: number;
	end: number;
	/** Of the text sent for embedding, so unchanged chunks keep their vectors. */
	hash: string;
	chars: number;
	/** Names declared in the chunk, such as functions and classes. */
	symbols: string[];
	/** Sorted term ids and how often each occurs. */
	terms: Uint32Array;
	counts: Uint16Array;
	/** Total weighted term count, for BM25's length normalization. */
	length: number;
}

interface FileEntry {
	mtime: number;
	size: number;
	chunks: Chunk[];
}

export interface IndexStatus {
	state: 'starting' | 'scanning' | 'indexing' | 'embedding' | 'ready' | 'error';
	files: number;
	chunks: number;
	/** Chunks with a vector from the current embedding model. */
	embedded: number;
	/** Progress through the current step, when it has one. */
	done?: number;
	total?: number;
	/** Why chunks are not being embedded, such as a refused API key. */
	embedError?: string;
	error?: string;
}

export interface SearchOptions {
	/** Extra words to match, such as likely identifiers and synonyms. */
	keywords?: string[];
	limit?: number;
	/** Only files under this folder. */
	under?: string;
}

export interface SearchResult {
	file: string;
	start: number;
	end: number;
	score: number;
	symbols: string[];
	/** The chunk's current lines. */
	text: string;
	/** Matched by meaning (embeddings), by words, or both. */
	via: 'meaning' | 'words' | 'both';
}

export interface IndexOptions {
	roots: string[];
	/** Where the index is saved; one folder per workspace. */
	storageDir: string;
	/** The files to index: absolute paths, with ignored files already left out. */
	listFiles(signal: AbortSignal): Promise<string[]>;
	maxFileSize?: number;
	/** Called whenever the status changes. */
	onStatus?(status: IndexStatus): void;
}

const VERSION = 1;
const MAX_FILE_SIZE = 1024 * 1024;
const TARGET_LINES = 40;
const MAX_LINES = 80;
const MAX_CHUNK_CHARS = 4000;
const EMBED_BATCH = 32;

// --- What gets indexed

const BINARY_EXTENSIONS = new Set([
	'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'icns', 'tif', 'tiff', 'psd', 'svgz',
	'mp3', 'mp4', 'wav', 'ogg', 'flac', 'mov', 'avi', 'webm', 'mkv',
	'zip', 'gz', 'tgz', 'bz2', 'xz', 'zst', '7z', 'rar', 'tar', 'jar', 'war', 'whl', 'vsix', 'asar',
	'exe', 'dll', 'so', 'dylib', 'o', 'a', 'lib', 'obj', 'bin', 'class', 'pyc', 'pyo', 'wasm', 'node',
	'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'woff', 'woff2', 'ttf', 'otf', 'eot',
	'db', 'sqlite', 'sqlite3', 'map', 'snap', 'lock',
]);

const GENERATED_NAMES = new Set([
	'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'cargo.lock',
	'poetry.lock', 'pipfile.lock', 'composer.lock', 'gemfile.lock', 'go.sum', 'flake.lock', 'uv.lock',
]);

/** Whether a file is worth indexing, judging by its name. Files that usually hold secrets never are. */
export function isIndexableName(file: string): boolean {
	const name = path.basename(file).toLowerCase();
	if (isSensitiveFile(file) || GENERATED_NAMES.has(name) || /\.min\.(js|css)$/.test(name)) {
		return false;
	}
	const dot = name.lastIndexOf('.');
	return dot < 0 || !BINARY_EXTENSIONS.has(name.slice(dot + 1));
}

/** Text that looks generated or binary: NUL bytes or very long lines (minified code). */
export function looksGenerated(text: string): boolean {
	if (text.includes('\u0000')) {
		return true;
	}
	const lines = text.length ? text.split('\n').length : 1;
	return text.length > 2000 && text.length / lines > 300;
}

const SECRET_PATTERNS: [RegExp, string][] = [
	[/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '<private key>'],
	[/\b(?:sk-ant-[\w-]{20,}|sk-(?:proj-)?[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_\w{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35}|glpat-[\w-]{20})\b/g, '<secret>'],
	[/((?:api[_-]?key|secret|password|passwd|token|credential)[\w-]*["']?\s*[:=]\s*["'`])[^"'`\s]{8,}(["'`])/gi, '$1<secret>$2'],
];

/** Removes things that look like keys and passwords from text before it is sent anywhere. */
export function redactSecrets(text: string): string {
	return SECRET_PATTERNS.reduce((out, [pattern, replacement]) => out.replace(pattern, replacement), text);
}

// --- Words

const STOP_WORDS = new Set([
	'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'can', 'do', 'does', 'for', 'from', 'get', 'has', 'have', 'how', 'if', 'in', 'is', 'it',
	'its', 'me', 'my', 'no', 'not', 'of', 'on', 'or', 'our', 'so', 'that', 'the', 'their', 'then', 'there', 'this', 'to', 'up', 'us', 'was',
	'we', 'what', 'when', 'where', 'which', 'who', 'why', 'will', 'with', 'you', 'your', 'code', 'file', 'files', 'find', 'handle', 'handled',
	'handles', 'handling', 'happen', 'happens', 'implement', 'implemented', 'implementation', 'logic', 'place', 'part', 'show', 'some', 'thing', 'used', 'uses', 'way', 'work', 'works',
	'const', 'let', 'var', 'new', 'return', 'true', 'false', 'null', 'undefined', 'none', 'nil', 'self', 'this', 'import', 'export', 'public', 'private',
	'protected', 'static', 'void', 'string', 'number', 'int', 'bool', 'boolean', 'else', 'elif',
]);

/** A light stemmer so "tokens", "token" and "tokenized" meet. */
export function stem(word: string): string {
	let w = word;
	if (w.length > 4 && w.endsWith('ies')) {
		w = `${w.slice(0, -3)}y`;
	} else if (w.length > 5 && w.endsWith('ing')) {
		w = w.slice(0, -3);
	} else if (w.length > 4 && w.endsWith('ed')) {
		w = w.slice(0, -2);
	} else if (w.length > 4 && /(ch|sh|ss|x|z)es$/.test(w)) {
		w = w.slice(0, -2);
	} else if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) {
		w = w.slice(0, -1);
	}
	if (w.length > 3 && w.endsWith('e')) {
		w = w.slice(0, -1);
	}
	return w;
}

/** Splits `parseHTTPResponse_v2` into `parse`, `http`, `response`, `v2`. */
export function identifierParts(word: string): string[] {
	return word
		.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
		.replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
		.split(/[\s_$]+/)
		.filter(Boolean)
		.map(p => p.toLowerCase());
}

const wordTerms = new Map<string, readonly string[]>();

/** The terms of one identifier, cached: the same names repeat across a project. */
function termsOfWord(word: string): readonly string[] {
	let terms = wordTerms.get(word);
	if (!terms) {
		const out: string[] = [];
		const parts = identifierParts(word);
		if (parts.length > 1) {
			const whole = parts.join('');
			if (!STOP_WORDS.has(whole)) {
				out.push(stem(whole));
			}
		}
		for (const part of parts) {
			if (part.length >= 2 && !STOP_WORDS.has(part) && !/^\d+$/.test(part)) {
				out.push(stem(part));
			}
		}
		terms = out;
		if (wordTerms.size > 500_000) {
			wordTerms.clear();
		}
		wordTerms.set(word, terms);
	}
	return terms;
}

/** The searchable terms of some text: whole identifiers and their parts, stemmed, without stop words. */
export function tokenize(text: string): string[] {
	const out: string[] = [];
	for (const match of text.matchAll(/[A-Za-z_$][A-Za-z0-9_$]*/g)) {
		if (match[0].length <= 64) {
			out.push(...termsOfWord(match[0]));
		}
	}
	return out;
}

/** Terms of a question: also joins neighbouring words, so "sign in" finds `signIn`. */
export function queryTerms(query: string): string[] {
	const terms = tokenize(query);
	const words = query.toLowerCase().match(/[a-z0-9]+/g) ?? [];
	for (let i = 0; i + 1 < words.length; i++) {
		if (words[i].length + words[i + 1].length >= 5) {
			terms.push(stem(words[i] + words[i + 1]));
		}
	}
	return terms;
}

// --- Chunks

const DECLARATION = /^\s*(?:export\s+)?(?:default\s+)?(?:public\s+|private\s+|protected\s+|internal\s+|static\s+|abstract\s+|async\s+|override\s+|readonly\s+|pub(?:\([a-z]+\))?\s+|unsafe\s+|final\s+|open\s+|data\s+|sealed\s+)*(class|interface|enum|struct|trait|impl|type|function|func|fn|def|module|namespace|object|record|protocol|extension|const|let|var|val)\s+([A-Za-z_$][\w$]*)/;
const METHOD = /^\s+(?:(?:public|private|protected|static|async|override|readonly|get|set)\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\([^)]*\)?\s*(?::[^=]*)?\s*\{?\s*$/;
/** A quick check before the slower patterns above. */
const DECLARATION_HINT = /[({:=]|\b(?:class|interface|enum|struct|trait|impl|type|def|fn|func|function|module|namespace)\b/;
const NOT_METHOD = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'else', 'with', 'elif', 'until', 'when']);

/** The name a line declares, if it starts a function, class or similar. */
export function declaredName(line: string): string | undefined {
	if (line.length > 300) {
		return undefined;
	}
	const decl = DECLARATION.exec(line);
	if (decl) {
		// Variables count only at the top level, not inside functions.
		return /^(const|let|var|val)$/.test(decl[1]) && /^\s/.test(line) ? undefined : decl[2];
	}
	const method = METHOD.exec(line);
	return method && !NOT_METHOD.has(method[1]) ? method[1] : undefined;
}

function indentOf(line: string): number {
	let n = 0;
	for (const c of line) {
		if (c === ' ') {
			n++;
		} else if (c === '\t') {
			n += 4;
		} else {
			break;
		}
	}
	return n;
}

/**
 * Splits a file into line ranges of about 40 lines, cutting where a new
 * declaration or block starts at a low indentation, so a chunk tends to hold
 * whole functions. No chunk is longer than 80 lines or 4000 characters.
 */
export function chunkLines(lines: string[]): { start: number; end: number }[] {
	const ranges: { start: number; end: number }[] = [];
	const n = lines.length;
	// The cost of cutting before each line: lower is a better place.
	const cutCost = (i: number): number => {
		const line = lines[i];
		if (!line.trim()) {
			return 1000;
		}
		const blankBefore = i > 0 && !lines[i - 1].trim();
		return indentOf(line) * 2 + (blankBefore ? 0 : 3) + (/^\s*[)\]}]/.test(line) ? 50 : 0) - (declaredName(line) ? 2 : 0);
	};
	let start = 0;
	while (start < n) {
		let end = start;
		let chars = 0;
		while (end < n && end - start < MAX_LINES && (chars + lines[end].length < MAX_CHUNK_CHARS || end === start)) {
			chars += lines[end].length + 1;
			end++;
		}
		if (end < n && end - start > TARGET_LINES / 2) {
			// Cut at the best place in the second half of the window.
			let best = end;
			let bestCost = Infinity;
			for (let i = Math.max(start + 1, start + Math.floor((end - start) / 2)); i < end; i++) {
				const cost = cutCost(i) + Math.abs(i - start - TARGET_LINES) * 0.05;
				if (cost < bestCost) {
					bestCost = cost;
					best = i;
				}
			}
			end = best;
		}
		// Leave out blank lines at the edges.
		let s = start;
		let e = end - 1;
		while (s < e && !lines[s].trim()) {
			s++;
		}
		while (e > s && !lines[e].trim()) {
			e--;
		}
		if (lines.slice(s, e + 1).some(l => l.trim())) {
			ranges.push({ start: s + 1, end: e + 1 });
		}
		start = end;
	}
	return ranges;
}

/** The nearest less-indented line above a chunk, such as its class, to give the chunk context. */
export function enclosingLine(lines: string[], start: number): string | undefined {
	const first = lines[start - 1] ?? '';
	let indent = indentOf(first);
	for (let i = start - 2; i >= 0 && i > start - 400 && indent > 0; i--) {
		const line = lines[i];
		if (line.trim() && indentOf(line) < indent) {
			if (declaredName(line)) {
				return line.trim();
			}
			indent = indentOf(line);
		}
	}
	return undefined;
}

/** The text sent to the embedding model for a chunk: its path, context and code, without secrets. */
export function embeddingText(relPath: string, lines: string[], start: number, end: number): string {
	const context = enclosingLine(lines, start);
	const body = lines.slice(start - 1, end).join('\n').slice(0, MAX_CHUNK_CHARS * 2);
	return redactSecrets(`${relPath}\n${context ? `${context}\n...\n` : ''}${body}`);
}

// --- Vectors

/** Scales a vector to length 1 and stores it in a byte per dimension. */
export function quantize(vector: ArrayLike<number>): Int8Array {
	let norm = 0;
	for (let i = 0; i < vector.length; i++) {
		norm += vector[i] * vector[i];
	}
	norm = Math.sqrt(norm) || 1;
	const out = new Int8Array(vector.length);
	for (let i = 0; i < vector.length; i++) {
		out[i] = Math.max(-127, Math.min(127, Math.round(vector[i] / norm * 127)));
	}
	return out;
}

function dot(a: Int8Array, b: Int8Array): number {
	let sum = 0;
	const n = Math.min(a.length, b.length);
	for (let i = 0; i < n; i++) {
		sum += a[i] * b[i];
	}
	return sum / (127 * 127);
}

// --- The index

interface Ranked {
	file: string;
	chunk: Chunk;
	score: number;
}

function toSlash(p: string): string {
	return p.split(path.sep).join('/');
}

/**
 * A copy of a string that does not point into the text it was cut from;
 * otherwise each kept name would keep its whole file in memory.
 */
function ownCopy(text: string): string {
	return Buffer.from(text, 'utf8').toString('utf8');
}

function yieldToEventLoop(): Promise<void> {
	return new Promise(resolve => setImmediate(resolve));
}

/** Reciprocal rank fusion: merges rankings without comparing their scores. */
export function fuseRankings<T>(rankings: T[][], key: (item: T) => string, k = 60): { item: T; score: number; lists: number }[] {
	const merged = new Map<string, { item: T; score: number; lists: number }>();
	for (const ranking of rankings) {
		ranking.forEach((item, rank) => {
			const id = key(item);
			const entry = merged.get(id) ?? { item, score: 0, lists: 0 };
			entry.score += 1 / (k + rank + 1);
			entry.lists++;
			merged.set(id, entry);
		});
	}
	return [...merged.values()].sort((a, b) => b.score - a.score);
}

/**
 * The index of one workspace. Updates run one at a time; searches can run
 * while an update is in progress and see what is indexed so far.
 */
export class CodeIndex {
	private readonly files = new Map<string, FileEntry>();
	private readonly dictionary = new Map<string, number>();
	private readonly words: string[] = [];
	/** How many chunks contain each term. */
	private documentFrequency: number[] = [];
	private chunkCount = 0;
	private totalLength = 0;
	private vectors = new Map<string, Int8Array>();
	private vectorModel = '';
	private embedder: Embedder | undefined;
	private embedError: string | undefined;
	private queue: Promise<unknown> = Promise.resolve();
	private abort = new AbortController();
	private status: IndexStatus = { state: 'starting', files: 0, chunks: 0, embedded: 0 };
	private dirty = false;
	private readonly options: IndexOptions;

	constructor(options: IndexOptions) {
		this.options = options;
	}

	get roots(): string[] {
		return this.options.roots;
	}

	getStatus(): IndexStatus {
		return { ...this.status, files: this.files.size, chunks: this.chunkCount, embedded: this.embeddedCount(), embedError: this.embedError };
	}

	private setStatus(update: Partial<IndexStatus>): void {
		this.status = { ...this.status, done: undefined, total: undefined, ...update };
		this.options.onStatus?.(this.getStatus());
	}

	private embeddedCount(): number {
		if (!this.embedder || this.vectorModel !== this.embedder.id) {
			return 0;
		}
		let count = 0;
		for (const entry of this.files.values()) {
			for (const chunk of entry.chunks) {
				count += this.vectors.has(chunk.hash) ? 1 : 0;
			}
		}
		return count;
	}

	/** Uses a new embedding model, or none; vectors from another model are dropped. */
	setEmbedder(embedder: Embedder | undefined): void {
		this.embedder = embedder;
		this.embedError = undefined;
		if (embedder && embedder.id !== this.vectorModel) {
			if (this.vectors.size) {
				this.dirty = true;
			}
			this.vectors = new Map();
			this.vectorModel = embedder.id;
		}
		this.options.onStatus?.(this.getStatus());
	}

	/** Stops the running update; later updates still run. */
	cancel(): void {
		this.abort.abort();
		this.abort = new AbortController();
	}

	private run<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> {
		const result = this.queue.then(() => task(this.abort.signal));
		this.queue = result.catch(() => undefined);
		return result;
	}

	// --- Terms

	private termId(word: string): number {
		let id = this.dictionary.get(word);
		if (id === undefined) {
			id = this.words.length;
			word = ownCopy(word);
			this.words.push(word);
			this.dictionary.set(word, id);
			this.documentFrequency.push(0);
		}
		return id;
	}

	private makeChunk(range: { start: number; end: number }, lines: string[], relPath: string, pathTerms: string[]): Chunk {
		const counts = new Map<string, number>();
		let length = 0;
		const add = (word: string, weight: number) => {
			counts.set(word, (counts.get(word) ?? 0) + weight);
			length += weight;
		};
		const symbols: string[] = [];
		let chars = 0;
		for (let i = range.start - 1; i < range.end; i++) {
			const line = lines[i];
			chars += line.length + 1;
			for (const match of line.matchAll(/[A-Za-z_$][A-Za-z0-9_$]*/g)) {
				if (match[0].length <= 64) {
					for (const word of termsOfWord(match[0])) {
						add(word, 1);
					}
				}
			}
			const name = DECLARATION_HINT.test(line) ? declaredName(line) : undefined;
			if (name && !symbols.includes(name) && symbols.length < 20) {
				symbols.push(ownCopy(name));
				for (const word of termsOfWord(name)) {
					add(word, 3);
				}
			}
		}
		for (const word of pathTerms) {
			add(word, 2);
		}
		const entries = [...counts].map(([word, count]) => [this.termId(word), count] as const).sort((a, b) => a[0] - b[0]);
		const context = enclosingLine(lines, range.start) ?? '';
		const hash = createHash('sha1').update(relPath).update('\u0000').update(context).update('\u0000');
		for (let i = range.start - 1; i < range.end; i++) {
			hash.update(lines[i]).update('\n');
		}
		return {
			start: range.start,
			end: range.end,
			hash: hash.digest('hex').slice(0, 20),
			chars,
			symbols,
			terms: Uint32Array.from(entries, e => e[0]),
			counts: Uint16Array.from(entries, e => Math.min(65535, e[1])),
			length,
		};
	}

	private addEntry(file: string, entry: FileEntry): void {
		this.removeEntry(file);
		packTerms(entry.chunks);
		this.files.set(file, entry);
		for (const chunk of entry.chunks) {
			for (const id of chunk.terms) {
				this.documentFrequency[id]++;
			}
			this.chunkCount++;
			this.totalLength += chunk.length;
		}
		this.dirty = true;
	}

	private removeEntry(file: string): void {
		const old = this.files.get(file);
		if (!old) {
			return;
		}
		for (const chunk of old.chunks) {
			for (const id of chunk.terms) {
				this.documentFrequency[id]--;
			}
			this.chunkCount--;
			this.totalLength -= chunk.length;
		}
		this.files.delete(file);
		this.dirty = true;
	}

	relativePath(file: string): string {
		const root = this.options.roots.find(r => file === r || file.startsWith(r.endsWith(path.sep) ? r : r + path.sep));
		const rel = root ? toSlash(path.relative(root, file)) : toSlash(file);
		return this.options.roots.length > 1 && root ? `${path.basename(root)}/${rel}` : rel;
	}

	/** Chunks one file's text; exposed for tests. */
	chunkText(file: string, text: string): Chunk[] {
		const lines = text.split(/\r?\n/);
		const rel = this.relativePath(file);
		const pathTerms = [...new Set(tokenize(rel.replace(/\.[^./]+$/, '')))];
		return chunkLines(lines).map(range => this.makeChunk(range, lines, rel, pathTerms));
	}

	private indexText(file: string, mtime: number, size: number, text: string | undefined): void {
		if (text === undefined) {
			this.removeEntry(file);
		} else {
			this.addEntry(file, { mtime, size, chunks: looksGenerated(text) ? [] : this.chunkText(file, text) });
		}
	}

	private async indexFile(file: string, mtime: number, size: number): Promise<void> {
		this.indexText(file, mtime, size, await fs.readFile(file, 'utf8').catch(() => undefined));
	}

	// --- Updating

	/** Brings the whole index up to date: new, changed and deleted files, then missing vectors. */
	sync(): Promise<void> {
		return this.run(async signal => {
			try {
				this.setStatus({ state: 'scanning' });
				const listed = await this.options.listFiles(signal);
				const wanted = new Set(listed.filter(isIndexableName));
				for (const file of [...this.files.keys()]) {
					if (!wanted.has(file)) {
						this.removeEntry(file);
					}
				}
				const all = [...wanted];
				const maxSize = this.options.maxFileSize ?? MAX_FILE_SIZE;
				let done = 0;
				let lastStatus = 0;
				for (let i = 0; i < all.length; i += 64) {
					if (signal.aborted) {
						return;
					}
					const batch = all.slice(i, i + 64);
					const stats = await Promise.all(batch.map(file => fs.stat(file).then(s => s, () => undefined)));
					const changed: { file: string; mtime: number; size: number }[] = [];
					batch.forEach((file, j) => {
						const stat = stats[j];
						if (!stat || !stat.isFile() || stat.size > maxSize) {
							this.removeEntry(file);
							return;
						}
						const known = this.files.get(file);
						if (!known || known.mtime !== stat.mtimeMs || known.size !== stat.size) {
							changed.push({ file, mtime: stat.mtimeMs, size: stat.size });
						}
					});
					const texts = await Promise.all(changed.map(c => fs.readFile(c.file, 'utf8').catch(() => undefined)));
					changed.forEach((c, j) => this.indexText(c.file, c.mtime, c.size, texts[j]));
					done += batch.length;
					if (Date.now() - lastStatus > 250) {
						lastStatus = Date.now();
						this.setStatus({ state: 'indexing', done, total: all.length });
						await yieldToEventLoop();
					}
				}
				wordTerms.clear();
				await this.save();
				await this.embedMissing(signal);
				await this.save();
				this.setStatus({ state: 'ready' });
			} catch (err) {
				if (!signal.aborted) {
					this.setStatus({ state: 'error', error: String(err?.message ?? err) });
				}
			}
		});
	}

	/** Re-indexes files that changed or were deleted; paths that should not be indexed are ignored. */
	update(files: string[]): Promise<void> {
		return this.run(async signal => {
			const maxSize = this.options.maxFileSize ?? MAX_FILE_SIZE;
			for (const file of files) {
				const stat = await fs.stat(file).catch(() => undefined);
				if (!stat || !stat.isFile() || stat.size > maxSize) {
					this.removeEntry(file);
				} else if (this.files.has(file)) {
					const known = this.files.get(file)!;
					if (known.mtime !== stat.mtimeMs || known.size !== stat.size) {
						await this.indexFile(file, stat.mtimeMs, stat.size);
					}
				}
			}
			await this.embedMissing(signal);
			await this.save();
			this.setStatus({ state: 'ready' });
		});
	}

	/** Whether the index already holds a file. */
	has(file: string): boolean {
		return this.files.has(file);
	}

	/** Chunks that still need a vector, grouped by file so each file is read once. */
	private missingVectors(): Map<string, Chunk[]> {
		const missing = new Map<string, Chunk[]>();
		for (const [file, entry] of this.files) {
			const chunks = entry.chunks.filter(c => !this.vectors.has(c.hash));
			if (chunks.length) {
				missing.set(file, chunks);
			}
		}
		return missing;
	}

	/** Characters still to embed, for estimating what indexing by meaning costs. */
	pendingEmbeddingChars(): number {
		let chars = 0;
		for (const chunks of this.missingVectors().values()) {
			chars += chunks.reduce((sum, c) => sum + c.chars, 0);
		}
		return chars;
	}

	private async embedMissing(signal: AbortSignal): Promise<void> {
		const embedder = this.embedder;
		if (!embedder || this.embedError) {
			return;
		}
		const missing = this.missingVectors();
		const total = [...missing.values()].reduce((sum, c) => sum + c.length, 0);
		if (!total) {
			return;
		}
		let done = 0;
		let batch: { hash: string; text: string }[] = [];
		const flush = async () => {
			const vectors = await embedder.embed(batch.map(b => b.text), signal);
			if (embedder !== this.embedder) {
				throw new Error('The embedding model changed.');
			}
			batch.forEach((b, i) => {
				if (vectors[i]?.length) {
					this.vectors.set(b.hash, quantize(vectors[i]));
				}
			});
			done += batch.length;
			batch = [];
			this.dirty = true;
			this.setStatus({ state: 'embedding', done, total });
		};
		this.setStatus({ state: 'embedding', done: 0, total });
		let lastSave = Date.now();
		try {
			for (const [file, chunks] of missing) {
				let lines: string[];
				try {
					lines = (await fs.readFile(file, 'utf8')).split(/\r?\n/);
				} catch {
					continue;
				}
				const rel = this.relativePath(file);
				for (const chunk of chunks) {
					if (signal.aborted) {
						return;
					}
					batch.push({ hash: chunk.hash, text: embeddingText(rel, lines, chunk.start, chunk.end) });
					if (batch.length >= EMBED_BATCH) {
						await flush();
						if (Date.now() - lastSave > 30_000) {
							// Keeps the work if the editor closes during a long first run.
							lastSave = Date.now();
							await this.save();
						}
					}
				}
			}
			if (batch.length) {
				await flush();
			}
		} catch (err) {
			if (!signal.aborted && embedder === this.embedder) {
				this.embedError = String(err?.message ?? err);
			}
		}
	}

	// --- Searching

	private keywordRanking(terms: Map<number, number>, under: string | undefined, limit: number): Ranked[] {
		if (!terms.size || !this.chunkCount) {
			return [];
		}
		const k1 = 1.2;
		const b = 0.75;
		const average = this.totalLength / this.chunkCount || 1;
		const weights = [...terms].map(([id, weight]) => {
			const df = this.documentFrequency[id] ?? 0;
			return { id, weight: weight * Math.log(1 + (this.chunkCount - df + 0.5) / (df + 0.5)) };
		}).filter(t => t.weight > 0);
		const ranked: Ranked[] = [];
		for (const [file, entry] of this.files) {
			if (under && !file.startsWith(under)) {
				continue;
			}
			for (const chunk of entry.chunks) {
				let score = 0;
				let matched = 0;
				for (const { id, weight } of weights) {
					const at = binarySearch(chunk.terms, id);
					if (at >= 0) {
						const tf = chunk.counts[at];
						score += weight * tf * (k1 + 1) / (tf + k1 * (1 - b + b * chunk.length / average));
						matched++;
					}
				}
				if (score > 0) {
					// Chunks that match more of the question's words rank higher.
					ranked.push({ file, chunk, score: score * (1 + matched / weights.length) });
				}
			}
		}
		return ranked.sort((x, y) => y.score - x.score).slice(0, limit);
	}

	private vectorRanking(query: Int8Array, under: string | undefined, limit: number): Ranked[] {
		const ranked: Ranked[] = [];
		for (const [file, entry] of this.files) {
			if (under && !file.startsWith(under)) {
				continue;
			}
			for (const chunk of entry.chunks) {
				const vector = this.vectors.get(chunk.hash);
				if (vector) {
					ranked.push({ file, chunk, score: dot(query, vector) });
				}
			}
		}
		return ranked.sort((x, y) => y.score - x.score).slice(0, limit);
	}

	/**
	 * Finds the chunks that best answer a question: by words, and by meaning
	 * when chunks have vectors. Returns at most three chunks per file.
	 */
	async search(query: string, options: SearchOptions = {}, signal: AbortSignal = new AbortController().signal): Promise<{ results: SearchResult[]; byMeaning: boolean }> {
		const limit = Math.max(1, Math.min(options.limit ?? 10, 50));
		const terms = new Map<number, number>();
		for (const word of queryTerms(query)) {
			const id = this.dictionary.get(word);
			if (id !== undefined) {
				terms.set(id, Math.max(terms.get(id) ?? 0, 1));
			}
		}
		for (const keyword of options.keywords ?? []) {
			for (const word of queryTerms(keyword)) {
				const id = this.dictionary.get(word);
				if (id !== undefined) {
					terms.set(id, 1.5);
				}
			}
		}
		const under = options.under ? (options.under.endsWith(path.sep) ? options.under : options.under + path.sep) : undefined;
		const rankings: Ranked[][] = [this.keywordRanking(terms, under, 100)];
		let byMeaning = false;
		const embedder = this.embedder;
		if (embedder && this.vectorModel === embedder.id && this.vectors.size && !this.embedError) {
			try {
				const [vector] = await embedder.embed([query], signal);
				if (vector?.length) {
					rankings.unshift(this.vectorRanking(quantize(vector), under, 100));
					byMeaning = true;
				}
			} catch {
				// Words alone still find something.
			}
		}
		const fused = fuseRankings(rankings, r => `${r.file}\u0000${r.chunk.start}`);
		const perFile = new Map<string, number>();
		const picked: { ranked: Ranked; score: number; lists: number }[] = [];
		for (const { item, score, lists } of fused) {
			const count = perFile.get(item.file) ?? 0;
			if (count >= 3) {
				continue;
			}
			perFile.set(item.file, count + 1);
			picked.push({ ranked: item, score, lists });
			if (picked.length >= limit) {
				break;
			}
		}
		const texts = new Map<string, string[] | undefined>();
		const results: SearchResult[] = [];
		for (const { ranked, score, lists } of picked) {
			if (!texts.has(ranked.file)) {
				texts.set(ranked.file, await fs.readFile(ranked.file, 'utf8').then(t => t.split(/\r?\n/), () => undefined));
			}
			const lines = texts.get(ranked.file);
			if (!lines) {
				continue;
			}
			const inVectors = byMeaning && rankings[0].includes(ranked);
			const via = lists > 1 ? 'both' : inVectors ? 'meaning' : 'words';
			results.push({ file: ranked.file, start: ranked.chunk.start, end: Math.min(ranked.chunk.end, lines.length), score, symbols: ranked.chunk.symbols, text: lines.slice(ranked.chunk.start - 1, ranked.chunk.end).join('\n'), via });
		}
		return { results, byMeaning };
	}

	// --- Saving

	private indexPath(): string {
		return path.join(this.options.storageDir, 'index.json');
	}

	/** Loads the saved index, if it was saved by this version for the same folders. */
	async load(): Promise<void> {
		return this.run(async () => {
			let saved: SavedIndex;
			try {
				saved = JSON.parse(await fs.readFile(this.indexPath(), 'utf8'));
			} catch {
				return;
			}
			if (saved.version !== VERSION || JSON.stringify(saved.roots) !== JSON.stringify(this.options.roots)) {
				return;
			}
			const ids = saved.words.map(word => this.termId(word));
			for (const [file, entry] of Object.entries(saved.files)) {
				this.addEntry(file, {
					mtime: entry.m,
					size: entry.s,
					chunks: entry.c.map(c => ({
						start: c[0], end: c[1], hash: c[2], chars: c[3], symbols: c[4], length: c[5],
						terms: Uint32Array.from(c[6].map(i => ids[i])),
						counts: Uint16Array.from(c[7]),
					})).map(sortTerms),
				});
			}
			if (saved.vectorModel) {
				try {
					const bytes = await fs.readFile(path.join(this.options.storageDir, 'vectors.bin'));
					const dims = saved.dims ?? 0;
					if (dims && bytes.length === dims * saved.vectorHashes.length) {
						const all = new Int8Array(bytes.buffer, bytes.byteOffset, bytes.length);
						saved.vectorHashes.forEach((hash, i) => this.vectors.set(hash, all.slice(i * dims, (i + 1) * dims)));
						this.vectorModel = saved.vectorModel;
					}
				} catch {
					// Vectors are rebuilt when needed.
				}
			}
			this.dirty = false;
			this.options.onStatus?.(this.getStatus());
		});
	}

	/** Saves the index when it changed; terms no chunk uses any more are dropped. */
	private async save(): Promise<void> {
		if (!this.dirty) {
			return;
		}
		this.dirty = false;
		const used = new Map<number, number>();
		const words: string[] = [];
		const files: SavedIndex['files'] = {};
		const live = new Set<string>();
		for (const [file, entry] of this.files) {
			files[file] = {
				m: entry.mtime,
				s: entry.size,
				c: entry.chunks.map(c => {
					live.add(c.hash);
					const terms = [...c.terms].map(id => {
						let local = used.get(id);
						if (local === undefined) {
							local = words.length;
							used.set(id, local);
							words.push(this.words[id]);
						}
						return local;
					});
					return [c.start, c.end, c.hash, c.chars, c.symbols, c.length, terms, [...c.counts]];
				}),
			};
		}
		const vectorHashes = [...this.vectors.keys()].filter(h => live.has(h));
		const dims = vectorHashes.length ? this.vectors.get(vectorHashes[0])!.length : 0;
		const bytes = new Int8Array(vectorHashes.length * dims);
		vectorHashes.forEach((hash, i) => bytes.set(this.vectors.get(hash)!.subarray(0, dims), i * dims));
		const saved: SavedIndex = { version: VERSION, roots: this.options.roots, words, files, vectorModel: vectorHashes.length ? this.vectorModel : undefined, dims, vectorHashes };
		await fs.mkdir(this.options.storageDir, { recursive: true });
		// Written next to the old files first, so a crash leaves a whole index.
		const vectorsFile = path.join(this.options.storageDir, 'vectors.bin');
		await fs.writeFile(`${vectorsFile}.tmp`, bytes);
		await fs.rename(`${vectorsFile}.tmp`, vectorsFile);
		await fs.writeFile(`${this.indexPath()}.tmp`, JSON.stringify(saved));
		await fs.rename(`${this.indexPath()}.tmp`, this.indexPath());
	}

	/** Forgets everything, on disk too; the next sync starts over. */
	clear(): Promise<void> {
		this.cancel();
		return this.run(async () => {
			for (const file of [...this.files.keys()]) {
				this.removeEntry(file);
			}
			this.vectors.clear();
			this.embedError = undefined;
			await fs.rm(this.options.storageDir, { recursive: true, force: true });
			this.dirty = false;
			this.setStatus({ state: 'starting' });
		});
	}
}

interface SavedIndex {
	version: number;
	roots: string[];
	words: string[];
	/** Per file: mtime, size and chunks as [start, end, hash, chars, symbols, length, terms, counts]. */
	files: Record<string, { m: number; s: number; c: [number, number, string, number, string[], number, number[], number[]][] }>;
	vectorModel?: string;
	dims?: number;
	vectorHashes: string[];
}

/** Moves a file's term arrays into one buffer each: thousands of small arrays cost far more memory. */
function packTerms(chunks: Chunk[]): void {
	const total = chunks.reduce((sum, c) => sum + c.terms.length, 0);
	const terms = new Uint32Array(total);
	const counts = new Uint16Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		terms.set(chunk.terms, offset);
		counts.set(chunk.counts, offset);
		chunk.terms = terms.subarray(offset, offset + chunk.terms.length);
		chunk.counts = counts.subarray(offset, offset + chunk.counts.length);
		offset += chunk.terms.length;
	}
}

function sortTerms(chunk: Chunk): Chunk {
	// Term ids change when loading, so the order must be restored.
	const order = [...chunk.terms.keys()].sort((a, b) => chunk.terms[a] - chunk.terms[b]);
	return { ...chunk, terms: Uint32Array.from(order.map(i => chunk.terms[i])), counts: Uint16Array.from(order.map(i => chunk.counts[i])) };
}

function binarySearch(values: Uint32Array, target: number): number {
	let lo = 0;
	let hi = values.length - 1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		const value = values[mid];
		if (value === target) {
			return mid;
		}
		if (value < target) {
			lo = mid + 1;
		} else {
			hi = mid - 1;
		}
	}
	return -1;
}

/** Search results as the agent sees them: a location, the names declared there and the code with line numbers. */
export function formatResults(results: SearchResult[], display: (file: string) => string, maxChars = 16_000): string {
	const parts: string[] = [];
	let used = 0;
	for (const result of results) {
		const lines = result.text.split('\n');
		const shown = lines.slice(0, 60);
		const body = shown.map((line, i) => `${String(result.start + i).padStart(6)}\t${line.length > 300 ? `${line.slice(0, 300)}...` : line}`).join('\n');
		const more = lines.length > shown.length ? `\n  ... (${lines.length - shown.length} more lines)` : '';
		const part = `${display(result.file)}:${result.start}-${result.end}${result.symbols.length ? ` (${result.symbols.slice(0, 5).join(', ')})` : ''}\n${body}${more}`;
		if (used + part.length > maxChars && parts.length) {
			parts.push(`(${results.length - parts.length} more results not shown.)`);
			break;
		}
		parts.push(part);
		used += part.length;
	}
	return parts.join('\n\n');
}
