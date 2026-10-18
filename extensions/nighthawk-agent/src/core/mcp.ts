/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// A Model Context Protocol client for stdio and Streamable HTTP servers.
// Each server's tools become agent tools named mcp__<server>__<tool>.

import { spawn, type ChildProcess } from 'node:child_process';
import { readSse } from './sse';
import { killTree, truncateOutput } from './shell';
import { ToolError, type Tool, type ToolResult } from './tools';

export type McpServerConfig =
	| { type?: 'stdio'; command: string; args?: string[]; env?: Record<string, string>; cwd?: string; url?: undefined }
	| { type: 'http' | 'sse' | 'streamable-http'; url: string; headers?: Record<string, string> };

export interface McpToolInfo {
	name: string;
	description?: string;
	inputSchema?: Record<string, unknown>;
	annotations?: { readOnlyHint?: boolean; title?: string };
}

const PROTOCOL_VERSION = '2025-06-18';

interface Pending {
	resolve(value: any): void;
	reject(err: Error): void;
	timer: ReturnType<typeof setTimeout>;
}

type Transport = {
	send(message: Record<string, unknown>): Promise<void>;
	close(): void;
};

export class McpClient {
	readonly name: string;
	private readonly config: McpServerConfig;
	private transport: Transport | undefined;
	private nextId = 1;
	private readonly pending = new Map<number, Pending>();
	private sessionId: string | undefined;
	private readonly roots: string[];
	tools: McpToolInfo[] = [];
	status: 'starting' | 'ready' | 'failed' | 'stopped' = 'starting';
	error: string | undefined;
	/** Recent stderr from a stdio server, to explain failures. */
	stderr = '';
	onDidChangeTools: (() => void) | undefined;

	constructor(name: string, config: McpServerConfig, roots: string[]) {
		this.name = name;
		this.config = config;
		this.roots = roots;
	}

	async start(): Promise<void> {
		try {
			this.transport = this.config.url !== undefined ? this.httpTransport(this.config.url, this.config.headers ?? {}) : this.stdioTransport();
			await this.request('initialize', {
				protocolVersion: PROTOCOL_VERSION,
				capabilities: { roots: { listChanged: false } },
				clientInfo: { name: 'nighthawk', version: '1.0.0' },
			}, 30_000);
			await this.notify('notifications/initialized');
			await this.refreshTools();
			this.status = 'ready';
		} catch (err) {
			this.status = 'failed';
			this.error = `${err.message}${this.stderr ? `\n${this.stderr.trim().slice(-1000)}` : ''}`;
			this.stop();
			throw new Error(this.error);
		}
	}

	stop(): void {
		if (this.status !== 'failed') {
			this.status = 'stopped';
		}
		this.transport?.close();
		this.transport = undefined;
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(new Error(`MCP server ${this.name} stopped.`));
		}
		this.pending.clear();
	}

	async refreshTools(): Promise<void> {
		const tools: McpToolInfo[] = [];
		let cursor: string | undefined;
		do {
			const result = await this.request('tools/list', cursor ? { cursor } : {});
			tools.push(...(result?.tools ?? []));
			cursor = result?.nextCursor;
		} while (cursor);
		this.tools = tools;
	}

	async callTool(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<ToolResult> {
		const result = await this.request('tools/call', { name, arguments: args }, 10 * 60_000, signal);
		const texts: string[] = [];
		const images: { mediaType: string; data: string }[] = [];
		for (const item of result?.content ?? []) {
			if (item.type === 'text') {
				texts.push(item.text);
			} else if (item.type === 'image' && item.data) {
				images.push({ mediaType: item.mimeType ?? 'image/png', data: item.data });
			} else if (item.type === 'resource' && item.resource) {
				texts.push(item.resource.text ?? `[resource ${item.resource.uri}]`);
			} else if (item.type === 'resource_link') {
				texts.push(`[${item.name ?? 'resource'}: ${item.uri}]`);
			}
		}
		if (!texts.length && result?.structuredContent) {
			texts.push(JSON.stringify(result.structuredContent, null, 2));
		}
		return { content: truncateOutput(texts.join('\n\n'), 60_000) || '(no output)', images: images.length ? images : undefined, isError: !!result?.isError };
	}

	private request(method: string, params: Record<string, unknown>, timeoutMs = 60_000, signal?: AbortSignal): Promise<any> {
		if (!this.transport) {
			return Promise.reject(new Error(`MCP server ${this.name} is not running.`));
		}
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`MCP server ${this.name} did not answer ${method} in time.`));
			}, timeoutMs);
			signal?.addEventListener('abort', () => {
				clearTimeout(timer);
				this.pending.delete(id);
				this.notify('notifications/cancelled', { requestId: id, reason: 'The user stopped the agent.' }).catch(() => { });
				reject(new Error('Cancelled.'));
			}, { once: true });
			this.pending.set(id, { resolve, reject, timer });
			this.transport!.send({ jsonrpc: '2.0', id, method, params }).catch(err => {
				clearTimeout(timer);
				this.pending.delete(id);
				reject(err);
			});
		});
	}

	private notify(method: string, params?: Record<string, unknown>): Promise<void> {
		return this.transport?.send({ jsonrpc: '2.0', method, ...(params ? { params } : {}) }) ?? Promise.resolve();
	}

	private onMessage(message: any): void {
		if (!message || typeof message !== 'object') {
			return;
		}
		if (Array.isArray(message)) {
			message.forEach(m => this.onMessage(m));
			return;
		}
		if (message.id !== undefined && (message.result !== undefined || message.error !== undefined) && message.method === undefined) {
			const pending = this.pending.get(message.id);
			if (pending) {
				clearTimeout(pending.timer);
				this.pending.delete(message.id);
				if (message.error) {
					pending.reject(new Error(message.error.message ?? 'MCP error'));
				} else {
					pending.resolve(message.result);
				}
			}
			return;
		}
		if (message.method && message.id !== undefined) {
			// A request from the server.
			let result: unknown;
			if (message.method === 'ping') {
				result = {};
			} else if (message.method === 'roots/list') {
				result = { roots: this.roots.map(r => ({ uri: `file://${r.startsWith('/') ? '' : '/'}${r.replace(/\\/g, '/')}`, name: r.split(/[\\/]/).pop() })) };
			}
			const reply = result !== undefined
				? { jsonrpc: '2.0', id: message.id, result }
				: { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `Nighthawk does not support ${message.method}.` } };
			this.transport?.send(reply).catch(() => { });
			return;
		}
		if (message.method === 'notifications/tools/list_changed') {
			this.refreshTools().then(() => this.onDidChangeTools?.(), () => { });
		}
	}

	private stdioTransport(): Transport {
		const config = this.config as Extract<McpServerConfig, { command: string }>;
		const child: ChildProcess = spawn(config.command, config.args ?? [], {
			cwd: config.cwd ?? this.roots[0],
			env: { ...process.env, ...config.env },
			stdio: ['pipe', 'pipe', 'pipe'],
			shell: process.platform === 'win32',
			detached: process.platform !== 'win32',
			windowsHide: true,
		});
		let buffer = '';
		child.stdout!.on('data', (data: Buffer) => {
			buffer += data.toString('utf8');
			let index: number;
			while ((index = buffer.indexOf('\n')) >= 0) {
				const line = buffer.slice(0, index).trim();
				buffer = buffer.slice(index + 1);
				if (line) {
					try {
						this.onMessage(JSON.parse(line));
					} catch {
						// Servers sometimes log to stdout; ignore non-JSON lines.
					}
				}
			}
		});
		child.stderr!.on('data', (data: Buffer) => {
			this.stderr = (this.stderr + data.toString('utf8')).slice(-4000);
		});
		const exited = new Promise<never>((_, reject) => {
			child.on('error', err => reject(err));
			child.on('exit', code => reject(new Error(`exited with code ${code}`)));
		});
		exited.catch(err => {
			const wasRunning = this.status === 'ready';
			for (const pending of this.pending.values()) {
				clearTimeout(pending.timer);
				pending.reject(new Error(`MCP server ${this.name} ${err.message}.`));
			}
			this.pending.clear();
			if (wasRunning) {
				this.status = 'failed';
				this.error = `${err.message}${this.stderr ? `\n${this.stderr.trim().slice(-1000)}` : ''}`;
				this.onDidChangeTools?.();
			}
		});
		return {
			send: async message => {
				if (!child.stdin?.writable) {
					throw new Error(`MCP server ${this.name} is not running.`);
				}
				child.stdin.write(JSON.stringify(message) + '\n');
			},
			close: () => killTree(child),
		};
	}

	private httpTransport(url: string, headers: Record<string, string>): Transport {
		const controller = new AbortController();
		return {
			send: async message => {
				const response = await fetch(url, {
					method: 'POST',
					headers: {
						'content-type': 'application/json',
						accept: 'application/json, text/event-stream',
						'mcp-protocol-version': PROTOCOL_VERSION,
						...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {}),
						...headers,
					},
					body: JSON.stringify(message),
					signal: controller.signal,
				});
				const session = response.headers.get('mcp-session-id');
				if (session) {
					this.sessionId = session;
				}
				if (!response.ok) {
					const text = await response.text().catch(() => '');
					const err = new Error(`HTTP ${response.status}${text ? `: ${text.slice(0, 300)}` : ''}`);
					if (message.id !== undefined && this.pending.has(message.id as number)) {
						const pending = this.pending.get(message.id as number)!;
						clearTimeout(pending.timer);
						this.pending.delete(message.id as number);
						pending.reject(err);
						return;
					}
					throw err;
				}
				const type = response.headers.get('content-type') ?? '';
				if (type.includes('text/event-stream') && response.body) {
					// Read the stream without blocking the caller; replies resolve pending requests.
					(async () => {
						for await (const event of readSse(response.body as unknown as AsyncIterable<Uint8Array>)) {
							try {
								this.onMessage(JSON.parse(event.data));
							} catch {
								// Ignore.
							}
						}
					})().catch(() => { });
				} else if (type.includes('application/json')) {
					this.onMessage(await response.json());
				} else {
					await response.body?.cancel();
				}
			},
			close: () => {
				controller.abort();
				if (this.sessionId) {
					fetch(url, { method: 'DELETE', headers: { 'mcp-session-id': this.sessionId, ...headers } }).catch(() => { });
				}
			},
		};
	}
}

/** Tool names must be short and use only letters, digits, _ and -. */
export function mcpToolName(server: string, tool: string): string {
	const clean = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, '_');
	return `mcp__${clean(server)}__${clean(tool)}`.slice(0, 64);
}

export function mcpTools(client: McpClient): Tool[] {
	return client.tools.map(info => ({
		kind: info.annotations?.readOnlyHint ? 'read' : 'execute',
		parallel: !!info.annotations?.readOnlyHint,
		spec: {
			name: mcpToolName(client.name, info.name),
			description: `${info.description ?? info.annotations?.title ?? info.name} (MCP server: ${client.name})`.slice(0, 2000),
			inputSchema: info.inputSchema && typeof info.inputSchema === 'object' ? info.inputSchema : { type: 'object', properties: {} },
		},
		title: () => `${client.name}: ${info.annotations?.title ?? info.name}`,
		run: async (input, ctx) => {
			if (client.status !== 'ready') {
				throw new ToolError(`MCP server ${client.name} is not running${client.error ? `: ${client.error}` : ''}.`);
			}
			return client.callTool(info.name, input, ctx.signal);
		},
	}));
}

/** Reads `mcpServers` from a JSON config (.mcp.json, settings). */
export function parseMcpServers(json: unknown): Record<string, McpServerConfig> {
	const servers = (json as { mcpServers?: unknown; servers?: unknown } | undefined)?.mcpServers ?? (json as { servers?: unknown } | undefined)?.servers;
	const result: Record<string, McpServerConfig> = {};
	if (!servers || typeof servers !== 'object') {
		return result;
	}
	for (const [name, value] of Object.entries(servers as Record<string, any>)) {
		if (!value || typeof value !== 'object' || value.disabled) {
			continue;
		}
		if (typeof value.url === 'string') {
			result[name] = { type: 'http', url: value.url, headers: value.headers };
		} else if (typeof value.command === 'string') {
			result[name] = { command: value.command, args: Array.isArray(value.args) ? value.args.map(String) : [], env: value.env, cwd: value.cwd };
		}
	}
	return result;
}
