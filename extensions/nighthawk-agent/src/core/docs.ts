/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Documentation indexing: the user adds a library's docs by URL, Nighthawk
// reads the pages under it, splits them into sections and keeps a search
// index on this computer, so the agent can look things up with DocsSearch
// or `@docs:Name` instead of guessing from what the model remembers.

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { fuseRankings, quantize, queryTerms, tokenize, type Embedder } from './indexing';
import { htmlToText } from './tools';

/** Pages read from one site, at most. */
export const MAX_PAGES = 300;
/** Characters a section may have before it is split. */
const CHUNK_CHARS = 1_600;
const PAGE_CHARS = 400_000;
const FETCH_CONCURRENCY = 4;

export interface DocSource {
	id: string;
	name: string;
	/** The page the crawl started from. */
	url: string;
	/** Only pages whose URL starts with this are read. */
	prefix: string;
	pages: number;
	chunks: number;
	indexed: number;
	/** The embedding model the vectors came from, if any. */
	embedder?: string;
}

export interface DocChunk {
	url: string;
	title: string;
	/** The headings above the section, joined with " > ". */
	heading: string;
	text: string;
	/** Base64 of the int8 vector, when embedded. */
	vector?: string;
}

export interface DocResult {
	source: string;
	url: string;
	title: string;
	heading: string;
	text: string;
	via: 'meaning' | 'words' | 'both';
}

export interface Page {
	url: string;
	title: string;
	text: string;
}

/** Reads one URL; the host decides how (and adds its user agent and timeout). */
export type Fetcher = (url: string, signal: AbortSignal) => Promise<{ url: string; status: number; contentType: string; body: string }>;

const SKIPPED_EXTENSIONS = /\.(png|jpe?g|gif|svg|webp|ico|css|js|mjs|json|xml|zip|gz|tgz|pdf|mp4|webm|mp3|woff2?|ttf|eot|wasm|txt)$/i;

/** The folder of a URL, which limits a crawl to the docs it started in: /docs/intro reads /docs/... */
export function crawlPrefix(start: string): string {
	const url = new URL(start);
	url.hash = '';
	url.search = '';
	const dir = url.pathname.endsWith('/') ? url.pathname : url.pathname.slice(0, url.pathname.lastIndexOf('/') + 1);
	return `${url.origin}${dir}`;
}

/** A URL without its fragment, query or trailing index.html, to visit each page once. */
export function normalizeUrl(raw: string, base?: string): string | undefined {
	try {
		const url = new URL(raw, base);
		if (url.protocol !== 'http:' && url.protocol !== 'https:') {
			return undefined;
		}
		url.hash = '';
		url.search = '';
		url.pathname = url.pathname.replace(/\/index\.html?$/i, '/');
		return url.toString();
	} catch {
		return undefined;
	}
}

/** The links of a page that stay within the prefix. */
export function pageLinks(html: string, pageUrl: string, prefix: string): string[] {
	const links = new Set<string>();
	for (const match of html.matchAll(/<a\s[^>]*?href\s*=\s*["']([^"']+)["']/gi)) {
		const url = normalizeUrl(match[1], pageUrl);
		if (url && url.startsWith(prefix) && !SKIPPED_EXTENSIONS.test(new URL(url).pathname)) {
			links.add(url);
		}
	}
	return [...links];
}

function between(html: string, tag: string): string | undefined {
	const open = new RegExp(`<${tag}(\\s[^>]*)?>`, 'i').exec(html);
	if (!open) {
		return undefined;
	}
	const close = html.toLowerCase().lastIndexOf(`</${tag}>`);
	return close > open.index ? html.slice(open.index + open[0].length, close) : undefined;
}

/** A page's readable text: its main content when it marks one, without menus and footers. */
export function pageText(html: string): { title: string; text: string } {
	const title = htmlToText(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '').replace(/\s+/g, ' ').trim();
	const main = between(html, 'main') ?? between(html, 'article') ?? between(html, 'body') ?? html;
	// Without hrefs the text has no link targets in parentheses, which help a reader, not a search.
	const withoutLinks = main.slice(0, PAGE_CHARS).replace(/<a\s[^>]*>/gi, '<a>');
	// Nor the anchor marks many sites put after headings.
	const text = htmlToText(withoutLinks).replace(/[ \t]*[¶§][ \t]*$/gm, '').replace(/^(#{1,6} .*?)[ \t]+#$/gm, '$1');
	return { title, text };
}

/** Splits a page into sections at its headings, and long sections into pieces of a few paragraphs. */
export function chunkPage(page: Page): DocChunk[] {
	const chunks: DocChunk[] = [];
	const headings: string[] = [];
	let heading = '';
	let buffer: string[] = [];
	const flush = () => {
		const text = buffer.join('\n\n').trim();
		if (text.length >= 40) {
			chunks.push({ url: page.url, title: page.title, heading, text });
		}
		buffer = [];
	};
	// Headings get blocks of their own, as the page text puts paragraphs right under them.
	for (const block of page.text.replace(/^(#{1,6} .+)$/gm, '\n$1\n').split(/\n{2,}/)) {
		const match = /^(#{1,6}) (.+)$/.exec(block.trim());
		if (match) {
			flush();
			headings.length = match[1].length - 1;
			headings[match[1].length - 1] = match[2].trim();
			heading = headings.filter(Boolean).join(' > ');
			continue;
		}
		if (buffer.join('\n\n').length + block.length > CHUNK_CHARS && buffer.length) {
			flush();
		}
		buffer.push(block.length > CHUNK_CHARS * 2 ? block.slice(0, CHUNK_CHARS * 2) : block);
	}
	flush();
	return chunks;
}

/**
 * Reads the pages under `start`, breadth first, a few at a time, up to
 * `maxPages`: only pages on the same site under the start page's folder
 * (or under the folder it redirects to, when no prefix is given).
 */
export async function crawl(start: string, fetcher: Fetcher, options: { maxPages?: number; prefix?: string; signal: AbortSignal; onPage?(done: number, url: string): void }): Promise<{ pages: Page[]; prefix: string }> {
	const first = normalizeUrl(start);
	if (!first) {
		throw new Error(`Not a web address: ${start}`);
	}
	let prefix = options.prefix ?? crawlPrefix(first);
	const max = options.maxPages ?? MAX_PAGES;
	const queue = [first];
	const seen = new Set(queue);
	const pages: Page[] = [];
	let started = 0;
	let active = 0;
	await new Promise<void>(resolve => {
		const next = () => {
			if (options.signal.aborted || ((!queue.length || started >= max) && !active)) {
				if (!active) {
					resolve();
				}
				return;
			}
			while (active < FETCH_CONCURRENCY && queue.length && started < max && !options.signal.aborted) {
				const url = queue.shift() ?? '';
				started++;
				active++;
				fetcher(url, options.signal).then(response => {
					if (response.status >= 400 || !/html|text\/plain|markdown/.test(response.contentType)) {
						return;
					}
					const final = normalizeUrl(response.url) ?? url;
					if (url === first && final !== first && !options.prefix) {
						prefix = crawlPrefix(final);
					}
					if (!final.startsWith(prefix)) {
						return;
					}
					const html = /html/.test(response.contentType);
					const { title, text } = html ? pageText(response.body) : { title: final, text: response.body.slice(0, PAGE_CHARS) };
					if (text.trim() && !pages.some(p => p.url === final)) {
						pages.push({ url: final, title: title || final, text });
					}
					if (html) {
						for (const link of pageLinks(response.body, final, prefix)) {
							if (!seen.has(link)) {
								seen.add(link);
								queue.push(link);
							}
						}
					}
				}, () => undefined).finally(() => {
					active--;
					options.onPage?.(pages.length, url);
					next();
				});
			}
			if (!active) {
				resolve();
			}
		};
		next();
	});
	return { pages, prefix };
}

// --- Search

const K1 = 1.2;
const B = 0.75;

interface Loaded {
	source: DocSource;
	chunks: DocChunk[];
	terms: Map<string, number>[];
	lengths: number[];
	documentFrequency: Map<string, number>;
	vectors: (Int8Array | undefined)[];
}

function termCounts(chunk: DocChunk): Map<string, number> {
	const counts = new Map<string, number>();
	// Headings and titles count double: they say what the section is about.
	for (const term of [...tokenize(`${chunk.title} ${chunk.heading}`), ...tokenize(`${chunk.title} ${chunk.heading}`), ...tokenize(chunk.text)]) {
		counts.set(term, (counts.get(term) ?? 0) + 1);
	}
	return counts;
}

function dot(a: Int8Array, b: Int8Array): number {
	let sum = 0;
	for (let i = 0; i < Math.min(a.length, b.length); i++) {
		sum += a[i] * b[i];
	}
	return sum / (127 * 127);
}

export function embeddingInput(chunk: DocChunk): string {
	return `${chunk.title}${chunk.heading ? ` > ${chunk.heading}` : ''}\n${chunk.text}`.slice(0, 6000);
}

export function sourceId(url: string): string {
	return createHash('sha256').update(url).digest('hex').slice(0, 12);
}

/**
 * The documentation sources on this computer: a list in docs.json and one
 * file of sections per source. Searches load a source's file once.
 */
export class DocsLibrary {
	readonly dir: string;
	private sources: DocSource[] | undefined;
	private readonly loaded = new Map<string, Loaded>();

	constructor(dir: string) {
		this.dir = dir;
	}

	private async writeJson(file: string, value: unknown): Promise<void> {
		await mkdir(this.dir, { recursive: true });
		const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
		await writeFile(temp, JSON.stringify(value));
		await rename(temp, file);
	}

	async list(): Promise<DocSource[]> {
		if (!this.sources) {
			try {
				const value: unknown = JSON.parse(await readFile(path.join(this.dir, 'docs.json'), 'utf8'));
				this.sources = Array.isArray(value) ? value.filter((s: Partial<DocSource>) => typeof s?.id === 'string' && typeof s.name === 'string') : [];
			} catch {
				this.sources = [];
			}
		}
		return [...this.sources];
	}

	/** Forgets what was read, for when another window changed the library. */
	reload(): void {
		this.sources = undefined;
		this.loaded.clear();
	}

	find(sources: DocSource[], name: string): DocSource | undefined {
		const wanted = name.toLowerCase().replace(/[\s_-]+/g, '');
		return sources.find(s => s.name.toLowerCase().replace(/[\s_-]+/g, '') === wanted || s.id === name);
	}

	/** Saves a crawled source, embedding its sections when an embedder is given. Replaces one with the same id. */
	async save(source: Omit<DocSource, 'pages' | 'chunks' | 'indexed' | 'embedder'>, pages: Page[], embedder: Embedder | undefined, signal: AbortSignal, onEmbedded?: (done: number, total: number) => void): Promise<DocSource> {
		const chunks = pages.flatMap(chunkPage);
		let embedded: string | undefined;
		if (embedder) {
			try {
				for (let i = 0; i < chunks.length; i += 64) {
					const batch = chunks.slice(i, i + 64);
					const vectors = await embedder.embed(batch.map(embeddingInput), signal);
					batch.forEach((chunk, j) => {
						if (vectors[j]) {
							chunk.vector = Buffer.from(quantize(vectors[j]).buffer).toString('base64');
						}
					});
					onEmbedded?.(Math.min(i + 64, chunks.length), chunks.length);
				}
				embedded = embedder.id;
			} catch (err) {
				if (signal.aborted) {
					throw err;
				}
				// Without vectors the source is still searched by words.
				chunks.forEach(c => delete c.vector);
			}
		}
		const full: DocSource = { ...source, pages: pages.length, chunks: chunks.length, indexed: Date.now(), embedder: embedded };
		await this.writeJson(path.join(this.dir, `${full.id}.json`), chunks);
		const sources = (await this.list()).filter(s => s.id !== full.id);
		sources.push(full);
		await this.writeJson(path.join(this.dir, 'docs.json'), sources);
		this.sources = sources;
		this.loaded.delete(full.id);
		return full;
	}

	async remove(id: string): Promise<void> {
		const sources = (await this.list()).filter(s => s.id !== id);
		await this.writeJson(path.join(this.dir, 'docs.json'), sources);
		this.sources = sources;
		this.loaded.delete(id);
		await rm(path.join(this.dir, `${id}.json`), { force: true });
	}

	async rename(id: string, name: string): Promise<void> {
		const sources = await this.list();
		const source = sources.find(s => s.id === id);
		if (source) {
			source.name = name;
			await this.writeJson(path.join(this.dir, 'docs.json'), sources);
			this.sources = sources;
		}
	}

	private async load(source: DocSource): Promise<Loaded> {
		const cached = this.loaded.get(source.id);
		if (cached && cached.source.indexed === source.indexed) {
			return cached;
		}
		let chunks: DocChunk[] = [];
		try {
			chunks = JSON.parse(await readFile(path.join(this.dir, `${source.id}.json`), 'utf8'));
		} catch {
			chunks = [];
		}
		const terms = chunks.map(termCounts);
		const documentFrequency = new Map<string, number>();
		for (const counts of terms) {
			for (const term of counts.keys()) {
				documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
			}
		}
		const loaded: Loaded = {
			source,
			chunks,
			terms,
			lengths: terms.map(counts => [...counts.values()].reduce((a, b) => a + b, 0)),
			documentFrequency,
			vectors: chunks.map(c => c.vector ? new Int8Array(Buffer.from(c.vector, 'base64')) : undefined),
		};
		this.loaded.set(source.id, loaded);
		return loaded;
	}

	/**
	 * The sections that best answer the query, from the named sources or all
	 * of them: by words always, and by meaning when the source has vectors
	 * from the same embedding model as `embedder`.
	 */
	async search(query: string, options: { sources?: string[]; limit?: number; embedder?: Embedder; signal: AbortSignal }): Promise<DocResult[]> {
		const all = await this.list();
		const names = options.sources ?? [];
		const chosen = names.length ? all.filter(s => names.some(name => this.find([s], name))) : all;
		const limit = options.limit ?? 6;
		type Hit = { source: Loaded; index: number; score: number };
		const byWords: Hit[] = [];
		const byMeaning: Hit[] = [];
		const terms = [...new Set(queryTerms(query))];
		let queryVector: Int8Array | undefined;
		for (const source of chosen) {
			const loaded = await this.load(source);
			const n = loaded.chunks.length;
			if (!n) {
				continue;
			}
			const average = loaded.lengths.reduce((a, b) => a + b, 0) / n;
			const scored: { index: number; score: number }[] = [];
			loaded.terms.forEach((counts, index) => {
				let score = 0;
				for (const term of terms) {
					const tf = counts.get(term);
					if (tf) {
						const df = loaded.documentFrequency.get(term) ?? 0;
						const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
						score += idf * tf * (K1 + 1) / (tf + K1 * (1 - B + B * loaded.lengths[index] / average));
					}
				}
				if (score > 0) {
					scored.push({ index, score });
				}
			});
			byWords.push(...scored.sort((a, b) => b.score - a.score).slice(0, limit * 3).map(s => ({ source: loaded, index: s.index, score: s.score })));
			if (options.embedder && source.embedder === options.embedder.id && loaded.vectors.some(Boolean)) {
				queryVector ??= quantize((await options.embedder.embed([query], options.signal))[0]);
				const vector = queryVector;
				const similar = loaded.vectors.flatMap((v, index) => v ? [{ index, score: dot(v, vector) }] : []);
				byMeaning.push(...similar.sort((a, b) => b.score - a.score).slice(0, limit * 3).map(s => ({ source: loaded, index: s.index, score: s.score })));
			}
		}
		byWords.sort((a, b) => b.score - a.score);
		byMeaning.sort((a, b) => b.score - a.score);
		const key = (hit: Hit) => `${hit.source.source.id}:${hit.index}`;
		const words = new Set(byWords.map(key));
		const meaning = new Set(byMeaning.map(key));
		return fuseRankings([byWords, byMeaning], key).slice(0, limit).map(({ item }) => {
			const chunk = item.source.chunks[item.index];
			const id = key(item);
			return {
				source: item.source.source.name,
				url: chunk.url,
				title: chunk.title,
				heading: chunk.heading,
				text: chunk.text,
				via: words.has(id) && meaning.has(id) ? 'both' : meaning.has(id) ? 'meaning' : 'words',
			};
		});
	}
}

/** Search results as text for the model, each with where it came from. */
export function formatDocResults(results: DocResult[]): string {
	return results.map((r, i) => `[${i + 1}] ${r.source}: ${r.title}${r.heading ? ` > ${r.heading}` : ''}\n${r.url}\n\n${r.text}`).join('\n\n---\n\n');
}
