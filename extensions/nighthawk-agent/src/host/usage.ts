/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { appendFile, mkdir } from 'node:fs/promises';
import * as vscode from 'vscode';
import { ProviderError, type Endpoint, type ModelStream, type Usage } from '../core/types';
import { budgetState, costOf, findPrice, formatCost, monthKey, summarize, type Price, type UsageFeature, type UsageRecord, type UsageSummary } from '../core/usage';

export interface TrackInfo {
	endpoint: Endpoint;
	model: string;
	feature: UsageFeature;
	/** The agent conversation the request belongs to, read when the request ends. */
	session?: () => { id: string; title: string };
	/** Called with the cost of each finished request; undefined when the price is unknown. */
	onCost?: (cost: number | undefined) => void;
}

const BUDGET_ERROR = 'nighthawk-monthly-limit';

/** True for the error a request fails with when the monthly limit is reached. */
export function isBudgetError(err: unknown): boolean {
	return err instanceof ProviderError && err.name === BUDGET_ERROR;
}

/**
 * Records the tokens and cost of every model request in a log per month,
 * shows this month's spending in the status bar and enforces the optional
 * monthly limit.
 */
export class UsageMeter implements vscode.Disposable {
	private readonly dir: vscode.Uri;
	private month = monthKey(Date.now());
	private records: UsageRecord[] = [];
	private readonly loaded: Promise<void>;
	private writing = Promise.resolve();
	private readonly item = vscode.window.createStatusBarItem('nighthawk.ai.usage', vscode.StatusBarAlignment.Right, 99);
	private readonly emitter = new vscode.EventEmitter<void>();
	readonly onDidChange = this.emitter.event;
	private readonly disposables: vscode.Disposable[] = [this.item, this.emitter];

	constructor(private readonly context: vscode.ExtensionContext, private readonly hasModel: () => boolean) {
		this.dir = vscode.Uri.joinPath(context.globalStorageUri, 'usage');
		this.item.name = vscode.l10n.t('AI Usage');
		this.item.command = 'nighthawk.ai.showUsage';
		this.loaded = this.load(this.month).then(records => { this.records = records; this.update(); });
		this.disposables.push(vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('nighthawk.ai')) {
				this.update();
			}
		}));
	}

	dispose(): void {
		this.disposables.forEach(d => d.dispose());
	}

	private file(month: string): vscode.Uri {
		return vscode.Uri.joinPath(this.dir, `${month}.jsonl`);
	}

	private async load(month: string): Promise<UsageRecord[]> {
		try {
			const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(this.file(month)));
			return text.split('\n').filter(Boolean).flatMap(line => {
				try {
					return [JSON.parse(line) as UsageRecord];
				} catch {
					return []; // A line cut short by a crash.
				}
			});
		} catch {
			return [];
		}
	}

	/** Months that have a usage log, newest first, always including this month. */
	async months(): Promise<string[]> {
		let names: string[] = [];
		try {
			names = (await vscode.workspace.fs.readDirectory(this.dir)).map(([name]) => name).filter(name => /^\d{4}-\d{2}\.jsonl$/.test(name)).map(name => name.slice(0, 7));
		} catch {
			// No usage yet.
		}
		return [...new Set([monthKey(Date.now()), ...names])].sort().reverse();
	}

	async summary(month = monthKey(Date.now())): Promise<UsageSummary> {
		await this.loaded;
		this.rollOver();
		return summarize(month === this.month ? this.records : await this.load(month), month);
	}

	limit(): number {
		return Math.max(0, vscode.workspace.getConfiguration('nighthawk.ai').get<number>('monthlyLimit', 0) || 0);
	}

	private prices(): Record<string, Price> {
		return vscode.workspace.getConfiguration('nighthawk.ai').get<Record<string, Price>>('prices') ?? {};
	}

	priceOf(endpoint: Endpoint, model: string): Price | undefined {
		return findPrice(model, endpoint.baseUrl, this.prices());
	}

	/** This month's spending so far. */
	spent(): number {
		this.rollOver();
		return this.records.reduce((sum, r) => sum + (r.cost ?? 0), 0);
	}

	private rollOver(): void {
		const now = monthKey(Date.now());
		if (now !== this.month) {
			this.month = now;
			this.records = [];
		}
	}

	isAllowedOver(): boolean {
		return this.allowedOver();
	}

	private allowedOver(): boolean {
		return this.context.globalState.get<string>('nighthawk.usage.allowOver') === this.month;
	}

	/** Wraps a model stream so each finished request is recorded and the monthly limit is checked first. */
	track(stream: ModelStream, info: TrackInfo): ModelStream {
		const before = async () => {
			await this.loaded;
			this.checkLimit();
		};
		const record = (usage: Usage) => this.record(info, usage);
		return async function* (request, signal) {
			await before();
			for await (const event of stream(request, signal)) {
				if (event.type === 'done') {
					info.onCost?.(record(event.usage));
				}
				yield event;
			}
		};
	}

	private checkLimit(): void {
		const limit = this.limit();
		const spent = this.spent();
		if (budgetState(spent, limit) === 'over' && !this.allowedOver()) {
			const error = new ProviderError(vscode.l10n.t('You reached your monthly AI limit: {0} of {1} spent this month. Raise the limit or allow more spending this month to continue.', formatCost(spent), formatCost(limit)));
			error.name = BUDGET_ERROR;
			throw error;
		}
	}

	private record(info: TrackInfo, usage: Usage): number | undefined {
		this.rollOver();
		const before = this.spent();
		const session = info.session?.();
		const record: UsageRecord = {
			time: Date.now(),
			endpoint: info.endpoint.name,
			model: info.model,
			feature: info.feature,
			session: session?.id,
			title: session?.title || undefined,
			input: usage.inputTokens,
			output: usage.outputTokens,
			cacheRead: usage.cacheReadTokens ?? 0,
			cacheWrite: usage.cacheWriteTokens ?? 0,
			cost: costOf(usage, this.priceOf(info.endpoint, info.model)),
		};
		this.records.push(record);
		const line = `${JSON.stringify(record)}\n`;
		const month = this.month;
		this.writing = this.writing.then(async () => {
			await mkdir(this.dir.fsPath, { recursive: true });
			await appendFile(this.file(month).fsPath, line);
		}).catch(() => undefined);
		this.update();
		this.emitter.fire();
		this.warnOnLimit(before, this.spent());
		return record.cost;
	}

	/** Offers to raise the limit after a request failed because the monthly limit was reached. */
	async offerToRaiseLimit(err: Error): Promise<void> {
		const change = vscode.l10n.t('Change Limit');
		const allow = vscode.l10n.t('Allow This Month');
		const pick = await vscode.window.showWarningMessage(err.message, change, allow);
		if (pick === change) {
			await this.editLimit();
		} else if (pick === allow) {
			await this.allowThisMonth();
		}
	}

	private async warnOnLimit(before: number, after: number): Promise<void> {
		const limit = this.limit();
		const was = budgetState(before, limit);
		const now = budgetState(after, limit);
		if (was === now || now === 'ok' || now === 'none') {
			return;
		}
		const show = vscode.l10n.t('Show Usage');
		const raise = vscode.l10n.t('Change Limit');
		if (now === 'near') {
			const pick = await vscode.window.showInformationMessage(vscode.l10n.t('You have used {0} of your {1} monthly AI limit.', formatCost(after), formatCost(limit)), show, raise);
			return this.onPick(pick, show, raise);
		}
		const allow = vscode.l10n.t('Allow This Month');
		const pick = await vscode.window.showWarningMessage(vscode.l10n.t('You reached your monthly AI limit of {0}. New AI requests stop until next month unless you raise the limit or allow more this month.', formatCost(limit)), raise, allow, show);
		if (pick === allow) {
			await this.allowThisMonth();
		}
		return this.onPick(pick, show, raise);
	}

	private async onPick(pick: string | undefined, show: string, raise: string): Promise<void> {
		if (pick === show) {
			await vscode.commands.executeCommand('nighthawk.ai.showUsage');
		} else if (pick === raise) {
			await this.editLimit();
		}
	}

	async allowThisMonth(): Promise<void> {
		await this.context.globalState.update('nighthawk.usage.allowOver', this.month);
		this.update();
	}

	/** Asks for a new monthly limit in US dollars; empty or 0 turns it off. */
	async editLimit(): Promise<void> {
		const current = this.limit();
		const value = await vscode.window.showInputBox({
			title: vscode.l10n.t('Monthly AI Limit'),
			prompt: vscode.l10n.t('AI requests stop when this month\'s spending reaches this amount in US dollars. Leave empty or enter 0 for no limit.'),
			value: current ? String(current) : '',
			placeHolder: '20',
			validateInput: text => !text.trim() || /^\d+(\.\d{1,2})?$/.test(text.trim()) ? undefined : vscode.l10n.t('Enter an amount such as 20 or 12.50.'),
		});
		if (value === undefined) {
			return;
		}
		await vscode.workspace.getConfiguration('nighthawk.ai').update('monthlyLimit', Number(value.trim() || 0), vscode.ConfigurationTarget.Global);
	}

	/** Asks for a model's price per million tokens and saves it in `nighthawk.ai.prices`. */
	async editPrice(model: string): Promise<void> {
		const prices = this.prices();
		const current = prices[model];
		const ask = (prompt: string, value: number | undefined) => vscode.window.showInputBox({
			title: vscode.l10n.t('Price of {0}', model),
			prompt,
			value: value !== undefined ? String(value) : '',
			validateInput: text => /^\d+(\.\d+)?$/.test(text.trim()) ? undefined : vscode.l10n.t('Enter a number such as 3 or 0.25.'),
		});
		const input = await ask(vscode.l10n.t('US dollars per million input tokens'), current?.input);
		if (input === undefined) {
			return;
		}
		const output = await ask(vscode.l10n.t('US dollars per million output tokens'), current?.output);
		if (output === undefined) {
			return;
		}
		await vscode.workspace.getConfiguration('nighthawk.ai').update('prices', { ...prices, [model]: { ...current, input: Number(input), output: Number(output) } }, vscode.ConfigurationTarget.Global);
	}

	private update(): void {
		this.rollOver();
		const spent = this.spent();
		const limit = this.limit();
		const state = budgetState(spent, limit);
		if (!this.records.length && !limit && !this.hasModel()) {
			this.item.hide();
			return;
		}
		this.item.text = limit ? `$(pulse) ${formatCost(spent)} / ${formatCost(limit)}` : `$(pulse) ${formatCost(spent)}`;
		this.item.backgroundColor = state === 'over' && !this.allowedOver() ? new vscode.ThemeColor('statusBarItem.errorBackground') : state === 'near' || state === 'over' ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
		const summary = summarize(this.records, this.month);
		const tooltip = new vscode.MarkdownString(undefined, true);
		tooltip.appendMarkdown(`**${vscode.l10n.t('AI spending this month')}**: ${formatCost(spent)}`);
		if (limit) {
			tooltip.appendMarkdown(` ${vscode.l10n.t('of {0} ({1}%)', formatCost(limit), Math.round(spent / limit * 100))}`);
		}
		tooltip.appendMarkdown('\n\n');
		for (const model of summary.byModel.slice(0, 4)) {
			tooltip.appendMarkdown(`- ${model.label}: ${formatCost(model.cost)}${model.unpriced ? ` ${vscode.l10n.t('(price unknown)')}` : ''}, ${vscode.l10n.t('{0} requests', model.requests)}\n`);
		}
		tooltip.appendMarkdown(`\n${vscode.l10n.t('Click for details.')}`);
		this.item.tooltip = tooltip;
		this.item.show();
	}

	/** Refreshes the status bar, e.g. after model endpoints change. */
	refresh(): void {
		this.update();
	}
}
