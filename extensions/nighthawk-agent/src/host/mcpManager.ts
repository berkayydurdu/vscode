/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { McpClient, mcpTools, parseMcpServers, type McpServerConfig } from '../core/mcp';
import type { Tool } from '../core/tools';

interface ServerEntry {
	name: string;
	config: McpServerConfig;
	source: string;
	/** From the project rather than the user: needs the user's OK before it runs. */
	project: boolean;
}

const APPROVED_KEY = 'nighthawk.agent.mcp.approved';

function describe(config: McpServerConfig): string {
	return config.url !== undefined ? config.url : [config.command, ...(config.args ?? [])].join(' ');
}

/** Starts the MCP servers from settings and config files and offers their tools to the agent. */
export class McpManager implements vscode.Disposable {
	private readonly clients = new Map<string, McpClient>();
	private starting: Promise<void> | undefined;
	private readonly changed = new vscode.EventEmitter<void>();
	readonly onDidChange = this.changed.event;
	private readonly skipped: string[] = [];

	constructor(private readonly context: vscode.ExtensionContext) { }

	dispose(): void {
		this.stopAll();
		this.changed.dispose();
	}

	private stopAll(): void {
		for (const client of this.clients.values()) {
			client.stop();
		}
		this.clients.clear();
	}

	private async readJson(file: string): Promise<unknown> {
		try {
			return JSON.parse(await fs.readFile(file, 'utf8'));
		} catch {
			return undefined;
		}
	}

	private async entries(): Promise<ServerEntry[]> {
		const result = new Map<string, ServerEntry>();
		const add = (json: unknown, source: string, project: boolean) => {
			for (const [name, config] of Object.entries(parseMcpServers(json))) {
				if (!result.has(name)) {
					result.set(name, { name, config, source, project });
				}
			}
		};
		add({ mcpServers: vscode.workspace.getConfiguration('nighthawk.agent').get('mcpServers') }, 'settings', false);
		const home = os.homedir();
		add(await this.readJson(path.join(home, '.nighthawk', 'mcp.json')), '~/.nighthawk/mcp.json', false);
		if (vscode.workspace.isTrusted) {
			for (const folder of vscode.workspace.workspaceFolders ?? []) {
				const root = folder.uri.fsPath;
				add(await this.readJson(path.join(root, '.nighthawk', 'mcp.json')), '.nighthawk/mcp.json', true);
				add(await this.readJson(path.join(root, '.mcp.json')), '.mcp.json', true);
				add(await this.readJson(path.join(root, '.vscode', 'mcp.json')), '.vscode/mcp.json', true);
			}
		}
		return [...result.values()];
	}

	/** Starts servers once; later calls wait for the same start. */
	ensureStarted(): Promise<void> {
		this.starting ??= this.startAll();
		return this.starting;
	}

	async restart(): Promise<void> {
		this.stopAll();
		this.starting = undefined;
		await this.ensureStarted();
		this.changed.fire();
	}

	private async startAll(): Promise<void> {
		this.skipped.length = 0;
		const approved = new Set(this.context.workspaceState.get<string[]>(APPROVED_KEY, []));
		const roots = (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath);
		const starts: Promise<void>[] = [];
		for (const entry of await this.entries()) {
			const text = JSON.stringify(entry.config);
			if (text.includes('${input:')) {
				this.skipped.push(vscode.l10n.t('{0}: needs ${input:...} values, which only the built-in MCP support can prompt for.', entry.name));
				continue;
			}
			if (entry.project) {
				const key = `${entry.name}:${text}`;
				if (!approved.has(key)) {
					const allow = vscode.l10n.t('Allow');
					const answer = await vscode.window.showInformationMessage(
						vscode.l10n.t('This workspace\'s {0} wants to start the MCP server "{1}": {2}', entry.source, entry.name, describe(entry.config)),
						allow, vscode.l10n.t('Don\'t Allow'));
					if (answer !== allow) {
						this.skipped.push(vscode.l10n.t('{0}: not allowed for this workspace.', entry.name));
						continue;
					}
					approved.add(key);
					await this.context.workspaceState.update(APPROVED_KEY, [...approved]);
				}
			}
			const client = new McpClient(entry.name, this.resolveVariables(entry.config, roots[0] ?? ''), roots);
			client.onDidChangeTools = () => this.changed.fire();
			this.clients.set(entry.name, client);
			starts.push(client.start().catch(() => { /* status shows the error */ }));
		}
		await Promise.all(starts);
		this.changed.fire();
	}

	private resolveVariables(config: McpServerConfig, root: string): McpServerConfig {
		const text = JSON.stringify(config)
			.replace(/\$\{workspaceFolder\}/g, root.replace(/\\/g, '\\\\'))
			.replace(/\$\{userHome\}/g, os.homedir().replace(/\\/g, '\\\\'))
			.replace(/\$\{env:([\w]+)\}/g, (_, name: string) => process.env[name] ?? '');
		return JSON.parse(text);
	}

	tools(): Tool[] {
		return [...this.clients.values()].filter(c => c.status === 'ready').flatMap(mcpTools);
	}

	/** A Markdown status report for /mcp. */
	status(): string {
		if (!this.clients.size && !this.skipped.length) {
			return vscode.l10n.t('No MCP servers are configured. Add them under `nighthawk.agent.mcpServers` in settings, in `~/.nighthawk/mcp.json`, or in the project\'s `.mcp.json`.');
		}
		const lines = [...this.clients.values()].map(c => {
			const state = c.status === 'ready' ? `ready, ${c.tools.length} tools` : c.status === 'failed' ? `failed: ${c.error?.split('\n')[0]}` : c.status;
			return `- **${c.name}**: ${state}`;
		});
		lines.push(...this.skipped.map(s => `- ${s}`));
		return lines.join('\n');
	}
}
