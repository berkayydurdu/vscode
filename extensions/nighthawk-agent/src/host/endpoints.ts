/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { listModels, PRESETS, type Preset } from '../core/providers';
import type { Endpoint, ProviderKind } from '../core/types';

const KEY_PREFIX = 'nighthawk.ai.key/';

export interface ModelChoice {
	endpoint: Endpoint;
	model: string;
}

/**
 * Model endpoints live in the `nighthawk.ai.endpoints` setting; their API
 * keys live in the OS keychain through SecretStorage, never in settings.
 */
export class Endpoints implements vscode.Disposable {
	private readonly changed = new vscode.EventEmitter<void>();
	readonly onDidChange = this.changed.event;
	private readonly disposables: vscode.Disposable[] = [];

	constructor(private readonly context: vscode.ExtensionContext) {
		this.disposables.push(
			this.changed,
			vscode.workspace.onDidChangeConfiguration(e => {
				if (e.affectsConfiguration('nighthawk.ai')) {
					this.changed.fire();
				}
			}),
			context.secrets.onDidChange(e => {
				if (e.key.startsWith(KEY_PREFIX)) {
					this.changed.fire();
				}
			}),
		);
	}

	dispose(): void {
		this.disposables.forEach(d => d.dispose());
	}

	list(): Endpoint[] {
		const raw = vscode.workspace.getConfiguration('nighthawk.ai').get<unknown[]>('endpoints') ?? [];
		const result: Endpoint[] = [];
		for (const item of raw) {
			if (!item || typeof item !== 'object') {
				continue;
			}
			const e = item as Record<string, unknown>;
			if (typeof e.name !== 'string' || typeof e.baseUrl !== 'string') {
				continue;
			}
			result.push({
				name: e.name,
				provider: e.provider === 'anthropic' ? 'anthropic' : 'openai',
				baseUrl: e.baseUrl,
				models: Array.isArray(e.models) ? e.models.map(String) : [],
				contextWindow: typeof e.contextWindow === 'number' ? e.contextWindow : undefined,
				maxOutputTokens: typeof e.maxOutputTokens === 'number' ? e.maxOutputTokens : undefined,
				headers: e.headers && typeof e.headers === 'object' ? e.headers as Record<string, string> : undefined,
			});
		}
		return result;
	}

	/** The model in `nighthawk.ai.model` ("Endpoint/model"), else the first one configured. */
	current(): ModelChoice | undefined {
		const endpoints = this.list();
		const setting = vscode.workspace.getConfiguration('nighthawk.ai').get<string>('model') ?? '';
		const found = this.resolve(setting);
		if (found) {
			return found;
		}
		const first = endpoints.find(e => e.models.length);
		return first ? { endpoint: first, model: first.models[0] } : undefined;
	}

	/** Finds "Endpoint/model", or a bare model id on any endpoint. */
	resolve(ref: string): ModelChoice | undefined {
		if (!ref) {
			return undefined;
		}
		const endpoints = this.list();
		const slash = ref.indexOf('/');
		if (slash > 0) {
			const endpoint = endpoints.find(e => e.name === ref.slice(0, slash));
			if (endpoint) {
				return { endpoint, model: ref.slice(slash + 1) };
			}
		}
		const endpoint = endpoints.find(e => e.models.includes(ref));
		return endpoint ? { endpoint, model: ref } : undefined;
	}

	async apiKey(endpoint: Endpoint): Promise<string | undefined> {
		const stored = await this.context.secrets.get(KEY_PREFIX + endpoint.name);
		if (stored) {
			return stored;
		}
		// Fall back to the usual environment variables, but only for the
		// provider's own host, so a key never goes to a look-alike URL.
		const host = httpsHost(endpoint.baseUrl);
		if (endpoint.provider === 'anthropic' && host === 'api.anthropic.com') {
			return process.env.ANTHROPIC_API_KEY;
		}
		if (host === 'api.openai.com') {
			return process.env.OPENAI_API_KEY;
		}
		if (host === 'openrouter.ai') {
			return process.env.OPENROUTER_API_KEY;
		}
		return undefined;
	}

	private async save(endpoints: Endpoint[]): Promise<void> {
		const plain = endpoints.map(e => {
			const entry: Record<string, unknown> = { name: e.name, provider: e.provider, baseUrl: e.baseUrl, models: e.models };
			if (e.contextWindow) {
				entry.contextWindow = e.contextWindow;
			}
			if (e.maxOutputTokens) {
				entry.maxOutputTokens = e.maxOutputTokens;
			}
			if (e.headers) {
				entry.headers = e.headers;
			}
			return entry;
		});
		await vscode.workspace.getConfiguration('nighthawk.ai').update('endpoints', plain, vscode.ConfigurationTarget.Global);
	}

	async setModel(endpoint: Endpoint, model: string): Promise<void> {
		await vscode.workspace.getConfiguration('nighthawk.ai').update('model', `${endpoint.name}/${model}`, vscode.ConfigurationTarget.Global);
	}

	/** Walks the user through adding an endpoint: provider, URL, key, models. */
	async add(): Promise<Endpoint | undefined> {
		const pick = await vscode.window.showQuickPick(PRESETS.map(p => ({
			label: p.label,
			description: p.baseUrl || undefined,
			detail: p.provider === 'anthropic' ? vscode.l10n.t('Anthropic Messages API') : vscode.l10n.t('OpenAI-compatible chat completions'),
			preset: p,
		})), { title: vscode.l10n.t('Add a Model Endpoint'), placeHolder: vscode.l10n.t('Where should Nighthawk send requests?'), matchOnDescription: true });
		if (!pick) {
			return undefined;
		}
		const preset: Preset = pick.preset;
		const existing = this.list();
		const defaultName = preset.id.startsWith('custom') ? '' : preset.label.replace(/\s*\(.*\)$/, '');
		let name = defaultName;
		if (!name || existing.some(e => e.name === name)) {
			const input = await vscode.window.showInputBox({
				title: vscode.l10n.t('Endpoint Name'),
				prompt: vscode.l10n.t('A short name, shown in the model picker.'),
				value: name && existing.some(e => e.name === name) ? `${name} 2` : name,
				validateInput: value => !value.trim() ? vscode.l10n.t('Enter a name.')
					: value.includes('/') ? vscode.l10n.t('The name cannot contain "/".')
						: existing.some(e => e.name === value.trim()) ? vscode.l10n.t('An endpoint with this name already exists.') : undefined,
			});
			if (!input) {
				return undefined;
			}
			name = input.trim();
		}
		let baseUrl = preset.baseUrl;
		if (!baseUrl || preset.id === 'ollama' || preset.id === 'lmstudio') {
			const input = await vscode.window.showInputBox({
				title: vscode.l10n.t('Base URL'),
				prompt: preset.provider === 'anthropic'
					? vscode.l10n.t('The URL that serves /v1/messages, e.g. https://gateway.example.com')
					: vscode.l10n.t('The URL that serves /chat/completions, usually ending in /v1'),
				value: baseUrl || (preset.provider === 'anthropic' ? 'https://' : 'http://localhost:8000/v1'),
				validateInput: value => {
					try {
						const url = new URL(value);
						return url.protocol === 'http:' || url.protocol === 'https:' ? undefined : vscode.l10n.t('Use an http or https URL.');
					} catch {
						return vscode.l10n.t('Enter a valid URL.');
					}
				},
			});
			if (!input) {
				return undefined;
			}
			baseUrl = input.trim();
		}
		const endpoint: Endpoint = { name, provider: preset.provider as ProviderKind, baseUrl, models: [] };
		const key = await this.askForKey(endpoint, preset);
		if (key === undefined) {
			return undefined;
		}
		if (key) {
			await this.context.secrets.store(KEY_PREFIX + name, key);
		}
		endpoint.models = await this.chooseModels(endpoint, key || undefined, preset.models);
		if (!endpoint.models.length) {
			return undefined;
		}
		await this.save([...existing, endpoint]);
		if (!this.current() || existing.length === 0) {
			await this.setModel(endpoint, endpoint.models[0]);
		}
		vscode.window.showInformationMessage(vscode.l10n.t('Added {0} with {1} model(s).', name, endpoint.models.length));
		return endpoint;
	}

	/** Returns '' to skip, undefined to cancel. */
	private async askForKey(endpoint: Endpoint, preset?: Preset): Promise<string | undefined> {
		const optional = preset ? !preset.needsKey : true;
		const result = await vscode.window.showInputBox({
			title: vscode.l10n.t('API Key for {0}', endpoint.name),
			prompt: optional
				? vscode.l10n.t('Leave empty if this endpoint needs no key. Keys are kept in your OS keychain.')
				: preset?.keyUrl ? vscode.l10n.t('Create one at {0}. Keys are kept in your OS keychain.', preset.keyUrl) : vscode.l10n.t('Keys are kept in your OS keychain.'),
			password: true,
			ignoreFocusOut: true,
			validateInput: value => !optional && !value.trim() ? vscode.l10n.t('This endpoint needs an API key.') : undefined,
		});
		return result === undefined ? undefined : result.trim();
	}

	private async chooseModels(endpoint: Endpoint, key: string | undefined, defaults: string[]): Promise<string[]> {
		let available: string[] = [];
		let error: string | undefined;
		await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Connecting to {0}...', endpoint.name) }, async () => {
			try {
				available = await listModels(endpoint, key, AbortSignal.timeout(15_000));
			} catch (err) {
				error = err.message;
			}
		});
		if (available.length) {
			const preferred = new Set(defaults.length ? defaults.filter(d => available.includes(d)) : available.slice(0, 1));
			if (!preferred.size) {
				preferred.add(available[0]);
			}
			const items = [...new Set([...defaults.filter(d => available.includes(d)), ...available])].map(id => ({ label: id, picked: preferred.has(id) }));
			const picked = await vscode.window.showQuickPick(items, {
				title: vscode.l10n.t('Models to Use from {0}', endpoint.name),
				placeHolder: vscode.l10n.t('Pick the models to show in the model picker'),
				canPickMany: true,
				ignoreFocusOut: true,
			});
			return picked?.map(p => p.label) ?? [];
		}
		const input = await vscode.window.showInputBox({
			title: vscode.l10n.t('Model IDs'),
			prompt: error
				? vscode.l10n.t('Could not list models ({0}). Enter model IDs separated by commas.', error.slice(0, 200))
				: vscode.l10n.t('Enter model IDs separated by commas.'),
			value: defaults.join(', '),
			ignoreFocusOut: true,
			validateInput: value => value.split(',').some(s => s.trim()) ? undefined : vscode.l10n.t('Enter at least one model ID.'),
		});
		return input ? input.split(',').map(s => s.trim()).filter(Boolean) : [];
	}

	async pickModel(): Promise<ModelChoice | undefined> {
		const endpoints = this.list();
		if (!endpoints.length) {
			const add = vscode.l10n.t('Add Endpoint');
			if (await vscode.window.showInformationMessage(vscode.l10n.t('No model endpoints are set up yet.'), add) === add) {
				await this.add();
			}
			return this.current();
		}
		const current = this.current();
		type Item = vscode.QuickPickItem & { choice?: ModelChoice; action?: 'add' | 'manage' };
		const items: Item[] = [];
		for (const endpoint of endpoints) {
			items.push({ label: endpoint.name, kind: vscode.QuickPickItemKind.Separator });
			for (const model of endpoint.models) {
				const active = current?.endpoint.name === endpoint.name && current.model === model;
				items.push({ label: model, description: active ? vscode.l10n.t('current') : undefined, iconPath: active ? new vscode.ThemeIcon('check') : undefined, choice: { endpoint, model } });
			}
		}
		items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
		items.push({ label: `$(add) ${vscode.l10n.t('Add Model Endpoint...')}`, action: 'add' });
		items.push({ label: `$(gear) ${vscode.l10n.t('Manage Endpoints...')}`, action: 'manage' });
		const pick = await vscode.window.showQuickPick(items, { title: vscode.l10n.t('Select a Model'), matchOnDescription: true });
		if (pick?.action === 'add') {
			await this.add();
			return this.current();
		}
		if (pick?.action === 'manage') {
			await this.manage();
			return this.current();
		}
		if (pick?.choice) {
			await this.setModel(pick.choice.endpoint, pick.choice.model);
			return pick.choice;
		}
		return undefined;
	}

	async manage(): Promise<void> {
		const endpoints = this.list();
		const pick = await vscode.window.showQuickPick([
			...endpoints.map(e => ({ label: e.name, description: e.baseUrl, detail: e.models.join(', '), endpoint: e })),
			{ label: `$(add) ${vscode.l10n.t('Add Model Endpoint...')}`, endpoint: undefined },
		], { title: vscode.l10n.t('Model Endpoints') });
		if (!pick) {
			return;
		}
		if (!pick.endpoint) {
			await this.add();
			return;
		}
		const endpoint = pick.endpoint;
		const actions = {
			key: vscode.l10n.t('Set API Key'),
			models: vscode.l10n.t('Choose Models'),
			settings: vscode.l10n.t('Edit in Settings (JSON)'),
			remove: vscode.l10n.t('Remove'),
		};
		const action = await vscode.window.showQuickPick(Object.values(actions), { title: endpoint.name });
		if (action === actions.key) {
			await this.setKey(endpoint);
		} else if (action === actions.models) {
			const models = await this.chooseModels(endpoint, await this.apiKey(endpoint), endpoint.models);
			if (models.length) {
				await this.save(this.list().map(e => e.name === endpoint.name ? { ...e, models } : e));
			}
		} else if (action === actions.settings) {
			await vscode.commands.executeCommand('workbench.action.openSettingsJson', { revealSetting: { key: 'nighthawk.ai.endpoints' } });
		} else if (action === actions.remove) {
			await this.remove(endpoint);
		}
	}

	async setKey(endpoint?: Endpoint): Promise<void> {
		const target = endpoint ?? (await vscode.window.showQuickPick(this.list().map(e => ({ label: e.name, endpoint: e })), { title: vscode.l10n.t('Set API Key') }))?.endpoint;
		if (!target) {
			return;
		}
		const key = await this.askForKey(target, PRESETS.find(p => p.baseUrl && p.baseUrl === target.baseUrl));
		if (key === undefined) {
			return;
		}
		if (key) {
			await this.context.secrets.store(KEY_PREFIX + target.name, key);
		} else {
			await this.context.secrets.delete(KEY_PREFIX + target.name);
		}
		vscode.window.showInformationMessage(vscode.l10n.t('Saved the API key for {0}.', target.name));
	}

	async remove(endpoint?: Endpoint): Promise<void> {
		const target = endpoint ?? (await vscode.window.showQuickPick(this.list().map(e => ({ label: e.name, endpoint: e })), { title: vscode.l10n.t('Remove Model Endpoint') }))?.endpoint;
		if (!target) {
			return;
		}
		const remove = vscode.l10n.t('Remove');
		if (await vscode.window.showWarningMessage(vscode.l10n.t('Remove {0} and its API key?', target.name), { modal: true }, remove) !== remove) {
			return;
		}
		await this.context.secrets.delete(KEY_PREFIX + target.name);
		await this.save(this.list().filter(e => e.name !== target.name));
	}
}

function httpsHost(url: string): string | undefined {
	try {
		const parsed = new URL(url);
		return parsed.protocol === 'https:' ? parsed.hostname.toLowerCase() : undefined;
	} catch {
		return undefined;
	}
}
