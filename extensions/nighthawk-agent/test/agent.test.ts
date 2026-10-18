/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { after, describe, it } from 'node:test';
import { Agent, type AgentEvent } from '../src/core/agent.ts';
import { diffLines } from '../src/core/diff.ts';
import { globToRegExp } from '../src/core/glob.ts';
import { Hooks } from '../src/core/hooks.ts';
import { decide, isSafeCommand, parseRule, suggestRule } from '../src/core/permissions.ts';
import { findShell } from '../src/core/shell.ts';
import { BUILTIN_TOOLS, htmlToText, SessionState, type Tool, type ToolContext } from '../src/core/tools.ts';
import type { ChatRequest, Message, Part, StreamEvent } from '../src/core/types.ts';
import { NodeWorkspace } from '../src/core/workspace.ts';

const dir = mkdtempSync(path.join(tmpdir(), 'nh-agent-'));
after(() => rmSync(dir, { recursive: true, force: true }));

const workspace = new NodeWorkspace([dir]);
const shell = await findShell(undefined);
const tool = (name: string) => BUILTIN_TOOLS.find(t => t.spec.name === name)!;

function context(state = new SessionState()): ToolContext & { edits: string[] } {
	const edits: string[] = [];
	return {
		workspace, state, shell, edits,
		signal: new AbortController().signal,
		progress: () => { },
		beforeEdit: file => edits.push(file),
		onTodos: () => { },
	};
}

describe('tools', () => {
	it('reads with line numbers and requires a read before editing', async () => {
		writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\nthree\n');
		const ctx = context();
		await assert.rejects(tool('Edit').run({ file_path: 'a.txt', old_string: 'two', new_string: '2' }, ctx), /Read .* before/);
		const read = await tool('Read').run({ file_path: 'a.txt', offset: 2, limit: 1 }, ctx);
		assert.match(read.content, /^\s+2\ttwo/);
		const edit = await tool('Edit').run({ file_path: 'a.txt', old_string: 'two', new_string: '2' }, ctx);
		assert.equal(readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'one\n2\nthree\n');
		assert.equal(edit.summary, '+1 -1');
		assert.deepEqual(ctx.edits, [path.join(dir, 'a.txt')]);
	});

	it('rejects ambiguous edits and stale files', async () => {
		writeFileSync(path.join(dir, 'b.txt'), 'x\nx\n');
		const ctx = context();
		await tool('Read').run({ file_path: 'b.txt' }, ctx);
		await assert.rejects(tool('Edit').run({ file_path: 'b.txt', old_string: 'x', new_string: 'y' }, ctx), /appears 2 times/);
		await tool('Edit').run({ file_path: 'b.txt', old_string: 'x', new_string: 'y', replace_all: true }, ctx);
		assert.equal(readFileSync(path.join(dir, 'b.txt'), 'utf8'), 'y\ny\n');
		writeFileSync(path.join(dir, 'b.txt'), 'changed by user\n');
		await assert.rejects(tool('Edit').run({ file_path: 'b.txt', old_string: 'changed', new_string: 'z' }, ctx), /changed since/);
	});

	it('keeps CRLF line endings', async () => {
		writeFileSync(path.join(dir, 'crlf.txt'), 'a\r\nb\r\nc\r\n');
		const ctx = context();
		await tool('Read').run({ file_path: 'crlf.txt' }, ctx);
		await tool('Edit').run({ file_path: 'crlf.txt', old_string: 'a\nb', new_string: 'A\nB' }, ctx);
		assert.equal(readFileSync(path.join(dir, 'crlf.txt'), 'utf8'), 'A\r\nB\r\nc\r\n');
	});

	it('writes new files and finds them with Glob and Grep', async () => {
		const ctx = context();
		await tool('Write').run({ file_path: 'src/deep/new.ts', content: 'export const answer = 42;\n' }, ctx);
		const glob = await tool('Glob').run({ pattern: '**/*.ts' }, ctx);
		assert.match(glob.content, /new\.ts/);
		const grep = await tool('Grep').run({ pattern: 'answer\\s=', output_mode: 'content' }, ctx);
		assert.match(grep.content, /new\.ts:1:export const answer/);
		const none = await tool('Grep').run({ pattern: 'nothing-here-at-all' }, ctx);
		assert.equal(none.content, 'No matches found.');
	});

	it('runs commands and reports the exit code', async () => {
		const ok = await tool('Bash').run({ command: 'echo hello' }, context());
		assert.match(ok.content, /hello[\s\S]*Exit code: 0/);
		const bad = await tool('Bash').run({ command: 'exit 3' }, context());
		assert.equal(bad.isError, true);
		assert.match(bad.content, /Exit code: 3/);
	});

	it('runs commands in the background', async () => {
		const ctx = context();
		const started = await tool('Bash').run({ command: 'echo bg-out', run_in_background: true }, ctx);
		const id = /shell_\d+/.exec(started.content)![0];
		const shellEntry = ctx.state.shells.get(id)!;
		await shellEntry.running.done;
		await new Promise(r => setTimeout(r, 20));
		const out = await tool('BashOutput').run({ bash_id: id }, ctx);
		assert.match(out.content, /bg-out[\s\S]*finished with exit code 0/);
	});

	it('converts HTML to text', () => {
		assert.equal(htmlToText('<html><head><title>x</title></head><body><h1>Title</h1><p>A &amp; <a href="https://x.dev">link</a></p><script>bad()</script></body></html>'), '# Title\nA & link (https://x.dev)');
	});
});

describe('glob and diff', () => {
	it('matches globs', () => {
		assert.ok(globToRegExp('**/*.ts').test('a/b/c.ts'));
		assert.ok(globToRegExp('**/*.ts').test('c.ts'));
		assert.ok(globToRegExp('src/**/*.{ts,tsx}').test('src/x/y.tsx'));
		assert.ok(!globToRegExp('*.ts').test('a/c.ts'));
	});

	it('diffs lines into hunks', () => {
		const before = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n');
		const after = before.replace('line 3', 'LINE 3').replace('line 18', 'LINE 18');
		const diff = diffLines(before, after);
		assert.equal(diff.added, 2);
		assert.equal(diff.removed, 2);
		assert.equal(diff.hunks.length, 2);
		assert.deepEqual(diff.hunks[0].lines.map(l => l.kind + l.text).slice(0, 4), [' line 1', ' line 2', '-line 3', '+LINE 3']);
		assert.equal(diff.hunks[1].oldStart, 15);
	});
});

describe('permissions', () => {
	const base = { allow: [], deny: [], workspace };
	it('lets reads run and asks for edits and commands', () => {
		assert.equal(decide({ ...base, tool: tool('Read'), input: { file_path: 'a.txt' }, mode: 'default' }).behavior, 'allow');
		assert.equal(decide({ ...base, tool: tool('Read'), input: { file_path: '/etc/passwd' }, mode: 'default' }).behavior, 'ask');
		assert.equal(decide({ ...base, tool: tool('Edit'), input: { file_path: 'a.txt' }, mode: 'default' }).behavior, 'ask');
		assert.equal(decide({ ...base, tool: tool('Edit'), input: { file_path: 'a.txt' }, mode: 'acceptEdits' }).behavior, 'allow');
		assert.equal(decide({ ...base, tool: tool('Edit'), input: { file_path: '/tmp/x' }, mode: 'acceptEdits' }).behavior, 'ask');
		assert.equal(decide({ ...base, tool: tool('Bash'), input: { command: 'git status' }, mode: 'default' }).behavior, 'allow');
		assert.equal(decide({ ...base, tool: tool('Bash'), input: { command: 'rm -rf build' }, mode: 'default' }).behavior, 'ask');
		assert.equal(decide({ ...base, tool: tool('Edit'), input: { file_path: 'a.txt' }, mode: 'plan' }).behavior, 'deny');
		assert.equal(decide({ ...base, tool: tool('Bash'), input: { command: 'rm -rf /' }, mode: 'bypassPermissions' }).behavior, 'allow');
	});

	it('applies allow and deny rules', () => {
		const allow = [parseRule('Bash(npm test:*)')!, parseRule('Edit(src/**)')!];
		const deny = [parseRule('Bash(git push:*)')!];
		const check = (t: Tool, input: Record<string, unknown>) => decide({ tool: t, input, mode: 'bypassPermissions', allow: [], deny, workspace }).behavior;
		assert.equal(check(tool('Bash'), { command: 'git push origin main' }), 'deny');
		const allowed = (t: Tool, input: Record<string, unknown>) => decide({ tool: t, input, mode: 'default', allow, deny, workspace }).behavior;
		assert.equal(allowed(tool('Bash'), { command: 'npm test -- --grep x' }), 'allow');
		assert.equal(allowed(tool('Bash'), { command: 'npm test && rm -rf /' }), 'ask');
		assert.equal(allowed(tool('Write'), { file_path: 'src/a/b.ts' }), 'allow');
		assert.equal(allowed(tool('Write'), { file_path: 'other/b.ts' }), 'ask');
	});

	it('suggests rules and spots safe commands', () => {
		assert.deepEqual(suggestRule(tool('Bash'), { command: 'npm run build --watch' }), { rule: 'Bash(npm run:*)', label: 'npm run commands' });
		assert.equal(isSafeCommand('git diff HEAD~1'), true);
		assert.equal(isSafeCommand('cat a > b'), false);
		assert.equal(isSafeCommand('find . -delete'), false);
		assert.equal(isSafeCommand('ls -la src && git status --short'), true);
		assert.equal(isSafeCommand('git log | head -5'), true);
		assert.equal(isSafeCommand('ls && rm -rf build'), false);
		assert.equal(isSafeCommand('cat a | tee b'), false);
		assert.equal(isSafeCommand('echo $(rm x)'), false);
	});
});

/** A scripted model: each call returns the next response. */
function scripted(responses: Part[][], seen: ChatRequest[] = []) {
	let index = 0;
	return async function* (request: ChatRequest): AsyncGenerator<StreamEvent> {
		seen.push(structuredClone(request));
		const content = responses[index++] ?? [{ type: 'text', text: 'done' }];
		for (const part of content) {
			if (part.type === 'text') {
				yield { type: 'text', text: part.text };
			}
		}
		const hasTools = content.some(p => p.type === 'tool_use');
		yield { type: 'done', message: { role: 'assistant', content }, stopReason: hasTools ? 'tool_use' : 'end_turn', usage: { inputTokens: 1000, outputTokens: 10 } };
	};
}

describe('Agent', () => {
	const makeAgent = (model: ReturnType<typeof scripted>, events: AgentEvent[], permission: Agent['run'] extends never ? never : (t: Tool) => Promise<{ allow: true } | { allow: false; reason: string; stop?: boolean }> = async () => ({ allow: true }), extra: Partial<ConstructorParameters<typeof Agent>[0]> = {}) => new Agent({
		model,
		tools: BUILTIN_TOOLS,
		system: 'sys',
		contextWindow: 100_000,
		compactAt: 0,
		maxSteps: 20,
		permission: tool => permission(tool),
		context: { workspace, state: new SessionState(), shell, beforeEdit: () => { }, onTodos: () => { } },
		onEvent: e => events.push(e),
		...extra,
	});

	it('runs tools and returns results to the model', async () => {
		writeFileSync(path.join(dir, 'loop.txt'), 'hello loop\n');
		const seen: ChatRequest[] = [];
		const model = scripted([
			[{ type: 'text', text: 'Reading.' }, { type: 'tool_use', id: '1', name: 'Read', input: { file_path: 'loop.txt' } }, { type: 'tool_use', id: '2', name: 'Nope', input: {} }],
			[{ type: 'text', text: 'It says hello.' }],
		], seen);
		const events: AgentEvent[] = [];
		const messages: Message[] = [{ role: 'user', content: [{ type: 'text', text: 'read it' }] }];
		const result = await makeAgent(model, events).run(messages, new AbortController().signal);
		assert.equal(result.text, 'It says hello.');
		assert.equal(messages.length, 4);
		const results = messages[2].content as Extract<Part, { type: 'tool_result' }>[];
		assert.match(results[0].content, /hello loop/);
		assert.equal(results[1].isError, true);
		assert.equal(seen[1].messages.length, 3);
		assert.ok(events.some(e => e.type === 'tool_call' && e.title === 'Read loop.txt'));
	});

	it('stops when the user declines and skips the remaining calls', async () => {
		const model = scripted([[{ type: 'tool_use', id: '1', name: 'Bash', input: { command: 'touch x' } }, { type: 'tool_use', id: '2', name: 'Read', input: { file_path: 'loop.txt' } }]]);
		const messages: Message[] = [{ role: 'user', content: [{ type: 'text', text: 'go' }] }];
		const result = await makeAgent(model, [], async t => t.spec.name === 'Bash' ? { allow: false, reason: 'The user declined.', stop: true } : { allow: true }).run(messages, new AbortController().signal);
		assert.equal(result.stopReason, 'denied');
		const results = messages[2].content as Extract<Part, { type: 'tool_result' }>[];
		assert.deepEqual(results.map(r => r.isError), [true, true]);
		assert.match(results[1].content, /Skipped/);
	});

	it('adds messages queued while it works', async () => {
		const queue = ['also check y'];
		const seen: ChatRequest[] = [];
		const model = scripted([[{ type: 'tool_use', id: '1', name: 'LS', input: {} }], [{ type: 'text', text: 'ok' }]], seen);
		const messages: Message[] = [{ role: 'user', content: [{ type: 'text', text: 'go' }] }];
		await makeAgent(model, [], undefined, { takeQueued: () => queue.splice(0) }).run(messages, new AbortController().signal);
		const last = seen[1].messages.at(-1)!;
		assert.deepEqual(last.content.at(-1), { type: 'text', text: 'also check y' });
	});

	it('compacts when the context is nearly full', async () => {
		const model = scripted([[{ type: 'tool_use', id: '1', name: 'LS', input: {} }], [{ type: 'text', text: 'SUMMARY' }], [{ type: 'text', text: 'finished' }]]);
		const events: AgentEvent[] = [];
		const messages: Message[] = [{ role: 'user', content: [{ type: 'text', text: 'go' }] }];
		await makeAgent(model, events, undefined, { contextWindow: 1000, compactAt: 0.8 }).run(messages, new AbortController().signal);
		assert.ok(events.some(e => e.type === 'compacted'));
		assert.match((messages[0].content[0] as { text: string }).text, /SUMMARY[\s\S]*Continue the work/);
		assert.equal(messages.length, 2);
	});

	it('lets a PreToolUse hook block a call', async () => {
		const hooks = new Hooks({ PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo "no shell today" >&2; exit 2' }] }] }, shell, dir, 's1');
		const model = scripted([[{ type: 'tool_use', id: '1', name: 'Bash', input: { command: 'echo hi' } }]]);
		const messages: Message[] = [{ role: 'user', content: [{ type: 'text', text: 'go' }] }];
		await makeAgent(model, [], undefined, { hooks }).run(messages, new AbortController().signal);
		const result = messages[2].content[0] as Extract<Part, { type: 'tool_result' }>;
		assert.match(result.content, /no shell today/);
	});
});
