/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// A client for the Agent Client Protocol (https://agentclientprotocol.com),
// which runs other coding agents, such as Claude Code, Gemini CLI or Codex,
// as child processes that talk JSON-RPC over stdin and stdout. Nighthawk
// shows their messages and tool calls and serves their file reads, file
// writes, terminals and permission prompts.

import { spawn, type ChildProcess } from 'node:child_process';

export const ACP_PROTOCOL_VERSION = 1;

/** An external agent the user can start, from a preset or the nighthawk.agent.externalAgents setting. */
export interface ExternalAgent {
	/** Shown in the picker and the conversation; also its key. */
	name: string;
	command: string;
	args?: string[];
	env?: Record<string, string>;
	description?: string;
}

/** Agents Nighthawk knows how to start. They need Node.js for npx, and the agent's own sign-in. */
export const AGENT_PRESETS: ExternalAgent[] = [
	{ name: 'Claude Code', command: 'npx', args: ['-y', '@agentclientprotocol/claude-agent-acp'], description: 'Anthropic\'s Claude Code. Uses your Claude sign-in or ANTHROPIC_API_KEY.' },
	{ name: 'Gemini CLI', command: 'npx', args: ['-y', '@google/gemini-cli', '--experimental-acp'], description: 'Google\'s Gemini CLI. Uses your Google sign-in or GEMINI_API_KEY.' },
	{ name: 'Codex', command: 'npx', args: ['-y', '@agentclientprotocol/codex-acp'], description: 'OpenAI\'s Codex. Uses your ChatGPT sign-in or OPENAI_API_KEY.' },
];

/** The configured agents, then the presets the configuration does not replace. */
export function externalAgents(configured: unknown): ExternalAgent[] {
	const own = (Array.isArray(configured) ? configured : []).flatMap((entry: Partial<ExternalAgent>) => typeof entry?.name === 'string' && entry.name.trim() && typeof entry.command === 'string' && entry.command.trim()
		? [{
			name: entry.name.trim(),
			command: entry.command.trim(),
			args: Array.isArray(entry.args) ? entry.args.map(String) : [],
			env: entry.env && typeof entry.env === 'object' ? Object.fromEntries(Object.entries(entry.env).map(([k, v]) => [k, String(v)])) : undefined,
			description: typeof entry.description === 'string' ? entry.description : undefined,
		}]
		: []);
	return [...own, ...AGENT_PRESETS.filter(preset => !own.some(a => a.name.toLowerCase() === preset.name.toLowerCase()))];
}

// --- Protocol types (the parts Nighthawk uses)

export type AcpContent =
	| { type: 'text'; text: string }
	| { type: 'image'; data: string; mimeType: string }
	| { type: 'resource_link'; uri: string; name: string }
	| { type: 'resource'; resource: { uri: string; text?: string; mimeType?: string } }
	| { type: string;[key: string]: unknown };

export type AcpToolKind = 'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' | 'think' | 'fetch' | 'switch_mode' | 'other';
export type AcpToolStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

export type AcpToolContent =
	| { type: 'content'; content: AcpContent }
	| { type: 'diff'; path: string; oldText?: string | null; newText: string }
	| { type: 'terminal'; terminalId: string };

export interface AcpToolCall {
	toolCallId: string;
	title?: string | null;
	kind?: AcpToolKind | null;
	status?: AcpToolStatus | null;
	content?: AcpToolContent[] | null;
	locations?: { path: string; line?: number | null }[] | null;
	rawInput?: unknown;
	rawOutput?: unknown;
}

export interface AcpPlanEntry {
	content: string;
	priority?: string;
	status: 'pending' | 'in_progress' | 'completed';
}

export interface AcpMode {
	id: string;
	name: string;
	description?: string | null;
}

export type AcpUpdate =
	| { sessionUpdate: 'user_message_chunk' | 'agent_message_chunk' | 'agent_thought_chunk'; content: AcpContent }
	| ({ sessionUpdate: 'tool_call' } & AcpToolCall)
	| ({ sessionUpdate: 'tool_call_update' } & AcpToolCall)
	| { sessionUpdate: 'plan'; entries: AcpPlanEntry[] }
	| { sessionUpdate: 'available_commands_update'; availableCommands: { name: string; description?: string; input?: { hint?: string } | null }[] }
	| { sessionUpdate: 'current_mode_update'; currentModeId: string }
	| { sessionUpdate: string;[key: string]: unknown };

export interface AcpPermissionOption {
	optionId: string;
	name: string;
	kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';
}

export interface AcpAuthMethod {
	id: string;
	name: string;
	description?: string | null;
	type?: string;
}

export interface AcpInitialized {
	protocolVersion: number;
	agentCapabilities?: { loadSession?: boolean; promptCapabilities?: { image?: boolean; embeddedContext?: boolean } };
	authMethods?: AcpAuthMethod[];
	agentInfo?: { name?: string; version?: string } | null;
}

export interface AcpSession {
	sessionId: string;
	modes?: { currentModeId: string; availableModes: AcpMode[] } | null;
}

export type StopReason = 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled';

/** What the agent asks of the editor. */
export interface AcpHost {
	onUpdate(update: AcpUpdate): void;
	requestPermission(toolCall: AcpToolCall, options: AcpPermissionOption[]): Promise<string | undefined>;
	readTextFile(path: string, line?: number, limit?: number): Promise<string>;
	writeTextFile(path: string, content: string): Promise<void>;
	/** Output of a terminal the agent started, as it arrives. */
	onTerminalOutput?(terminalId: string, text: string): void;
	/** Whatever the agent writes to stderr, for the log. */
	onLog?(text: string): void;
}

export class AcpError extends Error {
	readonly code: number;
	readonly data: unknown;

	constructor(message: string, code: number, data?: unknown) {
		super(message);
		this.code = code;
		this.data = data;
	}

	/** The agent needs the user to sign in first. */
	get authRequired(): boolean {
		return this.code === -32000 || /auth(entication)? required|not (signed|logged) in|please (log|sign) ?in/i.test(this.message);
	}
}

interface Pending {
	resolve(value: unknown): void;
	reject(error: Error): void;
}

type Handler = (params: Record<string, unknown>) => Promise<unknown>;

/**
 * JSON-RPC 2.0 over newline-delimited JSON. `write` sends one line;
 * `receive` takes the bytes read from the peer.
 */
export class JsonRpcPeer {
	private nextId = 1;
	private readonly pending = new Map<number | string, Pending>();
	private readonly handlers = new Map<string, Handler>();
	private buffer = '';
	private readonly write: (line: string) => void;
	private closedWith: Error | undefined;

	constructor(write: (line: string) => void) {
		this.write = write;
	}

	on(method: string, handler: Handler): void {
		this.handlers.set(method, handler);
	}

	request<T>(method: string, params: unknown): Promise<T> {
		if (this.closedWith) {
			return Promise.reject(this.closedWith);
		}
		const id = this.nextId++;
		return new Promise<T>((resolve, reject) => {
			this.pending.set(id, { resolve: value => resolve(value as T), reject });
			this.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
		});
	}

	notify(method: string, params: unknown): void {
		if (!this.closedWith) {
			this.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
		}
	}

	receive(chunk: string): void {
		this.buffer += chunk;
		let end: number;
		while ((end = this.buffer.indexOf('\n')) >= 0) {
			const line = this.buffer.slice(0, end).trim();
			this.buffer = this.buffer.slice(end + 1);
			if (line) {
				this.handle(line);
			}
		}
	}

	/** Fails every request still waiting, and every later one. */
	close(error: Error): void {
		this.closedWith = error;
		for (const pending of this.pending.values()) {
			pending.reject(error);
		}
		this.pending.clear();
	}

	private handle(line: string): void {
		let message: { id?: number | string | null; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { code: number; message: string; data?: unknown } };
		try {
			message = JSON.parse(line);
		} catch {
			return;
		}
		if (typeof message.method === 'string') {
			const handler = this.handlers.get(message.method);
			const id = message.id;
			if (id === undefined || id === null) {
				handler?.(message.params ?? {}).catch(() => undefined);
				return;
			}
			if (!handler) {
				this.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${message.method}` } })}\n`);
				return;
			}
			handler(message.params ?? {}).then(
				result => this.write(`${JSON.stringify({ jsonrpc: '2.0', id, result: result ?? null })}\n`),
				(err: unknown) => this.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code: err instanceof AcpError ? err.code : -32603, message: err instanceof Error ? err.message : String(err) } })}\n`),
			);
			return;
		}
		if (message.id === undefined || message.id === null) {
			return;
		}
		const pending = this.pending.get(message.id);
		if (!pending) {
			return;
		}
		this.pending.delete(message.id);
		if (message.error) {
			pending.reject(new AcpError(message.error.message || 'The agent returned an error.', message.error.code, message.error.data));
		} else {
			pending.resolve(message.result);
		}
	}
}

/** Starts a command without a shell. On Windows, commands like npx are .cmd scripts that only cmd.exe runs. */
export function spawnAgent(command: string, args: string[], options: { cwd: string; env?: Record<string, string> }): ChildProcess {
	const env = { ...process.env, ...options.env };
	if (process.platform === 'win32' && !/\.(exe|com)$/i.test(command)) {
		const quote = (arg: string) => /^[\w@./:=+-]+$/.test(arg) ? arg : `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
		return spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${[command, ...args].map(quote).join(' ')}"`], { cwd: options.cwd, env, windowsVerbatimArguments: true, windowsHide: true });
	}
	return spawn(command, args, { cwd: options.cwd, env, windowsHide: true });
}

interface Terminal {
	process: ChildProcess;
	output: string;
	truncated: boolean;
	limit: number;
	exit?: { exitCode: number | null; signal: string | null };
	exited: Promise<void>;
}

/** Keeps the end of the text within `limit` bytes, cut at a character. */
function keepTail(text: string, limit: number): { text: string; cut: boolean } {
	if (Buffer.byteLength(text) <= limit) {
		return { text, cut: false };
	}
	const bytes = Buffer.from(text);
	let start = bytes.length - limit;
	// Skips continuation bytes so the text starts at a whole character.
	while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) {
		start++;
	}
	return { text: bytes.subarray(start).toString(), cut: true };
}

/**
 * One running external agent: its process and its protocol session.
 * `start` launches it and says hello; `newSession` or `loadSession` opens
 * a conversation; `prompt` sends a message and resolves when the turn ends.
 */
export class AcpClient {
	readonly agent: ExternalAgent;
	private readonly host: AcpHost;
	private process: ChildProcess | undefined;
	private peer: JsonRpcPeer | undefined;
	private readonly terminals = new Map<string, Terminal>();
	private nextTerminal = 1;
	private stderr = '';
	initialized: AcpInitialized | undefined;
	session: AcpSession | undefined;
	private exitError: Error | undefined;

	constructor(agent: ExternalAgent, host: AcpHost) {
		this.agent = agent;
		this.host = host;
	}

	get running(): boolean {
		return !!this.process && !this.exitError;
	}

	/** Launches the agent and negotiates the protocol. */
	async start(cwd: string): Promise<AcpInitialized> {
		if (this.initialized && this.running) {
			return this.initialized;
		}
		const child = spawnAgent(this.agent.command, this.agent.args ?? [], { cwd, env: this.agent.env });
		this.process = child;
		this.exitError = undefined;
		const peer = this.peer = new JsonRpcPeer(line => {
			child.stdin?.write(line);
		});
		child.stdout?.setEncoding('utf8');
		child.stdout?.on('data', (chunk: string) => peer.receive(chunk));
		child.stderr?.setEncoding('utf8');
		child.stderr?.on('data', (chunk: string) => {
			this.stderr = (this.stderr + chunk).slice(-4000);
			this.host.onLog?.(chunk);
		});
		const failed = (error: Error) => {
			this.exitError = error;
			peer.close(error);
		};
		child.on('error', err => failed(new Error(`${this.agent.name} could not start (${this.agent.command}): ${err.message}${/ENOENT/.test(err.message) && this.agent.command === 'npx' ? '. It needs Node.js: install it from nodejs.org, then restart Nighthawk.' : ''}`)));
		child.on('exit', (code, signal) => failed(new Error(`${this.agent.name} stopped (${signal ?? `exit code ${code}`}).${this.stderr.trim() ? ` It said: ${this.stderr.trim().split('\n').slice(-5).join('\n')}` : ''}`)));
		child.stdin?.on('error', () => undefined);
		this.serve(peer);
		this.initialized = await peer.request<AcpInitialized>('initialize', {
			protocolVersion: ACP_PROTOCOL_VERSION,
			clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
			clientInfo: { name: 'nighthawk', title: 'Nighthawk', version: '1.0.0' },
		});
		return this.initialized;
	}

	private serve(peer: JsonRpcPeer): void {
		peer.on('session/update', async params => {
			if (params.update && typeof params.update === 'object') {
				this.host.onUpdate(params.update as AcpUpdate);
			}
		});
		peer.on('session/request_permission', async params => {
			const options = (Array.isArray(params.options) ? params.options : []) as AcpPermissionOption[];
			const optionId = await this.host.requestPermission((params.toolCall ?? {}) as AcpToolCall, options);
			return { outcome: optionId ? { outcome: 'selected', optionId } : { outcome: 'cancelled' } };
		});
		peer.on('fs/read_text_file', async params => ({
			content: await this.host.readTextFile(String(params.path), typeof params.line === 'number' ? params.line : undefined, typeof params.limit === 'number' ? params.limit : undefined),
		}));
		peer.on('fs/write_text_file', async params => {
			await this.host.writeTextFile(String(params.path), String(params.content ?? ''));
			return null;
		});
		peer.on('terminal/create', async params => this.createTerminal(params));
		peer.on('terminal/output', async params => {
			const terminal = this.terminal(params.terminalId);
			return { output: terminal.output, truncated: terminal.truncated, exitStatus: terminal.exit ?? null };
		});
		peer.on('terminal/wait_for_exit', async params => {
			const terminal = this.terminal(params.terminalId);
			await terminal.exited;
			return terminal.exit ?? { exitCode: null, signal: null };
		});
		peer.on('terminal/kill', async params => {
			this.terminal(params.terminalId).process.kill();
			return null;
		});
		peer.on('terminal/release', async params => {
			const id = String(params.terminalId);
			const terminal = this.terminals.get(id);
			if (terminal && !terminal.exit) {
				terminal.process.kill();
			}
			this.terminals.delete(id);
			return null;
		});
	}

	private terminal(id: unknown): Terminal {
		const terminal = this.terminals.get(String(id));
		if (!terminal) {
			throw new AcpError(`Unknown terminal ${String(id)}`, -32602);
		}
		return terminal;
	}

	private async createTerminal(params: Record<string, unknown>): Promise<{ terminalId: string }> {
		const id = `term_${this.nextTerminal++}`;
		const env = Object.fromEntries((Array.isArray(params.env) ? params.env : []).map((v: { name: string; value: string }) => [String(v.name), String(v.value)]));
		const child = spawnAgent(String(params.command), Array.isArray(params.args) ? params.args.map(String) : [], { cwd: typeof params.cwd === 'string' ? params.cwd : process.cwd(), env });
		const limit = typeof params.outputByteLimit === 'number' ? params.outputByteLimit : 1_000_000;
		let finish: () => void = () => undefined;
		const terminal: Terminal = { process: child, output: '', truncated: false, limit, exited: new Promise<void>(resolve => finish = resolve) };
		const add = (chunk: string) => {
			const kept = keepTail(terminal.output + chunk, terminal.limit);
			terminal.output = kept.text;
			terminal.truncated ||= kept.cut;
			this.host.onTerminalOutput?.(id, chunk);
		};
		child.stdout?.setEncoding('utf8');
		child.stderr?.setEncoding('utf8');
		child.stdout?.on('data', add);
		child.stderr?.on('data', add);
		child.on('error', err => {
			add(`${err.message}\n`);
			terminal.exit = { exitCode: 127, signal: null };
			finish();
		});
		child.on('exit', (code, signal) => {
			terminal.exit ??= { exitCode: code, signal };
			finish();
		});
		this.terminals.set(id, terminal);
		return { terminalId: id };
	}

	private connection(): JsonRpcPeer {
		if (!this.peer || this.exitError) {
			throw this.exitError ?? new Error(`${this.agent.name} is not running.`);
		}
		return this.peer;
	}

	async authenticate(methodId: string): Promise<void> {
		await this.connection().request('authenticate', { methodId });
	}

	async newSession(cwd: string, additionalDirectories: string[] = []): Promise<AcpSession> {
		this.session = await this.connection().request<AcpSession>('session/new', { cwd, mcpServers: [], ...(additionalDirectories.length ? { additionalDirectories } : {}) });
		return this.session;
	}

	/** Reopens an earlier conversation, when the agent can. The agent replays it as updates. */
	async loadSession(sessionId: string, cwd: string): Promise<AcpSession> {
		const loaded = await this.connection().request<Omit<AcpSession, 'sessionId'> | null>('session/load', { sessionId, cwd, mcpServers: [] });
		this.session = { sessionId, modes: loaded?.modes };
		return this.session;
	}

	async setMode(modeId: string): Promise<void> {
		if (this.session) {
			await this.connection().request('session/set_mode', { sessionId: this.session.sessionId, modeId });
			if (this.session.modes) {
				this.session.modes.currentModeId = modeId;
			}
		}
	}

	/** Sends a user message; resolves with why the turn ended. Aborting cancels the turn. */
	async prompt(prompt: AcpContent[], signal: AbortSignal): Promise<StopReason> {
		const session = this.session;
		if (!session) {
			throw new Error('No session is open.');
		}
		const peer = this.connection();
		const cancel = () => peer.notify('session/cancel', { sessionId: session.sessionId });
		signal.addEventListener('abort', cancel, { once: true });
		try {
			const result = await peer.request<{ stopReason: StopReason }>('session/prompt', { sessionId: session.sessionId, prompt });
			return result?.stopReason ?? 'end_turn';
		} finally {
			signal.removeEventListener('abort', cancel);
		}
	}

	dispose(): void {
		for (const terminal of this.terminals.values()) {
			if (!terminal.exit) {
				terminal.process.kill();
			}
		}
		this.terminals.clear();
		this.peer?.close(new Error(`${this.agent.name} was closed.`));
		this.process?.stdin?.end();
		this.process?.kill();
		this.process = undefined;
	}
}

/** The text of a content block, for showing it; images and links become a short note. */
export function contentText(content: AcpContent | undefined): string {
	if (!content) {
		return '';
	}
	switch (content.type) {
		case 'text':
			return String((content as { text: string }).text ?? '');
		case 'resource_link':
			return `[${String((content as { name: string }).name)}](${String((content as { uri: string }).uri)})`;
		case 'resource': {
			const resource = (content as { resource: { uri: string; text?: string } }).resource;
			return resource?.text ?? resource?.uri ?? '';
		}
		case 'image':
			return '(image)';
		default:
			return '';
	}
}

/** A permission option of the given kind, if the agent offers one. */
export function pickOption(options: AcpPermissionOption[], ...kinds: AcpPermissionOption['kind'][]): AcpPermissionOption | undefined {
	for (const kind of kinds) {
		const option = options.find(o => o.kind === kind);
		if (option) {
			return option;
		}
	}
	return undefined;
}
