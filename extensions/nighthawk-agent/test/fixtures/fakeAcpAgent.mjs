/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// A tiny Agent Client Protocol agent for tests and demos. It answers a
// prompt by reading a file, asking to edit it, writing it, running a command
// in a terminal, and saying what it did. Set FAKE_ACP_AUTH=1 to make it ask
// for a sign-in first.

import { createInterface } from 'node:readline';

let nextId = 1000;
const waiting = new Map();
let signedIn = process.env.FAKE_ACP_AUTH !== '1';
let mode = 'default';
const sessionId = 'fake-session-1';

function send(message) {
	process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
}

function request(method, params) {
	const id = nextId++;
	send({ id, method, params });
	return new Promise((resolve, reject) => waiting.set(id, { resolve, reject }));
}

function update(update) {
	send({ method: 'session/update', params: { sessionId, update } });
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function prompt(params) {
	const text = params.prompt.map(p => p.text ?? '').join('');
	const file = /edit (\S+)/.exec(text)?.[1];
	update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Thinking about it.' } });
	update({ sessionUpdate: 'plan', entries: [{ content: 'Read the file', priority: 'high', status: 'in_progress' }, { content: 'Change it', priority: 'high', status: 'pending' }] });
	if (!file) {
		update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `You said: ${text}` } });
		return { stopReason: 'end_turn' };
	}
	update({ sessionUpdate: 'tool_call', toolCallId: 'read1', title: `Read ${file}`, kind: 'read', status: 'in_progress', locations: [{ path: file }] });
	const { content } = await request('fs/read_text_file', { sessionId, path: file });
	update({ sessionUpdate: 'tool_call_update', toolCallId: 'read1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: `${content.split('\n').length} lines` } }] });
	const next = content.replace('hello', 'hello from the fake agent');
	update({ sessionUpdate: 'tool_call', toolCallId: 'edit1', title: `Edit ${file}`, kind: 'edit', status: 'pending', locations: [{ path: file }], content: [{ type: 'diff', path: file, oldText: content, newText: next }] });
	if (mode !== 'bypassPermissions') {
		const answer = await request('session/request_permission', {
			sessionId,
			toolCall: { toolCallId: 'edit1' },
			options: [
				{ optionId: 'yes', name: 'Allow', kind: 'allow_once' },
				{ optionId: 'always', name: 'Always', kind: 'allow_always' },
				{ optionId: 'no', name: 'Reject', kind: 'reject_once' },
			],
		});
		if (answer.outcome.outcome !== 'selected' || answer.outcome.optionId === 'no') {
			update({ sessionUpdate: 'tool_call_update', toolCallId: 'edit1', status: 'failed' });
			update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'OK, I left it as it was.' } });
			return { stopReason: answer.outcome.outcome === 'cancelled' ? 'cancelled' : 'end_turn' };
		}
	}
	await request('fs/write_text_file', { sessionId, path: file, content: next });
	update({ sessionUpdate: 'tool_call_update', toolCallId: 'edit1', status: 'completed' });
	const { terminalId } = await request('terminal/create', { sessionId, command: process.execPath, args: ['-e', 'console.log("checked: ok")'], cwd: process.cwd() });
	update({ sessionUpdate: 'tool_call', toolCallId: 'run1', title: 'Check the change', kind: 'execute', status: 'in_progress', rawInput: { command: 'node -e check' }, content: [{ type: 'terminal', terminalId }] });
	const exit = await request('terminal/wait_for_exit', { sessionId, terminalId });
	const { output } = await request('terminal/output', { sessionId, terminalId });
	await request('terminal/release', { sessionId, terminalId });
	update({ sessionUpdate: 'tool_call_update', toolCallId: 'run1', status: exit.exitCode === 0 ? 'completed' : 'failed' });
	update({ sessionUpdate: 'plan', entries: [{ content: 'Read the file', priority: 'high', status: 'completed' }, { content: 'Change it', priority: 'high', status: 'completed' }] });
	for (const word of `Done: I changed ${file} and the check printed "${output.trim()}".`.split(/(?= )/)) {
		update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: word } });
		await sleep(Number(process.env.FAKE_ACP_DELAY ?? 0));
	}
	return { stopReason: 'end_turn' };
}

const handlers = {
	initialize: () => ({
		protocolVersion: 1,
		agentCapabilities: { loadSession: false },
		authMethods: [{ id: 'fake-login', name: 'Log in to Fake Agent', description: 'Pretends to sign in' }],
		agentInfo: { name: 'fake-agent', version: '1.0.0' },
	}),
	authenticate: () => {
		signedIn = true;
		return {};
	},
	'session/new': () => {
		if (!signedIn) {
			throw Object.assign(new Error('Authentication required'), { code: -32000 });
		}
		update({ sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'review', description: 'Review the code' }] });
		return {
			sessionId,
			modes: {
				currentModeId: mode,
				availableModes: [
					{ id: 'default', name: 'Always Ask' },
					{ id: 'acceptEdits', name: 'Accept Edits' },
					{ id: 'plan', name: 'Plan Mode' },
					{ id: 'bypassPermissions', name: 'Bypass Permissions' },
				],
			},
		};
	},
	'session/set_mode': params => {
		mode = params.modeId;
		update({ sessionUpdate: 'current_mode_update', currentModeId: mode });
		return {};
	},
	'session/prompt': prompt,
};

createInterface({ input: process.stdin }).on('line', async line => {
	if (!line.trim()) {
		return;
	}
	const message = JSON.parse(line);
	if (message.method) {
		const handler = handlers[message.method];
		if (message.id === undefined) {
			return;
		}
		try {
			if (!handler) {
				throw Object.assign(new Error(`Method not found: ${message.method}`), { code: -32601 });
			}
			send({ id: message.id, result: await handler(message.params) });
		} catch (err) {
			send({ id: message.id, error: { code: err.code ?? -32603, message: err.message } });
		}
	} else if (waiting.has(message.id)) {
		const { resolve, reject } = waiting.get(message.id);
		waiting.delete(message.id);
		if (message.error) {
			reject(new Error(message.error.message));
		} else {
			resolve(message.result);
		}
	}
});
