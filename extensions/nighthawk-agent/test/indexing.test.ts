/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { defaultEmbeddingModel, isEmbeddingModel, requestEmbeddings } from '../src/core/embeddings.ts';
import { chunkLines, CodeIndex, declaredName, fuseRankings, identifierParts, isIndexableName, looksGenerated, queryTerms, quantize, redactSecrets, stem, tokenize, type Embedder } from '../src/core/indexing.ts';
import { BUILTIN_TOOLS, READ_ONLY_TOOLS, SessionState, type ToolContext } from '../src/core/tools.ts';
import type { Endpoint } from '../src/core/types.ts';
import { NodeWorkspace } from '../src/core/workspace.ts';

async function project(files: Record<string, string>): Promise<{ root: string; storage: string; write(name: string, text: string): Promise<void> }> {
	const base = await fs.mkdtemp(path.join(os.tmpdir(), 'nh-index-'));
	const root = path.join(base, 'project');
	const write = async (name: string, text: string) => {
		const file = path.join(root, name);
		await fs.mkdir(path.dirname(file), { recursive: true });
		await fs.writeFile(file, text);
	};
	for (const [name, text] of Object.entries(files)) {
		await write(name, text);
	}
	return { root, storage: path.join(base, 'storage'), write };
}

async function listAll(root: string): Promise<string[]> {
	const out: string[] = [];
	const walk = async (dir: string) => {
		for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				await walk(full);
			} else {
				out.push(full);
			}
		}
	};
	await walk(root);
	return out;
}

function newIndex(root: string, storage: string): CodeIndex {
	return new CodeIndex({ roots: [root], storageDir: storage, listFiles: () => listAll(root) });
}

const AUTH = `import { hash } from './crypto';

export async function signIn(email: string, password: string) {
	const user = await users.find(email);
	if (!user || !await verifyPassword(user, password)) {
		throw new Error('Wrong email or password');
	}
	return createSession(user);
}

export function signOut(session: Session) {
	sessions.delete(session.id);
}
`;

const CART = `export class ShoppingCart {
	private items: Item[] = [];

	addItem(item: Item) {
		this.items.push(item);
	}

	total(): number {
		return this.items.reduce((sum, item) => sum + item.price, 0);
	}
}
`;

describe('index words', () => {
	it('splits identifiers into their parts', () => {
		assert.deepEqual(identifierParts('parseHTTPResponse_v2'), ['parse', 'http', 'response', 'v2']);
		assert.deepEqual(identifierParts('signIn'), ['sign', 'in']);
	});

	it('stems so plural and verb forms meet', () => {
		assert.equal(stem('tokens'), stem('token'));
		assert.equal(stem('entries'), stem('entry'));
		assert.equal(stem('caches'), stem('cache'));
		assert.equal(stem('handled'), stem('handle'));
	});

	it('keeps whole identifiers and their parts, without stop words', () => {
		const terms = tokenize('const userSession = getSession(the_user);');
		assert.ok(terms.includes(stem('usersession')));
		assert.ok(terms.includes(stem('session')));
		assert.ok(terms.includes(stem('user')));
		assert.ok(!terms.includes('const'));
		assert.ok(!terms.includes('the'));
	});

	it('joins neighbouring words of a question, so "sign in" finds signIn', () => {
		assert.ok(queryTerms('where do we handle sign-in?').includes(stem('signin')));
	});

	it('recognizes declarations in common languages', () => {
		assert.equal(declaredName('export async function signIn(email) {'), 'signIn');
		assert.equal(declaredName('class ShoppingCart {'), 'ShoppingCart');
		assert.equal(declaredName('def load_config(path):'), 'load_config');
		assert.equal(declaredName('pub fn parse_args() -> Args {'), 'parse_args');
		assert.equal(declaredName('func (s *Server) Start() error {'), undefined);
		assert.equal(declaredName('	total(): number {'), 'total');
		assert.equal(declaredName('	if (ready) {'), undefined);
		assert.equal(declaredName('export const DEFAULT_PORT = 80;'), 'DEFAULT_PORT');
		assert.equal(declaredName('	const user = await find();'), undefined);
	});
});

describe('index chunks', () => {
	it('covers a file in chunks of at most 80 lines that start at declarations', () => {
		const lines: string[] = [];
		for (let f = 0; f < 10; f++) {
			lines.push(`function f${f}() {`);
			for (let i = 0; i < 15; i++) {
				lines.push(`	call(${i});`);
			}
			lines.push('}', '');
		}
		const ranges = chunkLines(lines);
		assert.ok(ranges.length >= 3);
		for (const range of ranges) {
			assert.ok(range.end - range.start < 80);
			assert.match(lines[range.start - 1], /^function f\d/);
		}
		assert.equal(ranges[0].start, 1);
		assert.equal(ranges.at(-1)!.end, lines.length - 1);
	});

	it('cuts very long lines into chunks below the size limit', () => {
		const lines = new Array(30).fill('x'.repeat(1000));
		for (const range of chunkLines(lines)) {
			assert.ok(range.end - range.start + 1 <= 4);
		}
	});

	it('leaves out secrets, lock files, binaries and minified code', () => {
		assert.equal(isIndexableName('/p/.env.production'), false);
		assert.equal(isIndexableName('/p/certs/server.pem'), false);
		assert.equal(isIndexableName('/p/package-lock.json'), false);
		assert.equal(isIndexableName('/p/logo.png'), false);
		assert.equal(isIndexableName('/p/dist/app.min.js'), false);
		assert.equal(isIndexableName('/p/src/env.ts'), true);
		assert.equal(isIndexableName('/p/Makefile'), true);
		assert.equal(looksGenerated(`var a=1;${'b'.repeat(5000)}`), true);
		assert.equal(looksGenerated(AUTH), false);
	});

	it('removes keys and passwords before text is sent for embedding', () => {
		const text = redactSecrets([
			'const apiKey = "sk-proj-abcdefghijklmnopqrstuvwxyz123456";',
			'password: \'hunter2hunter2\'',
			'aws = AKIAABCDEFGHIJKLMNOP',
			'-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----',
			'const tokenCount = 3;',
		].join('\n'));
		assert.doesNotMatch(text, /abcdefghijklmnop|hunter2|AKIAABCD|MIIE/);
		assert.match(text, /tokenCount = 3/);
	});
});

describe('index search', () => {
	it('finds code by its words and names, and follows changes', async () => {
		const p = await project({ 'src/auth.ts': AUTH, 'src/cart.ts': CART, 'README.md': '# Shop\n\nA small shop.\n' });
		const index = newIndex(p.root, p.storage);
		await index.sync();
		assert.equal(index.getStatus().state, 'ready');
		assert.equal(index.getStatus().files, 3);

		let { results, byMeaning } = await index.search('where do we handle sign-in?');
		assert.equal(byMeaning, false);
		assert.equal(results[0].file, path.join(p.root, 'src/auth.ts'));
		assert.ok(results[0].symbols.includes('signIn'));
		assert.match(results[0].text, /verifyPassword/);

		({ results } = await index.search('total price of the cart'));
		assert.equal(results[0].file, path.join(p.root, 'src/cart.ts'));

		await p.write('src/payments.ts', 'export function chargeCard(card: Card, amount: number) {\n\treturn stripe.charge(card, amount);\n}\n');
		await index.sync();
		({ results } = await index.search('charge a credit card'));
		assert.equal(results[0].file, path.join(p.root, 'src/payments.ts'));

		await fs.writeFile(path.join(p.root, 'src/payments.ts'), 'export function refund(order: Order) {\n\treturn stripe.refund(order.charge);\n}\n');
		await index.update([path.join(p.root, 'src/payments.ts')]);
		({ results } = await index.search('refund an order'));
		assert.equal(results[0].file, path.join(p.root, 'src/payments.ts'));

		await fs.rm(path.join(p.root, 'src/payments.ts'));
		await index.update([path.join(p.root, 'src/payments.ts')]);
		({ results } = await index.search('refund an order'));
		assert.ok(results.every(r => !r.file.endsWith('payments.ts')));
	});

	it('uses keywords the agent adds and limits results to a folder', async () => {
		const p = await project({ 'server/login.ts': 'export function authenticate(user: string) {\n\treturn tokens.issue(user);\n}\n', 'client/cart.ts': CART });
		const index = newIndex(p.root, p.storage);
		await index.sync();
		const { results } = await index.search('where do users sign in?', { keywords: ['login', 'authenticate'] });
		assert.equal(results[0].file, path.join(p.root, 'server/login.ts'));
		const scoped = await index.search('items', { under: path.join(p.root, 'server') });
		assert.ok(scoped.results.every(r => r.file.startsWith(path.join(p.root, 'server'))));
	});

	it('saves the index and loads it without reading files again', async () => {
		const p = await project({ 'src/auth.ts': AUTH, 'src/cart.ts': CART });
		const first = newIndex(p.root, p.storage);
		await first.sync();
		const second = new CodeIndex({ roots: [p.root], storageDir: p.storage, listFiles: async () => { throw new Error('not needed'); } });
		await second.load();
		assert.equal(second.getStatus().files, 2);
		const { results } = await second.search('sign in');
		assert.equal(results[0].file, path.join(p.root, 'src/auth.ts'));
	});

	it('finds code by meaning with embeddings, and falls back to words when they fail', async () => {
		// A toy embedding: one dimension per topic, so "log in" and signIn meet without sharing words.
		const topics = [/sign|log ?in|password|auth|session|credential/i, /cart|item|price|total/i, /shop|readme/i];
		let requests = 0;
		let fail = false;
		const embedder: Embedder = {
			id: 'toy',
			async embed(texts) {
				requests++;
				if (fail) {
					throw new Error('401: invalid API key');
				}
				return texts.map(text => topics.map(t => (text.match(new RegExp(t.source, 'gi')) ?? []).length + 0.01));
			},
		};
		const p = await project({ 'src/auth.ts': AUTH, 'src/cart.ts': CART });
		const index = newIndex(p.root, p.storage);
		index.setEmbedder(embedder);
		await index.sync();
		const status = index.getStatus();
		assert.equal(status.embedded, status.chunks);
		const before = requests;
		const { results, byMeaning } = await index.search('how do people log in');
		assert.equal(byMeaning, true);
		assert.equal(requests, before + 1);
		assert.equal(results[0].file, path.join(p.root, 'src/auth.ts'));
		assert.notEqual(results[0].via, 'words');

		// Unchanged chunks keep their vectors after a reload.
		const reloaded = newIndex(p.root, p.storage);
		await reloaded.load();
		reloaded.setEmbedder(embedder);
		assert.equal(reloaded.getStatus().embedded, status.chunks);

		// A failing model leaves search by words working.
		fail = true;
		await p.write('src/orders.ts', 'export function placeOrder(cart: ShoppingCart) {\n\treturn orders.create(cart.total());\n}\n');
		await reloaded.sync();
		assert.match(reloaded.getStatus().embedError ?? '', /401/);
		const fallback = await reloaded.search('place an order');
		assert.equal(fallback.byMeaning, false);
		assert.equal(fallback.results[0].file, path.join(p.root, 'src/orders.ts'));
	});

	it('drops vectors from another model', async () => {
		const p = await project({ 'src/cart.ts': CART });
		const index = newIndex(p.root, p.storage);
		index.setEmbedder({ id: 'a', embed: async texts => texts.map(() => [1, 0]) });
		await index.sync();
		assert.ok(index.getStatus().embedded > 0);
		index.setEmbedder({ id: 'b', embed: async texts => texts.map(() => [0, 1]) });
		assert.equal(index.getStatus().embedded, 0);
		assert.ok(index.pendingEmbeddingChars() > 0);
	});

	it('merges rankings by rank', () => {
		const fused = fuseRankings([['a', 'b', 'c'], ['c', 'a']], x => x);
		assert.deepEqual(fused.map(f => f.item), ['a', 'c', 'b']);
		assert.equal(fused[0].lists, 2);
	});

	it('stores vectors in a byte per dimension', () => {
		const v = quantize([3, 4]);
		assert.deepEqual([...v], [76, 102]);
	});
});

describe('embeddings', () => {
	const endpoint = (baseUrl: string, models: string[] = [], provider: 'openai' | 'anthropic' = 'openai'): Endpoint => ({ name: 'E', provider, baseUrl, models });

	it('knows which endpoints offer embedding models', () => {
		assert.equal(defaultEmbeddingModel(endpoint('https://api.openai.com/v1')), 'text-embedding-3-small');
		assert.equal(defaultEmbeddingModel(endpoint('http://localhost:11434/v1', ['llama3.2']), ['llama3.2', 'nomic-embed-text:latest']), 'nomic-embed-text:latest');
		assert.equal(defaultEmbeddingModel(endpoint('https://api.anthropic.com', ['claude-opus-5-5'], 'anthropic')), undefined);
		assert.equal(defaultEmbeddingModel(endpoint('https://openrouter.ai/api/v1', ['anthropic/claude-sonnet-5-5'])), undefined);
		assert.equal(isEmbeddingModel('text-embedding-3-large'), true);
		assert.equal(isEmbeddingModel('gpt-5'), false);
	});

	it('requests embeddings and puts them back in order', async () => {
		let body: Record<string, unknown> = {};
		let auth = '';
		const server = createServer((req, res) => {
			let data = '';
			req.on('data', chunk => data += chunk);
			req.on('end', () => {
				body = JSON.parse(data);
				auth = req.headers.authorization ?? '';
				if (req.url !== '/v1/embeddings') {
					res.writeHead(404).end('{"error":{"message":"not found"}}');
					return;
				}
				res.writeHead(200, { 'content-type': 'application/json' });
				res.end(JSON.stringify({ data: [{ index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] }], usage: { prompt_tokens: 7 } }));
			});
		});
		await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
		const port = (server.address() as AddressInfo).port;
		try {
			const result = await requestEmbeddings(endpoint(`http://127.0.0.1:${port}/v1`), 'text-embedding-3-small', 'key', ['a', 'b'], new AbortController().signal);
			assert.deepEqual(result.vectors, [[1, 0], [0, 1]]);
			assert.equal(result.tokens, 7);
			assert.equal(body.dimensions, 512);
			assert.deepEqual(body.input, ['a', 'b']);
			assert.equal(auth, 'Bearer key');
			await assert.rejects(requestEmbeddings(endpoint(`http://127.0.0.1:${port}/other`), 'm', undefined, ['a'], new AbortController().signal), /404: not found/);
		} finally {
			server.close();
		}
	});
});

describe('CodebaseSearch tool', () => {
	const tool = BUILTIN_TOOLS.find(t => t.spec.name === 'CodebaseSearch')!;

	function context(root: string, search?: ToolContext['searchCodebase']): ToolContext {
		return {
			workspace: new NodeWorkspace([root]), state: new SessionState(), signal: new AbortController().signal,
			shell: { name: 'bash', path: '/bin/bash', args: ['-c'] }, progress: () => { }, beforeEdit: () => { }, onTodos: () => { },
			searchCodebase: search,
		};
	}

	it('is a read-only tool sub-agents may use', () => {
		assert.equal(tool.kind, 'read');
		assert.ok(READ_ONLY_TOOLS.has('CodebaseSearch'));
	});

	it('returns ranked code with paths and line numbers', async () => {
		const p = await project({ 'src/auth.ts': AUTH, 'src/cart.ts': CART });
		const index = newIndex(p.root, p.storage);
		await index.sync();
		let asked: { query: string; keywords?: string[] } | undefined;
		const ctx = context(p.root, async (query, options) => {
			asked = { query, keywords: options.keywords };
			return { ...await index.search(query, options), note: 'The index is still being built.' };
		});
		const result = await tool.run({ query: 'where do we handle sign-in', keywords: ['login', 'signIn'] }, ctx);
		assert.deepEqual(asked, { query: 'where do we handle sign-in', keywords: ['login', 'signIn'] });
		assert.match(result.content, /^The index is still being built\./);
		assert.match(result.content, /ranked by words/);
		assert.match(result.content, /src\/auth\.ts:1-13 \(signIn, signOut\)/);
		assert.match(result.content, / {5}4\t\tconst user = await users\.find\(email\);/);
		assert.deepEqual(result.display?.kind, 'files');
	});

	it('says to use Grep when the index is off', async () => {
		await assert.rejects(tool.run({ query: 'x' }, context(os.tmpdir())), /turned off/);
	});
});
