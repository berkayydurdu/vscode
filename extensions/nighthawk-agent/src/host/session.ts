/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomUUID } from 'node:crypto';
import { access } from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { Agent, type AgentEvent, type PermissionAnswer } from '../core/agent';
import { Hooks } from '../core/hooks';
import { decide, parseRule, suggestRule, type PermissionMode, type Rule } from '../core/permissions';
import type { HostMessage, Question, SlashCommandInfo, Todo, ToolDisplay, TranscriptItem, ViewState } from '../core/protocol';
import { buildSystemPrompt, INIT_PROMPT, REVIEW_PROMPT } from '../core/prompt';
import { guessContextWindow, modelStream } from '../core/providers';
import { findShell, shellFromPath, type Shell } from '../core/shell';
import { expandCommand, readSkillBody } from '../core/skills';
import { bashDescription, BUILTIN_TOOLS, SessionState, skillDescription, taskDescription, type Tool, type ToolContext, type ToolResult } from '../core/tools';
import type { Message, ModelStream, Usage } from '../core/types';
import { displayPath, resolvePath } from '../core/workspace';
import { diagnosticsTool, EditorWorkspace } from './editorWorkspace';
import type { Endpoints } from './endpoints';
import type { McpManager } from './mcpManager';
import { findRipgrep, loadProject, locations, type Project } from './project';
import { isBudgetError, type UsageMeter } from './usage';

export interface Services {
	context: vscode.ExtensionContext;
	endpoints: Endpoints;
	mcp: McpManager;
	store: SessionStore;
	usage: UsageMeter;
	/** Shows the agent, e.g. when a call needs approval while it is hidden. */
	reveal(): void;
	isVisible(): boolean;
}

export interface SessionData {
	id: string;
	title: string;
	created: number;
	updated: number;
	mode: PermissionMode;
	messages: Message[];
	items: TranscriptItem[];
	todos: Todo[];
	/** US dollars spent on this conversation so far, as far as prices are known. */
	cost?: number;
	/** Folders the agent works in instead of the workspace folders, such as a background task's worktree. */
	roots?: string[];
}

export interface SessionOptions {
	roots?: string[];
	mode?: PermissionMode;
}

/** What a user message changed, so it can be rewound. */
interface Turn {
	itemId: string;
	messageIndex: number;
	itemIndex: number;
	text: string;
	files: Map<string, string | undefined>;
}

const BUILTIN_COMMANDS: SlashCommandInfo[] = [
	{ name: 'clear', description: 'Start a new conversation' },
	{ name: 'compact', description: 'Summarize the conversation to free up context', hint: '[what to keep]' },
	{ name: 'init', description: 'Write an AGENTS.md with instructions for this project' },
	{ name: 'review', description: 'Review the uncommitted changes' },
	{ name: 'model', description: 'Switch the model' },
	{ name: 'plan', description: 'Switch to plan mode: research and propose before editing' },
	{ name: 'memory', description: 'Open the project\'s AGENTS.md instructions' },
	{ name: 'skills', description: 'List the available skills' },
	{ name: 'agents', description: 'List the sub-agents' },
	{ name: 'mcp', description: 'Show MCP servers and restart them' },
	{ name: 'context', description: 'Show how much of the context window is used' },
	{ name: 'help', description: 'Show what the agent can do' },
];

/** Tools a sub-agent never gets: they talk to the user or would nest agents. */
const SUBAGENT_EXCLUDED = new Set(['Task', 'TodoWrite', 'AskUserQuestion', 'ExitPlanMode']);

function newId(prefix: string): string {
	return `${prefix}_${randomUUID().slice(0, 8)}`;
}

function clip(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max)}\n...` : text;
}

function describeInput(name: string, input: Record<string, unknown>): string | undefined {
	if (name === 'Bash' && typeof input.command === 'string') {
		return input.command;
	}
	if (name === 'Task' && typeof input.prompt === 'string') {
		return input.prompt;
	}
	if ((name === 'Read' || name === 'Write' || name === 'Edit' || name === 'MultiEdit') && typeof input.file_path === 'string') {
		return undefined;
	}
	const text = JSON.stringify(input, null, 2);
	return text === '{}' ? undefined : clip(text, 2000);
}

export class Session implements vscode.Disposable {
	readonly id: string;
	private title: string;
	private readonly created: number;
	private updated: number;
	mode: PermissionMode;
	private messages: Message[];
	private items: TranscriptItem[];
	private todos: Todo[];
	private cost: number;
	private readonly roots: string[] | undefined;
	/** The error the last run stopped with, if any. */
	lastError: string | undefined;
	private readonly finished = new vscode.EventEmitter<void>();
	/** Fires when the agent stops working, finished or not. */
	readonly onDidFinish = this.finished.event;

	private readonly state = new SessionState();
	private turns: Turn[] = [];
	private readonly queue: { text: string; itemId: string }[] = [];
	private abort: AbortController | undefined;
	private readonly waiting = new Map<string, (value: unknown) => void>();
	private readonly allowRules: Rule[] = [];
	private readonly diffs = new Map<string, { path: string; before: string; after: string }>();
	private usage: Usage | undefined;
	private contextWindow = 200_000;
	private agent: Agent | undefined;
	private currentText: string | undefined;
	private currentThinking: string | undefined;
	private commandList: SlashCommandInfo[] = BUILTIN_COMMANDS;
	private project: Project | undefined;
	private readonly workspace: EditorWorkspace;
	private shell: Shell;
	private readonly ripgrep = findRipgrep();
	private started = false;

	private readonly emitter = new vscode.EventEmitter<HostMessage>();
	readonly onMessage = this.emitter.event;

	constructor(private readonly services: Services, data?: SessionData, options?: SessionOptions) {
		this.id = data?.id ?? randomUUID();
		this.title = data?.title ?? '';
		this.created = data?.created ?? Date.now();
		this.updated = data?.updated ?? Date.now();
		this.roots = data?.roots ?? options?.roots;
		this.mode = data?.mode ?? options?.mode ?? vscode.workspace.getConfiguration('nighthawk.agent').get<PermissionMode>('permissionMode', 'default');
		this.messages = data?.messages ?? [];
		this.todos = data?.todos ?? [];
		this.cost = data?.cost ?? 0;
		this.started = !!data?.messages.length;
		// A restored conversation cannot resume calls that were waiting.
		this.items = (data?.items ?? []).map(item => {
			if (item.kind === 'tool' && (item.status === 'running' || item.status === 'awaiting')) {
				return { ...item, status: 'error' as const, approval: undefined, summary: vscode.l10n.t('interrupted') };
			}
			if (item.kind === 'user') {
				return { ...item, canRewind: false, queued: false };
			}
			if (item.kind === 'plan' && item.status === 'awaiting') {
				return { ...item, status: 'rejected' as const };
			}
			return item;
		});
		this.workspace = new EditorWorkspace(locations(this.roots).roots);
		// Replaced by the detected shell before the first turn runs.
		this.shell = shellFromPath(process.platform === 'win32' ? 'powershell.exe' : '/bin/sh');
		this.refreshCommands();
	}

	dispose(): void {
		this.stop();
		this.state.dispose();
		this.emitter.dispose();
		this.finished.dispose();
	}

	get running(): boolean {
		return !!this.abort;
	}

	get isEmpty(): boolean {
		return !this.items.length;
	}

	private shellSetting(): string | undefined {
		return vscode.workspace.getConfiguration('nighthawk.agent').get<string>('shell') || undefined;
	}

	// --- view state

	transcript(): TranscriptItem[] {
		return this.items;
	}

	viewState(): ViewState {
		const choice = this.services.endpoints.current();
		const tokens = this.usage ? this.usage.inputTokens + this.usage.outputTokens : undefined;
		return {
			configured: !!choice,
			model: choice?.model,
			mode: this.mode,
			running: this.running,
			context: tokens !== undefined ? Math.min(1, tokens / this.contextWindow) : undefined,
			tokens,
			cost: this.cost || undefined,
			todos: this.todos,
			commands: this.commandList,
			queued: this.queue.length,
			title: this.title,
			sessionId: this.items.length ? this.id : undefined,
		};
	}

	postState(): void {
		this.emitter.fire({ type: 'state', state: this.viewState() });
	}

	private upsert(item: TranscriptItem): void {
		const index = this.items.findIndex(i => i.id === item.id);
		if (index >= 0) {
			this.items[index] = item;
		} else {
			this.items.push(item);
		}
		this.emitter.fire({ type: 'upsert', item });
	}

	private update<K extends TranscriptItem['kind']>(id: string, patch: Partial<Extract<TranscriptItem, { kind: K }>>): void {
		const item = this.items.find(i => i.id === id);
		if (item) {
			const next: TranscriptItem = Object.assign({}, item, patch);
			this.upsert(next);
		}
	}

	private append(id: string, field: 'text' | 'output', text: string): void {
		const item = this.items.find(i => i.id === id) as Record<string, unknown> | undefined;
		if (!item) {
			return;
		}
		let value = String(item[field] ?? '') + text;
		if (field === 'output' && value.length > 20_000) {
			value = value.slice(-20_000);
		}
		item[field] = value;
		this.emitter.fire({ type: 'append', id, field, text });
	}

	private notice(level: 'info' | 'warning' | 'error', text: string, actions?: { label: string; action: string }[]): void {
		this.upsert({ kind: 'notice', id: newId('n'), level, text, actions });
	}

	async refreshCommands(): Promise<void> {
		try {
			this.project = await loadProject(this.roots);
		} catch {
			return;
		}
		const builtin = new Set(BUILTIN_COMMANDS.map(c => c.name));
		this.commandList = [
			...BUILTIN_COMMANDS,
			...this.project.commands.filter(c => !builtin.has(c.name)).map(c => ({ name: c.name, description: c.description || vscode.l10n.t('Custom command ({0})', c.scope), hint: c.argumentHint })),
			...this.project.skills.filter(s => !builtin.has(s.name)).map(s => ({ name: s.name, description: `${vscode.l10n.t('Skill')}: ${s.description}` })),
		];
		this.postState();
	}

	// --- user actions

	async send(text: string): Promise<void> {
		const trimmed = text.trim();
		if (!trimmed) {
			return;
		}
		if (trimmed.startsWith('/') && !this.running) {
			const handled = await this.slashCommand(trimmed);
			if (handled !== false) {
				return;
			}
		}
		if (this.running) {
			const item = { kind: 'user' as const, id: newId('u'), text: trimmed, queued: true };
			this.upsert(item);
			this.queue.push({ text: trimmed, itemId: item.id });
			this.postState();
			return;
		}
		await this.startTurn(trimmed, trimmed);
	}

	/** Runs a prompt written by a command, showing `shown` in the transcript instead of the full prompt. */
	async sendTask(shown: string, prompt: string): Promise<void> {
		if (this.running) {
			this.stop();
		}
		await this.startTurn(shown, prompt);
	}

	/** Adds a user message and runs the agent. `shown` is what the transcript shows. */
	private async startTurn(shown: string, prompt: string): Promise<void> {
		const item = { kind: 'user' as const, id: newId('u'), text: shown, canRewind: true };
		this.turns.push({ itemId: item.id, messageIndex: this.messages.length, itemIndex: this.items.length, text: shown, files: new Map() });
		this.upsert(item);
		if (!this.title) {
			this.title = shown.replace(/\s+/g, ' ').slice(0, 80);
		}
		const content: Message['content'] = [{ type: 'text', text: prompt }];
		const attachments = await this.attachMentions(prompt);
		if (attachments) {
			content.push({ type: 'text', text: attachments });
		}
		this.project ??= await loadProject(this.roots);
		this.shell = await findShell(this.shellSetting());
		const hooks = new Hooks(this.project.hooks, this.shell, this.workspace.roots[0] ?? process.cwd(), this.id);
		if (!this.started && hooks.has('SessionStart')) {
			const outcome = await hooks.run('SessionStart', { source: 'startup' });
			if (outcome.context) {
				content.push({ type: 'text', text: `<session-start-hook>${outcome.context}</session-start-hook>` });
			}
		}
		if (hooks.has('UserPromptSubmit')) {
			const outcome = await hooks.run('UserPromptSubmit', { prompt });
			if (outcome.block) {
				this.notice('warning', vscode.l10n.t('A UserPromptSubmit hook blocked this message: {0}', outcome.block));
				return;
			}
			if (outcome.context) {
				content.push({ type: 'text', text: `<user-prompt-submit-hook>${outcome.context}</user-prompt-submit-hook>` });
			}
		}
		this.started = true;
		this.messages.push({ role: 'user', content });
		await this.run();
	}

	/** Turns @path mentions into attached file contents. */
	private async attachMentions(text: string): Promise<string | undefined> {
		const parts: string[] = [];
		const seen = new Set<string>();
		for (const match of text.matchAll(/(?:^|\s)@([^\s]+)/g)) {
			let ref = match[1].replace(/[.,;:!?)]+$/, '');
			let range: [number, number] | undefined;
			const lines = /#L(\d+)(?:-L?(\d+))?$/.exec(ref);
			if (lines) {
				ref = ref.slice(0, lines.index);
				range = [Number(lines[1]), Number(lines[2] ?? lines[1])];
			}
			const file = resolvePath(this.workspace, ref);
			if (seen.has(file + (range?.join('-') ?? ''))) {
				continue;
			}
			seen.add(file + (range?.join('-') ?? ''));
			const stat = await this.workspace.stat(file);
			if (!stat) {
				continue;
			}
			if (stat.isDirectory) {
				const entries = await this.workspace.readDir(file);
				parts.push(`<directory path="${file}">\n${entries.slice(0, 300).map(e => e.isDirectory ? `${e.name}/` : e.name).join('\n')}\n</directory>`);
				continue;
			}
			if (stat.size > 512 * 1024) {
				parts.push(`<file path="${file}">(too large to attach; use Read)</file>`);
				continue;
			}
			let content = await this.workspace.readText(file).catch(() => '');
			if (range) {
				content = content.split(/\r?\n/).slice(range[0] - 1, range[1]).join('\n');
			}
			parts.push(`<file path="${file}"${range ? ` lines="${range[0]}-${range[1]}"` : ''}>\n${content}\n</file>`);
		}
		return parts.length ? `The user attached:\n${parts.join('\n')}` : undefined;
	}

	/** Returns false when the text is not a command after all. */
	private async slashCommand(text: string): Promise<boolean | void> {
		const match = /^\/([\w:.-]+)\s*([\s\S]*)$/.exec(text);
		if (!match) {
			return false;
		}
		const [, name, args] = match;
		switch (name) {
			case 'clear':
			case 'new':
				return void vscode.commands.executeCommand('nighthawk.agent.newSession');
			case 'compact':
				return void this.compact(args);
			case 'init':
				return void this.startTurn('/init', INIT_PROMPT);
			case 'review':
				return void this.startTurn('/review', args ? `${REVIEW_PROMPT}\n\nFocus: ${args}` : REVIEW_PROMPT);
			case 'model':
				await this.services.endpoints.pickModel();
				return this.postState();
			case 'plan':
				this.setMode('plan');
				if (args.trim()) {
					await this.startTurn(text, args);
				}
				return;
			case 'memory':
				return void this.openMemory();
			case 'skills': {
				await this.refreshCommands();
				const skills = this.project?.skills ?? [];
				return this.notice('info', skills.length
					? `**${vscode.l10n.t('Skills')}**\n\n${skills.map(s => `- **${s.name}** (${s.scope}): ${s.description}`).join('\n')}`
					: vscode.l10n.t('No skills found. Add a folder with a SKILL.md to `.nighthawk/skills/` in the project or `~/.nighthawk/skills/` (`.claude/skills/` works too).'));
			}
			case 'agents': {
				await this.refreshCommands();
				const agents = this.project?.agents ?? [];
				return this.notice('info', `**${vscode.l10n.t('Sub-agents')}**\n\n${agents.map(a => `- **${a.name}** (${a.scope}): ${a.description}`).join('\n')}\n\n${vscode.l10n.t('Add your own as Markdown files in `.nighthawk/agents/` or `~/.nighthawk/agents/`.')}`);
			}
			case 'mcp':
				await this.services.mcp.ensureStarted();
				return this.notice('info', `**${vscode.l10n.t('MCP servers')}**\n\n${this.services.mcp.status()}`, [{ label: vscode.l10n.t('Restart Servers'), action: 'restartMcp' }]);
			case 'context': {
				const tokens = this.usage ? this.usage.inputTokens + this.usage.outputTokens : 0;
				return this.notice('info', tokens
					? vscode.l10n.t('{0} of {1} tokens used ({2}%). The conversation is compacted automatically near the limit, or run /compact.', tokens.toLocaleString(), this.contextWindow.toLocaleString(), Math.round(tokens / this.contextWindow * 100))
					: vscode.l10n.t('Nothing sent yet in this conversation.'));
			}
			case 'help':
				return this.notice('info', this.helpText());
		}
		this.project ??= await loadProject(this.roots);
		const command = this.project.commands.find(c => c.name === name);
		if (command) {
			return void this.startTurn(text, await expandCommand(command, args));
		}
		const skill = this.project.skills.find(s => s.name === name);
		if (skill) {
			return void this.startTurn(text, `Use the "${skill.name}" skill for this.${args.trim() ? `\n\n${args.trim()}` : ''}`);
		}
		return false;
	}

	private helpText(): string {
		return [
			`**${vscode.l10n.t('Nighthawk Agent')}**`,
			vscode.l10n.t('Ask for a change, a fix or an explanation. The agent reads and searches your code, edits files and runs commands, asking first where the mode says so.'),
			'',
			`- ${vscode.l10n.t('**Modes** (Shift+Tab): Ask before edits, Auto-accept edits, Plan, and Full auto.')}`,
			`- ${vscode.l10n.t('**@file** attaches a file; **/command** runs a command or skill.')}`,
			`- ${vscode.l10n.t('**Instructions**: AGENTS.md or CLAUDE.md in the project or ~/.nighthawk.')}`,
			`- ${vscode.l10n.t('**Skills**: .nighthawk/skills/<name>/SKILL.md. **Commands**: .nighthawk/commands/<name>.md. **Agents**: .nighthawk/agents/<name>.md. The .claude/ folders work too.')}`,
			`- ${vscode.l10n.t('**MCP servers**: .mcp.json, ~/.nighthawk/mcp.json or the nighthawk.agent.mcpServers setting.')}`,
			`- ${vscode.l10n.t('**Hooks and permission rules**: .nighthawk/settings.json, or the nighthawk.agent settings.')}`,
			'',
			`${vscode.l10n.t('Commands')}: ${this.commandList.map(c => `/${c.name}`).join(', ')}`,
		].join('\n');
	}

	private async openMemory(): Promise<void> {
		const root = this.workspace.roots[0];
		if (!root) {
			return this.notice('warning', vscode.l10n.t('Open a folder to give the agent project instructions.'));
		}
		let existing: string | undefined;
		for (const name of ['AGENTS.md', 'CLAUDE.md', 'NIGHTHAWK.md']) {
			if (!existing && await exists(path.join(root, name))) {
				existing = path.join(root, name);
			}
		}
		if (existing) {
			await vscode.window.showTextDocument(vscode.Uri.file(existing));
			return;
		}
		const create = vscode.l10n.t('Create AGENTS.md');
		const generate = vscode.l10n.t('Generate with /init');
		const answer = await vscode.window.showInformationMessage(vscode.l10n.t('This project has no AGENTS.md yet.'), create, generate);
		if (answer === create) {
			const file = vscode.Uri.file(path.join(root, 'AGENTS.md'));
			await vscode.workspace.fs.writeFile(file, new TextEncoder().encode('# Agent instructions\n\n'));
			await vscode.window.showTextDocument(file);
		} else if (answer === generate) {
			await this.startTurn('/init', INIT_PROMPT);
		}
	}

	setMode(mode: PermissionMode): void {
		this.mode = mode;
		this.postState();
	}

	stop(): void {
		this.abort?.abort();
		for (const resolve of this.waiting.values()) {
			resolve(undefined);
		}
		this.waiting.clear();
		// Queued messages go back to the input box.
		if (this.queue.length) {
			const text = this.queue.map(q => q.text).join('\n\n');
			for (const q of this.queue.splice(0)) {
				this.items = this.items.filter(i => i.id !== q.itemId);
			}
			this.emitter.fire({ type: 'items', items: this.items });
			this.emitter.fire({ type: 'prefill', text });
		}
	}

	resolveWaiting(id: string, value: unknown): void {
		const resolve = this.waiting.get(id);
		if (resolve) {
			this.waiting.delete(id);
			resolve(value);
		}
	}

	private wait<T>(id: string): Promise<T | undefined> {
		return new Promise(resolve => this.waiting.set(id, resolve as (value: unknown) => void));
	}

	diffFor(id: string): { path: string; before: string; after: string } | undefined {
		return this.diffs.get(id);
	}

	// --- running the agent

	private async model(ref?: string): Promise<{ stream: ModelStream; label: string; contextWindow: number } | undefined> {
		const choice = (ref && this.services.endpoints.resolve(ref)) || this.services.endpoints.current();
		if (!choice) {
			return undefined;
		}
		const config = vscode.workspace.getConfiguration('nighthawk.agent');
		const key = await this.services.endpoints.apiKey(choice.endpoint);
		const stream = modelStream(choice.endpoint, choice.model, key, { thinking: config.get<boolean>('thinking', true), effort: config.get<string>('effort') || undefined });
		return {
			stream: this.services.usage.track(stream, {
				endpoint: choice.endpoint,
				model: choice.model,
				feature: 'agent',
				session: () => ({ id: this.id, title: this.title }),
				onCost: cost => {
					this.cost += cost ?? 0;
					this.postState();
				},
			}),
			label: `${choice.model} (${choice.endpoint.name})`,
			contextWindow: guessContextWindow(choice.endpoint, choice.model),
		};
	}

	private tools(project: Project, mcpTools: Tool[]): Tool[] {
		const platform = process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'macOS' : 'Linux';
		const tools: Tool[] = [];
		for (const tool of BUILTIN_TOOLS) {
			const name = tool.spec.name;
			if (name === 'Skill' && !project.skills.length) {
				continue;
			}
			if (name === 'ExitPlanMode' && this.mode !== 'plan') {
				continue;
			}
			const description = name === 'Bash' ? bashDescription(this.shell, platform)
				: name === 'Task' ? taskDescription(project.agents)
					: name === 'Skill' ? skillDescription(project.skills)
						: tool.spec.description;
			tools.push({ ...tool, spec: { ...tool.spec, description } });
		}
		tools.push(diagnosticsTool(), ...mcpTools);
		return tools;
	}

	private async run(): Promise<void> {
		const model = await this.model();
		if (!model) {
			this.notice('warning', vscode.l10n.t('Connect a model to start: an Anthropic or OpenAI key, OpenRouter, a local Ollama or LM Studio, or any OpenAI-compatible endpoint.'), [{ label: vscode.l10n.t('Add Model Endpoint'), action: 'addEndpoint' }]);
			this.lastError = vscode.l10n.t('No model is connected.');
			this.finished.fire();
			return;
		}
		this.lastError = undefined;
		this.abort = new AbortController();
		const signal = this.abort.signal;
		this.postState();
		try {
			await this.services.mcp.ensureStarted();
			const project = this.project = await loadProject(this.roots);
			this.shell = await findShell(this.shellSetting());
			this.workspace.roots.splice(0, this.workspace.roots.length, ...locations(this.roots).roots);
			const tools = this.tools(project, this.services.mcp.tools());
			const hooks = new Hooks(project.hooks, this.shell, this.workspace.roots[0] ?? process.cwd(), this.id);
			const promptContext = {
				roots: this.workspace.roots,
				platform: `${process.platform} ${process.arch}`,
				shell: this.shell.name,
				date: new Date().toISOString().slice(0, 10),
				model: model.label,
				instructions: project.instructions,
				mode: this.mode,
				isGitRepo: !!this.workspace.roots[0] && await exists(path.join(this.workspace.roots[0], '.git')),
				custom: vscode.workspace.getConfiguration('nighthawk.agent').get<string>('systemPrompt'),
			};
			this.contextWindow = model.contextWindow;
			const config = vscode.workspace.getConfiguration('nighthawk.agent');
			const context: Omit<ToolContext, 'signal' | 'progress'> = {
				workspace: this.workspace,
				state: this.state,
				shell: this.shell,
				ripgrep: await this.ripgrep,
				beforeEdit: (file, previous) => this.recordEdit(file, previous),
				onTodos: todos => {
					this.todos = todos;
					this.postState();
				},
				ask: questions => this.ask(questions),
				approvePlan: plan => this.approvePlan(plan),
				skills: () => project.skills,
				readSkill: async name => {
					const skill = project.skills.find(s => s.name === name);
					return skill ? { body: await readSkillBody(skill), dir: skill.dir } : undefined;
				},
				runSubagent: (type, _description, prompt, callId, subSignal) => this.runSubagent({ type, prompt, callId, signal: subSignal, project, tools, hooks, promptContext, context }),
			};
			this.agent = new Agent({
				model: model.stream,
				tools,
				system: buildSystemPrompt(promptContext),
				contextWindow: model.contextWindow,
				compactAt: config.get<boolean>('autoCompact', true) ? 0.85 : 0,
				maxSteps: config.get<number>('maxSteps', 200),
				permission: (tool, input, callId, preview) => this.permission(tool, input, callId, preview, project),
				context,
				hooks,
				onEvent: event => this.onEvent(event),
				takeQueued: () => this.takeQueued(),
			});
			const result = await this.agent.run(this.messages, signal);
			if (result.stopReason === 'aborted') {
				this.notice('info', vscode.l10n.t('Stopped. Tell the agent what to do instead.'));
			}
		} catch (err) {
			if (!signal.aborted) {
				const message = String(err?.message ?? err);
				this.lastError = message;
				const actions = isBudgetError(err)
					? [{ label: vscode.l10n.t('Change Limit'), action: 'editLimit' }, { label: vscode.l10n.t('Allow This Month'), action: 'allowOverLimit' }, { label: vscode.l10n.t('Show Usage'), action: 'showUsage' }]
					: [{ label: vscode.l10n.t('Retry'), action: 'retry' }];
				if (/\b(401|403)\b|api key|unauthori[sz]ed|authentication/i.test(message)) {
					actions.push({ label: vscode.l10n.t('Set API Key'), action: 'setKey' });
				}
				this.notice('error', message, actions);
			}
		} finally {
			this.closeOpenBlocks();
			if (this.agent?.usage) {
				this.usage = this.agent.usage;
			}
			this.abort = undefined;
			this.agent = undefined;
			// Messages sent after the agent stopped run as a new turn.
			const leftover = this.takeQueued();
			this.postState();
			await this.save();
			if (leftover.length && !signal.aborted) {
				this.messages.push({ role: 'user', content: [{ type: 'text', text: leftover.join('\n\n') }] });
				await this.run();
			} else {
				this.finished.fire();
			}
		}
	}

	retry(): void {
		if (!this.running && this.messages.at(-1)?.role === 'user') {
			this.run();
		}
	}

	private takeQueued(): string[] {
		const taken = this.queue.splice(0);
		for (const q of taken) {
			this.update<'user'>(q.itemId, { queued: false });
		}
		if (taken.length) {
			this.postState();
		}
		return taken.map(q => q.text);
	}

	private closeOpenBlocks(): void {
		if (this.currentThinking) {
			this.update<'thinking'>(this.currentThinking, { done: true });
		}
		this.currentText = undefined;
		this.currentThinking = undefined;
	}

	private onEvent(event: AgentEvent): void {
		switch (event.type) {
			case 'text':
				if (this.currentThinking) {
					this.update<'thinking'>(this.currentThinking, { done: true });
					this.currentThinking = undefined;
				}
				if (!this.currentText) {
					this.currentText = newId('a');
					this.upsert({ kind: 'assistant', id: this.currentText, text: '' });
				}
				this.append(this.currentText, 'text', event.text);
				break;
			case 'thinking':
				if (!this.currentThinking) {
					this.currentThinking = newId('t');
					this.upsert({ kind: 'thinking', id: this.currentThinking, text: '' });
				}
				this.append(this.currentThinking, 'text', event.text);
				break;
			case 'response_end':
				this.closeOpenBlocks();
				break;
			case 'tool_call':
				this.closeOpenBlocks();
				this.upsert({ kind: 'tool', id: event.id, name: event.name, title: event.title, status: 'running', detail: describeInput(event.name, event.input) });
				break;
			case 'tool_progress':
				this.append(event.id, 'output', event.text);
				break;
			case 'tool_result':
				this.onToolResult(event.id, event.result, event.status);
				break;
			case 'usage':
				this.usage = event.usage;
				this.postState();
				break;
			case 'compacted':
				this.turns = [];
				this.items = this.items.map(i => i.kind === 'user' ? { ...i, canRewind: false } : i);
				this.emitter.fire({ type: 'items', items: this.items });
				this.upsert({ kind: 'compacted', id: newId('c'), summary: event.summary });
				this.usage = undefined;
				this.postState();
				break;
			case 'notice':
				this.notice(event.level, event.text);
				break;
		}
	}

	private onToolResult(id: string, result: ToolResult, status: 'done' | 'error' | 'denied'): void {
		const item = this.items.find(i => i.id === id);
		if (!item || item.kind !== 'tool') {
			return;
		}
		const display = this.keepDiff(id, result.display);
		this.upsert({
			...item,
			status,
			approval: undefined,
			summary: result.summary ?? (status === 'denied' ? vscode.l10n.t('declined') : status === 'error' ? vscode.l10n.t('failed') : undefined),
			display: display ?? (status === 'denied' ? undefined : item.display),
			output: display ? undefined : clip(result.content, 6000),
			canOpenDiff: this.diffs.has(id),
		});
	}

	/** Keeps full before/after texts here for the diff editor; the page gets the hunks. */
	private keepDiff(id: string, display: ToolDisplay | undefined): ToolDisplay | undefined {
		if (display?.kind !== 'diff') {
			return display;
		}
		const { before, after, ...rest } = display;
		if (before !== undefined && after !== undefined) {
			this.diffs.set(id, { path: display.path, before, after });
		}
		return rest;
	}

	private async permission(tool: Tool, input: Record<string, unknown>, callId: string, preview: ToolDisplay | undefined, project: Project): Promise<PermissionAnswer> {
		const decision = decide({ tool, input, mode: this.mode, allow: [...project.allow, ...this.allowRules], deny: project.deny, workspace: this.workspace });
		if (decision.behavior === 'allow') {
			return { allow: true };
		}
		if (decision.behavior === 'deny') {
			return { allow: false, reason: decision.reason };
		}
		const suggestion = suggestRule(tool, input);
		let outside = false;
		try {
			outside = (tool.paths?.(input, this.workspace) ?? []).some(p => !this.workspace.roots.some(r => p.startsWith(r)));
		} catch {
			// Ignore.
		}
		const display = this.keepDiff(callId, preview);
		this.update<'tool'>(callId, { status: 'awaiting', approval: { always: suggestion.label, outside }, display, canOpenDiff: this.diffs.has(callId) });
		if (!this.services.isVisible()) {
			this.services.reveal();
		}
		const answer = await this.wait<{ decision: 'allow' | 'always' | 'deny'; feedback?: string }>(callId);
		this.update<'tool'>(callId, { status: 'running', approval: undefined });
		if (!answer) {
			return { allow: false, reason: 'The user stopped the agent.', stop: true };
		}
		if (answer.decision === 'always') {
			const rule = parseRule(suggestion.rule);
			if (rule) {
				this.allowRules.push(rule);
			}
		}
		if (answer.decision === 'deny') {
			const feedback = answer.feedback?.trim();
			return feedback
				? { allow: false, reason: `The user declined this call and said: ${feedback}` }
				: { allow: false, reason: 'The user declined this call. Stop and wait for their instructions.', stop: true };
		}
		return { allow: true };
	}

	private async ask(questions: Question[]): Promise<string> {
		const id = newId('q');
		this.upsert({ kind: 'question', id, questions });
		if (!this.services.isVisible()) {
			this.services.reveal();
		}
		const answer = await this.wait<string>(id);
		this.update<'question'>(id, { answer: answer ?? vscode.l10n.t('(no answer)') });
		if (answer === undefined) {
			throw new Error('The user stopped the agent before answering.');
		}
		return answer;
	}

	private async approvePlan(plan: string): Promise<boolean> {
		const id = newId('p');
		this.upsert({ kind: 'plan', id, text: plan, status: 'awaiting' });
		const answer = await this.wait<{ approve: boolean; mode?: PermissionMode }>(id);
		const approved = !!answer?.approve;
		this.update<'plan'>(id, { status: approved ? 'approved' : 'rejected' });
		if (approved) {
			this.setMode(answer?.mode && answer.mode !== 'plan' ? answer.mode : 'default');
		}
		return approved;
	}

	private async runSubagent(options: {
		type: string; prompt: string; callId: string | undefined; signal: AbortSignal;
		project: Project; tools: Tool[]; hooks: Hooks;
		promptContext: Parameters<typeof buildSystemPrompt>[0];
		context: Omit<ToolContext, 'signal' | 'progress'>;
	}): Promise<string> {
		const { project, callId } = options;
		const definition = project.agents.find(a => a.name.toLowerCase() === options.type.toLowerCase()) ?? project.agents.find(a => a.name === 'general-purpose')!;
		const allowed = definition.tools ? new Set(definition.tools) : undefined;
		const tools = options.tools.filter(t => !SUBAGENT_EXCLUDED.has(t.spec.name)
			&& (!allowed || allowed.has(t.spec.name) || [...allowed].some(a => a.startsWith('mcp__') && t.spec.name.startsWith(a))));
		const model = (definition.model && await this.model(definition.model)) || await this.model();
		if (!model) {
			throw new Error('No model is configured.');
		}
		const state = new SessionState();
		let toolUses = 0;
		const agent = new Agent({
			model: model.stream,
			tools,
			system: buildSystemPrompt({ ...options.promptContext, model: model.label, subagentPrompt: definition.prompt }),
			contextWindow: model.contextWindow,
			compactAt: 0.85,
			maxSteps: 100,
			permission: (tool, input, id, preview) => this.permission(tool, input, id, preview, project),
			context: { ...options.context, state, onTodos: () => { }, runSubagent: undefined, ask: undefined, approvePlan: undefined },
			hooks: options.hooks,
			onEvent: event => {
				if (event.type === 'tool_call') {
					toolUses++;
					this.upsert({ kind: 'tool', id: event.id, name: event.name, title: event.title, status: 'running', detail: describeInput(event.name, event.input), parent: callId });
					if (callId) {
						this.update<'tool'>(callId, { summary: vscode.l10n.t('{0} tool uses', toolUses) });
					}
				} else if (event.type === 'tool_progress') {
					this.append(event.id, 'output', event.text);
				} else if (event.type === 'tool_result') {
					this.onToolResult(event.id, event.result, event.status);
				}
			},
		});
		try {
			const messages: Message[] = [{ role: 'user', content: [{ type: 'text', text: options.prompt }] }];
			const result = await agent.run(messages, options.signal);
			return result.text;
		} finally {
			state.dispose();
		}
	}

	private recordEdit(file: string, previous: string | undefined): void {
		const turn = this.turns.at(-1);
		if (turn && !turn.files.has(file)) {
			turn.files.set(file, previous);
		}
	}

	async compact(instructions?: string): Promise<void> {
		if (this.running || !this.messages.length) {
			return;
		}
		const model = await this.model();
		if (!model) {
			return;
		}
		this.abort = new AbortController();
		this.postState();
		const id = newId('n');
		this.upsert({ kind: 'notice', id, level: 'info', text: vscode.l10n.t('Compacting the conversation...') });
		try {
			const agent = new Agent({
				model: model.stream, tools: [], system: 'You summarize coding conversations.', contextWindow: model.contextWindow, compactAt: 0, maxSteps: 1,
				permission: async () => ({ allow: false, reason: 'No tools.' }),
				context: { workspace: this.workspace, state: this.state, shell: this.shell, beforeEdit: () => { }, onTodos: () => { } },
				onEvent: event => this.onEvent(event),
			});
			// Tool calls in the history need their tools declared to some APIs, so keep text only.
			const plain: Message[] = this.messages.map(m => ({
				role: m.role,
				content: m.content.flatMap(p => p.type === 'text' ? [p] : p.type === 'tool_use' ? [{ type: 'text' as const, text: `[called ${p.name} ${JSON.stringify(p.input).slice(0, 500)}]` }] : p.type === 'tool_result' ? [{ type: 'text' as const, text: `[result: ${p.content.slice(0, 2000)}]` }] : []),
			})).filter(m => m.content.length);
			await agent.compact(plain, this.abort.signal, instructions);
			this.messages = plain;
			this.items = this.items.filter(i => i.id !== id);
			this.emitter.fire({ type: 'items', items: this.items });
		} catch (err) {
			this.update<'notice'>(id, { level: 'error', text: String(err?.message ?? err) });
		} finally {
			this.abort = undefined;
			this.postState();
			await this.save();
		}
	}

	/** Restores files changed since a message and removes it and everything after. */
	async rewind(itemId: string): Promise<void> {
		if (this.running) {
			return;
		}
		const index = this.turns.findIndex(t => t.itemId === itemId);
		if (index < 0) {
			return;
		}
		const changed = new Set<string>();
		for (const turn of this.turns.slice(index)) {
			turn.files.forEach((_, file) => changed.add(file));
		}
		const both = vscode.l10n.t('Restore Code and Conversation');
		const conversation = vscode.l10n.t('Conversation Only');
		const detail = changed.size
			? vscode.l10n.t('{0} file(s) were changed since then: {1}', changed.size, [...changed].map(f => displayPath(this.workspace, f)).slice(0, 8).join(', '))
			: vscode.l10n.t('No files were changed since then.');
		const answer = await vscode.window.showWarningMessage(vscode.l10n.t('Go back to before this message?'), { modal: true, detail }, ...(changed.size ? [both, conversation] : [conversation]));
		if (!answer) {
			return;
		}
		if (answer === both) {
			for (const turn of this.turns.slice(index).reverse()) {
				for (const [file, previous] of turn.files) {
					try {
						if (previous === undefined) {
							await this.workspace.delete(file);
						} else {
							await this.workspace.writeText(file, previous);
						}
					} catch (err) {
						this.notice('error', vscode.l10n.t('Could not restore {0}: {1}', file, err.message));
					}
				}
			}
		}
		const turn = this.turns[index];
		this.messages.length = turn.messageIndex;
		this.items = this.items.slice(0, turn.itemIndex);
		this.turns = this.turns.slice(0, index);
		this.state.readFiles.clear();
		this.usage = undefined;
		this.emitter.fire({ type: 'items', items: this.items });
		this.emitter.fire({ type: 'prefill', text: turn.text });
		this.postState();
		await this.save();
	}

	// --- persistence

	toData(): SessionData {
		return { id: this.id, title: this.title, created: this.created, updated: this.updated, mode: this.mode, messages: this.messages, items: this.items, todos: this.todos, cost: this.cost, roots: this.roots };
	}

	private async save(): Promise<void> {
		if (!this.items.length) {
			return;
		}
		this.updated = Date.now();
		try {
			await this.services.store.save(this.toData());
		} catch {
			// Saving history must never break the conversation.
		}
	}
}

/** Conversations, one JSON file each, kept per workspace. */
export class SessionStore {
	private readonly dir: vscode.Uri;
	private pruned = false;

	constructor(storage: vscode.Uri, workspaceKey: string) {
		this.dir = vscode.Uri.joinPath(storage, 'sessions', workspaceKey);
	}

	private file(id: string): vscode.Uri {
		return vscode.Uri.joinPath(this.dir, `${id.replace(/[^\w-]/g, '')}.json`);
	}

	async save(data: SessionData): Promise<void> {
		await vscode.workspace.fs.createDirectory(this.dir);
		await vscode.workspace.fs.writeFile(this.file(data.id), new TextEncoder().encode(JSON.stringify(data)));
		if (!this.pruned) {
			this.pruned = true;
			await this.prune();
		}
	}

	async load(id: string): Promise<SessionData | undefined> {
		try {
			return JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(this.file(id))));
		} catch {
			return undefined;
		}
	}

	async delete(id: string): Promise<void> {
		await vscode.workspace.fs.delete(this.file(id)).then(undefined, () => undefined);
	}

	async list(): Promise<{ id: string; title: string; updated: number }[]> {
		let entries: [string, vscode.FileType][];
		try {
			entries = await vscode.workspace.fs.readDirectory(this.dir);
		} catch {
			return [];
		}
		const sessions = await Promise.all(entries.filter(([name]) => name.endsWith('.json')).map(async ([name]) => {
			const data = await this.load(name.slice(0, -5));
			return data ? { id: data.id, title: data.title || 'Untitled', updated: data.updated } : undefined;
		}));
		return sessions.filter((s): s is { id: string; title: string; updated: number } => !!s).sort((a, b) => b.updated - a.updated);
	}

	/** Keeps the 100 most recent conversations. */
	private async prune(): Promise<void> {
		const sessions = await this.list();
		for (const old of sessions.slice(100)) {
			await this.delete(old.id);
		}
	}
}

async function exists(file: string): Promise<boolean> {
	try {
		await access(file);
		return true;
	} catch {
		return false;
	}
}
