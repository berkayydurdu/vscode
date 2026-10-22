/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { after, describe, it } from 'node:test';
import { chunkPage, crawl, crawlPrefix, DocsLibrary, formatDocResults, normalizeUrl, pageLinks, pageText, type Fetcher } from '../src/core/docs.ts';
import type { Embedder } from '../src/core/indexing.ts';
import { BUILTIN_TOOLS, SessionState, type ToolContext } from '../src/core/tools.ts';
import { NodeWorkspace } from '../src/core/workspace.ts';

const dir = mkdtempSync(path.join(tmpdir(), 'nh-docs-'));
after(() => rmSync(dir, { recursive: true, force: true }));

const html = (title: string, body: string) => `<html><head><title>${title}</title></head><body><nav><a href="/docs/nav">Menu</a></nav><main>${body}</main><footer>Footer</footer></body></html>`;

const site: Record<string, string> = {
	'https://lib.dev/docs/': html('Intro', '<h1>Intro</h1><p>Start with <a href="hooks">hooks</a>, <a href="./state.html#top">state</a> and <a href="https://other.dev/x">elsewhere</a>.</p><a href="/blog/post">Blog</a><a href="logo.png">logo</a>'),
	'https://lib.dev/docs/hooks': html('Hooks', '<h1>Hooks</h1><h2>useEffect</h2><p>useEffect runs a side effect after rendering. Return a cleanup function to undo it.</p><h2>useMemo</h2><p>useMemo caches the result of a calculation between renders.</p>'),
	'https://lib.dev/docs/state.html': html('State', '<h1>State</h1><p>Components keep values between renders with useState, which returns the value and a setter.</p><p><a href="hooks">Hooks</a></p>'),
};

const fetcher: Fetcher = async url => site[url]
	? { url, status: 200, contentType: 'text/html; charset=utf-8', body: site[url] }
	: { url, status: 404, contentType: 'text/html', body: '' };

describe('docs', () => {
	it('normalizes URLs and keeps links within the docs folder', () => {
		assert.deepEqual([
			crawlPrefix('https://lib.dev/docs/intro?x=1#a'),
			normalizeUrl('state.html#top', 'https://lib.dev/docs/hooks'),
			normalizeUrl('https://lib.dev/docs/index.html'),
			normalizeUrl('javascript:alert(1)'),
			pageLinks(site['https://lib.dev/docs/'], 'https://lib.dev/docs/', 'https://lib.dev/docs/'),
		], [
			'https://lib.dev/docs/',
			'https://lib.dev/docs/state.html',
			'https://lib.dev/docs/',
			undefined,
			['https://lib.dev/docs/nav', 'https://lib.dev/docs/hooks', 'https://lib.dev/docs/state.html'],
		]);
	});

	it('reads the main content of a page and splits it at headings', () => {
		const page = { url: 'https://lib.dev/docs/hooks', ...pageText(site['https://lib.dev/docs/hooks']) };
		assert.equal(page.text.includes('Menu') || page.text.includes('Footer'), false);
		assert.deepEqual(chunkPage(page).map(c => [c.title, c.heading, c.text.slice(0, 20)]), [
			['Hooks', 'Hooks > useEffect', 'useEffect runs a sid'],
			['Hooks', 'Hooks > useMemo', 'useMemo caches the r'],
		]);
	});

	it('crawls the pages under the start page, and follows a redirect of the start page', async () => {
		const result = await crawl('https://lib.dev/docs/', fetcher, { signal: new AbortController().signal });
		assert.deepEqual([result.prefix, result.pages.map(p => p.url).sort()], ['https://lib.dev/docs/', ['https://lib.dev/docs/', 'https://lib.dev/docs/hooks', 'https://lib.dev/docs/state.html']]);
		const redirecting: Fetcher = async url => url === 'https://lib.dev/' ? { ...await fetcher('https://lib.dev/docs/', AbortSignal.timeout(1000)), url: 'https://lib.dev/docs/' } : fetcher(url, AbortSignal.timeout(1000));
		const redirected = await crawl('https://lib.dev/', redirecting, { signal: new AbortController().signal, maxPages: 3 });
		assert.deepEqual([redirected.prefix, redirected.pages.length], ['https://lib.dev/docs/', 2]);
	});

	it('saves sources and searches them by words and by meaning', async () => {
		const library = new DocsLibrary(path.join(dir, 'lib'));
		const { pages, prefix } = await crawl('https://lib.dev/docs/', fetcher, { signal: new AbortController().signal });
		// A toy embedder: "cleanup" questions point the same way as the useEffect section.
		const embedder: Embedder = { id: 'toy', embed: async texts => texts.map(t => /cleanup|undo|tear down/i.test(t) ? [1, 0] : [0, 1]) };
		const saved = await library.save({ id: 'lib', name: 'Lib Docs', url: 'https://lib.dev/docs/', prefix }, pages, embedder, new AbortController().signal);
		assert.deepEqual([saved.pages, saved.chunks, saved.embedder], [3, 4, 'toy']);

		const fresh = new DocsLibrary(library.dir);
		const signal = new AbortController().signal;
		const words = await fresh.search('useState setter', { sources: ['libdocs'], signal });
		const meaning = await fresh.search('how do I tear down a subscription', { embedder, signal, limit: 1 });
		const none = await fresh.search('useState', { sources: ['Other'], signal });
		assert.deepEqual([words[0].title, meaning.map(r => [r.heading, r.via]), none], ['State', [['Hooks > useEffect', 'meaning']], []]);
		assert.match(formatDocResults(words.slice(0, 1)), /^\[1\] Lib Docs: State > State\nhttps:\/\/lib\.dev\/docs\/state\.html\n\nComponents keep/);

		await fresh.rename('lib', 'Lib');
		await fresh.remove('missing');
		assert.deepEqual((await new DocsLibrary(library.dir).list()).map(s => s.name), ['Lib']);
		await fresh.remove('lib');
		assert.deepEqual(await new DocsLibrary(library.dir).list(), []);
	});

	it('gives the agent a DocsSearch tool', async () => {
		const tool = BUILTIN_TOOLS.find(t => t.spec.name === 'DocsSearch');
		assert.ok(tool);
		const workspace = new NodeWorkspace([dir]);
		const context: ToolContext = {
			workspace,
			state: new SessionState(),
			signal: new AbortController().signal,
			progress: () => undefined,
			searchDocs: async (query, sources) => [{ source: sources[0] ?? 'Lib', url: 'https://lib.dev/docs/hooks', title: 'Hooks', heading: 'useEffect', text: `About ${query}`, via: 'words' }],
		};
		const result = await tool.run({ query: 'effects', sources: ['Lib'] }, context);
		assert.deepEqual([result.summary, result.content], ['1 results', '[1] Lib: Hooks > useEffect\nhttps://lib.dev/docs/hooks\n\nAbout effects']);
		await assert.rejects(tool.run({ query: 'effects' }, { ...context, searchDocs: undefined }), /No documentation has been added/);
	});
});
