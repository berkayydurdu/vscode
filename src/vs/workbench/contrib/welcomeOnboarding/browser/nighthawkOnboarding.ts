/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { $, append, addDisposableListener, EventType, clearNode, getActiveWindow } from '../../../../base/browser/dom.js';
import { FileAccess } from '../../../../base/common/network.js';
import { isMacintosh } from '../../../../base/common/platform.js';
import { KeyCode } from '../../../../base/common/keyCodes.js';
import { StandardKeyboardEvent } from '../../../../base/browser/keyboardEvent.js';
import { InputBox } from '../../../../base/browser/ui/inputbox/inputBox.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IAccessibilityService } from '../../../../platform/accessibility/common/accessibility.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { defaultInputBoxStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { IWorkbenchThemeService } from '../../../services/themes/common/workbenchThemeService.js';
import { IPathService } from '../../../services/path/common/pathService.js';
import { IOnboardingThemeOption } from '../common/onboardingTypes.js';
import { IOnboardingService } from '../common/onboardingService.js';

const enum Step {
	Theme,
	Model,
	Notes,
	Ready,
}

const STEPS: readonly Step[] = [Step.Theme, Step.Model, Step.Notes, Step.Ready];

/** Command of the built-in Nighthawk Agent extension that adds a model endpoint. */
const ADD_ENDPOINT_COMMAND = 'nighthawk.ai.addEndpoint';
const VAULT_SETTING = 'nighthawk.notes.vaultPath';

interface ProviderOption {
	/** Preset id understood by {@link ADD_ENDPOINT_COMMAND}; undefined runs the full interactive setup. */
	readonly preset: string | undefined;
	readonly label: string;
	readonly detail: string;
	readonly monogram: string;
	readonly color: string;
	readonly needsKey: boolean;
	readonly keyUrl?: string;
}

const PROVIDERS: readonly ProviderOption[] = [
	{ preset: 'anthropic', label: 'Anthropic', detail: localize('nh.provider.anthropic', "Claude models"), monogram: 'A', color: '#c96442', needsKey: true, keyUrl: 'https://console.anthropic.com/settings/keys' },
	{ preset: 'openai', label: 'OpenAI', detail: localize('nh.provider.openai', "GPT models"), monogram: 'O', color: '#10a37f', needsKey: true, keyUrl: 'https://platform.openai.com/api-keys' },
	{ preset: 'openrouter', label: 'OpenRouter', detail: localize('nh.provider.openrouter', "Many models, one key"), monogram: 'R', color: '#6366f1', needsKey: true, keyUrl: 'https://openrouter.ai/keys' },
	{ preset: 'gemini', label: 'Google Gemini', detail: localize('nh.provider.gemini', "Gemini models"), monogram: 'G', color: '#3b82f6', needsKey: true, keyUrl: 'https://aistudio.google.com/apikey' },
	{ preset: 'deepseek', label: 'DeepSeek', detail: localize('nh.provider.deepseek', "Chat and reasoner"), monogram: 'D', color: '#4d6bfe', needsKey: true, keyUrl: 'https://platform.deepseek.com/api_keys' },
	{ preset: 'ollama', label: 'Ollama', detail: localize('nh.provider.ollama', "Runs locally, no key"), monogram: 'Ol', color: '#64748b', needsKey: false },
	{ preset: 'lmstudio', label: 'LM Studio', detail: localize('nh.provider.lmstudio', "Runs locally, no key"), monogram: 'LM', color: '#8b5cf6', needsKey: false },
	{ preset: undefined, label: localize('nh.provider.other', "Other"), detail: localize('nh.provider.other.detail', "Groq, Mistral, xAI, more"), monogram: '', color: '', needsKey: false },
];

interface QuickSetupResult {
	readonly name: string;
	readonly models: string[];
	readonly suggested?: string;
}

type ModelState =
	| { readonly kind: 'idle' }
	| { readonly kind: 'connecting' }
	| { readonly kind: 'connected'; readonly name: string; readonly models: string[]; chosen: string; saved?: string }
	| { readonly kind: 'error'; readonly message: string };

interface ReadyAction {
	readonly icon: ThemeIcon;
	readonly title: string;
	readonly detail: string;
	readonly command: string;
}

/**
 * Nighthawk's first-run setup: a centered modal that walks a new user through
 * picking a theme, connecting a model for Nighthawk Agent, choosing a notes
 * folder, and the shortcuts worth knowing. It reuses the layout and styles of
 * the upstream onboarding modal (`variationA.css`), so it follows the theme.
 */
export class NighthawkOnboarding extends Disposable implements IOnboardingService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidDismiss = this._register(new Emitter<void>());
	readonly onDidDismiss: Event<void> = this._onDidDismiss.event;

	private overlay: HTMLElement | undefined;
	private progressContainer: HTMLElement | undefined;
	private bodyEl: HTMLElement | undefined;
	private titleEl: HTMLElement | undefined;
	private subtitleEl: HTMLElement | undefined;
	private contentEl: HTMLElement | undefined;
	private footerLeft: HTMLElement | undefined;
	private backButton: HTMLButtonElement | undefined;
	private nextButton: HTMLButtonElement | undefined;
	private closeButton: HTMLButtonElement | undefined;
	private modelForm: HTMLElement | undefined;
	private modelStatus: HTMLElement | undefined;

	private readonly disposables = this._register(new DisposableStore());
	private readonly stepDisposables = this._register(new DisposableStore());
	private readonly stepFocusable: HTMLElement[] = [];
	private readonly footerFocusable: HTMLElement[] = [];
	private previouslyFocused: HTMLElement | undefined;

	private stepIndex = 0;
	private busy = false;
	private selectedThemeId: string | undefined;
	private provider: ProviderOption = PROVIDERS[0];
	private apiKey = '';
	private modelState: ModelState = { kind: 'idle' };
	private vaultChoice: 'fresh' | 'existing' = 'fresh';
	private vaultFolder: URI | undefined;
	private vaultApplied = false;

	constructor(
		@ILayoutService private readonly layoutService: ILayoutService,
		@IWorkbenchThemeService private readonly themeService: IWorkbenchThemeService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ICommandService private readonly commandService: ICommandService,
		@IFileDialogService private readonly fileDialogService: IFileDialogService,
		@IKeybindingService private readonly keybindingService: IKeybindingService,
		@IOpenerService private readonly openerService: IOpenerService,
		@IAccessibilityService private readonly accessibilityService: IAccessibilityService,
		@IProductService private readonly productService: IProductService,
		@IPathService private readonly pathService: IPathService,
	) {
		super();
	}

	show(): void {
		if (this.overlay) {
			return;
		}
		const settingsId = this.themeService.getColorTheme().settingsId;
		this.selectedThemeId = this.themes().find(t => t.themeId === settingsId)?.id;
		this.previouslyFocused = getActiveWindow().document.activeElement as HTMLElement | undefined;

		this.overlay = append(this.layoutService.activeContainer, $('.onboarding-a-overlay.nighthawk-onboarding'));
		this.overlay.setAttribute('role', 'dialog');
		this.overlay.setAttribute('aria-modal', 'true');
		this.overlay.setAttribute('aria-label', localize('nh.aria', "Welcome to {0}", this.productService.nameLong));

		const card = append(this.overlay, $('.onboarding-a-card'));

		this.closeButton = append(card, $<HTMLButtonElement>('button.onboarding-a-close-btn'));
		this.closeButton.type = 'button';
		this.closeButton.setAttribute('aria-label', localize('nh.close', "Close"));
		this.closeButton.appendChild(renderIcon(Codicon.close));

		const header = append(card, $('.onboarding-a-header'));
		const heading = append(header, $('.nh-onboarding-heading'));
		append(heading, $('span.nh-onboarding-brand')).setAttribute('aria-hidden', 'true');
		append(heading, $('span.nh-onboarding-product')).textContent = this.productService.nameLong;
		this.progressContainer = append(header, $('.onboarding-a-progress'));

		this.bodyEl = append(card, $('.onboarding-a-body'));
		this.titleEl = append(this.bodyEl, $('h2.onboarding-a-step-title'));
		this.subtitleEl = append(this.bodyEl, $('p.onboarding-a-step-subtitle'));
		this.contentEl = append(this.bodyEl, $('.onboarding-a-step-content'));

		const footer = append(card, $('.onboarding-a-footer'));
		this.footerLeft = append(footer, $('.onboarding-a-footer-left'));
		const footerRight = append(footer, $('.onboarding-a-footer-right'));
		this.backButton = append(footerRight, $<HTMLButtonElement>('button.onboarding-a-btn.onboarding-a-btn-secondary'));
		this.backButton.type = 'button';
		this.backButton.textContent = localize('nh.back', "Back");
		this.nextButton = append(footerRight, $<HTMLButtonElement>('button.onboarding-a-btn.onboarding-a-btn-primary'));
		this.nextButton.type = 'button';
		this.footerFocusable.push(this.backButton, this.nextButton);

		this.disposables.add(addDisposableListener(this.closeButton, EventType.CLICK, () => this.dismiss()));
		this.disposables.add(addDisposableListener(this.backButton, EventType.CLICK, () => this.goTo(this.stepIndex - 1)));
		this.disposables.add(addDisposableListener(this.nextButton, EventType.CLICK, () => this.next()));
		this.disposables.add(addDisposableListener(this.overlay, EventType.KEY_DOWN, (e: KeyboardEvent) => {
			const event = new StandardKeyboardEvent(e);
			// Keep workbench shortcuts from firing behind the modal.
			e.stopPropagation();
			if (event.keyCode === KeyCode.Escape) {
				e.preventDefault();
				this.dismiss();
			} else if (event.keyCode === KeyCode.Tab) {
				this.trapTab(e, event.shiftKey);
			}
		}));

		this.render();

		this.overlay.classList.add('entering');
		getActiveWindow().requestAnimationFrame(() => {
			this.overlay?.classList.remove('entering');
			this.overlay?.classList.add('visible');
		});
	}

	// --- navigation

	private async next(): Promise<void> {
		if (this.busy) {
			return;
		}
		if (!await this.applyStep(STEPS[this.stepIndex])) {
			return;
		}
		if (this.stepIndex === STEPS.length - 1) {
			this.dismiss();
		} else {
			this.goTo(this.stepIndex + 1);
		}
	}

	private goTo(index: number): void {
		if (index < 0 || index >= STEPS.length || this.busy) {
			return;
		}
		this.stepIndex = index;
		this.render();
	}

	/** Saves what the user chose on a step. Returns false to stay on the step. */
	private async applyStep(step: Step): Promise<boolean> {
		if (step === Step.Model && this.modelState.kind === 'connected' && this.modelState.saved !== this.modelState.chosen) {
			const state = this.modelState;
			if (!this.provider.preset) {
				return true; // the interactive setup already saved it
			}
			this.setBusy(true);
			try {
				await this.commandService.executeCommand(ADD_ENDPOINT_COMMAND, { preset: this.provider.preset, apiKey: this.apiKey, models: [state.chosen] });
				state.saved = state.chosen;
			} catch (err) {
				this.modelState = { kind: 'error', message: localize('nh.model.saveFailed', "Could not save the model: {0}", errorMessage(err)) };
				this.renderModelStatus();
				return false;
			} finally {
				this.setBusy(false);
			}
		}
		if (step === Step.Notes) {
			if (this.vaultChoice === 'existing' && this.vaultFolder) {
				await this.configurationService.updateValue(VAULT_SETTING, this.vaultFolder.fsPath, ConfigurationTarget.USER);
				this.vaultApplied = true;
			} else if (this.vaultChoice === 'fresh' && this.vaultApplied) {
				await this.configurationService.updateValue(VAULT_SETTING, undefined, ConfigurationTarget.USER);
				this.vaultApplied = false;
			}
		}
		return true;
	}

	private dismiss(then?: string): void {
		const overlay = this.overlay;
		if (!overlay) {
			return;
		}
		overlay.classList.remove('visible');
		overlay.classList.add('exiting');
		let done = false;
		const finish = () => {
			if (done) {
				return;
			}
			done = true;
			this.removeFromDOM();
			this._onDidDismiss.fire();
			if (then) {
				this.commandService.executeCommand(then);
			}
		};
		overlay.addEventListener('transitionend', finish, { once: true });
		setTimeout(finish, 400);
	}

	private setBusy(busy: boolean): void {
		this.busy = busy;
		this.nextButton?.toggleAttribute('disabled', busy);
		this.backButton?.toggleAttribute('disabled', busy);
	}

	// --- rendering

	private render(): void {
		if (!this.titleEl || !this.subtitleEl || !this.contentEl || !this.progressContainer) {
			return;
		}
		this.stepDisposables.clear();
		this.stepFocusable.length = 0;
		clearNode(this.contentEl);

		clearNode(this.progressContainer);
		for (let i = 0; i < STEPS.length; i++) {
			const dot = append(this.progressContainer, $('span.onboarding-a-progress-dot'));
			dot.classList.toggle('active', i === this.stepIndex);
			dot.classList.toggle('completed', i < this.stepIndex);
		}
		append(this.progressContainer, $('span.onboarding-a-step-label')).textContent = localize('nh.stepOf', "{0} of {1}", this.stepIndex + 1, STEPS.length);

		const step = STEPS[this.stepIndex];
		switch (step) {
			case Step.Theme:
				this.titleEl.textContent = localize('nh.theme.title', "Welcome to {0}", this.productService.nameLong);
				this.subtitleEl.textContent = localize('nh.theme.subtitle', "Let's get you set up. It takes about a minute, and you can change everything later.");
				this.renderThemeStep(this.contentEl);
				break;
			case Step.Model:
				this.titleEl.textContent = localize('nh.model.title', "Connect a model");
				this.subtitleEl.textContent = localize('nh.model.subtitle', "Nighthawk Agent works with the model you choose. Keys are stored in your operating system's keychain, never in settings.");
				this.renderModelStep(this.contentEl);
				break;
			case Step.Notes:
				this.titleEl.textContent = localize('nh.notes.title', "Where should your notes live?");
				this.subtitleEl.textContent = localize('nh.notes.subtitle', "Notes are plain Markdown files with links, backlinks, tags and a graph view.");
				this.renderNotesStep(this.contentEl);
				break;
			case Step.Ready:
				this.titleEl.textContent = localize('nh.ready.title', "You're all set");
				this.subtitleEl.textContent = localize('nh.ready.subtitle', "A few things worth knowing. Pick one to jump straight in.");
				this.renderReadyStep(this.contentEl);
				break;
		}
		this.bodyEl?.setAttribute('aria-label', localize('nh.step.aria', "Step {0} of {1}: {2}", this.stepIndex + 1, STEPS.length, this.titleEl.textContent));
		this.updateFooter();
		(this.stepFocusable.find(e => this.isTabbable(e)) ?? this.nextButton)?.focus();
	}

	private updateFooter(): void {
		if (!this.backButton || !this.nextButton || !this.footerLeft) {
			return;
		}
		const step = STEPS[this.stepIndex];
		this.backButton.style.display = this.stepIndex === 0 ? 'none' : '';

		let label = localize('nh.continue', "Continue");
		let primary = true;
		if (step === Step.Model) {
			if (this.modelState.kind !== 'connected') {
				label = localize('nh.model.skip', "Skip for Now");
				primary = false;
			}
		} else if (step === Step.Ready) {
			label = localize('nh.getStarted', "Start Coding");
		}
		this.nextButton.textContent = label;
		this.nextButton.className = `onboarding-a-btn ${primary ? 'onboarding-a-btn-primary' : 'onboarding-a-btn-secondary'}`;

		clearNode(this.footerLeft);
		if (step !== Step.Ready) {
			const skip = append(this.footerLeft, $<HTMLButtonElement>('button.onboarding-a-btn.onboarding-a-btn-ghost'));
			skip.type = 'button';
			skip.textContent = localize('nh.skipSetup', "Skip Setup");
			this.stepDisposables.add(addDisposableListener(skip, EventType.CLICK, () => this.dismiss()));
			this.stepFocusable.push(skip);
		}
	}

	// --- step: theme

	private themes(): readonly IOnboardingThemeOption[] {
		return this.productService.onboardingThemes ?? [];
	}

	private renderThemeStep(container: HTMLElement): void {
		const wrapper = append(container, $('.onboarding-a-personalize'));
		append(wrapper, $('div.onboarding-a-section-label')).textContent = localize('nh.theme.label', "Color Theme");
		const hint = append(wrapper, $('div.onboarding-a-theme-hint'));
		hint.textContent = localize('nh.theme.hint', "Nighthawk Dark and Nighthawk Light are made for this editor. More themes are a keystroke away later ({0}).", this.keybindingLabel('workbench.action.selectTheme') ?? localize('nh.theme.hint.fallback', "Preferences: Color Theme"));

		const grid = append(wrapper, $('.onboarding-a-theme-grid.theme-grid-expanded'));
		grid.setAttribute('role', 'radiogroup');
		grid.setAttribute('aria-label', localize('nh.theme.aria', "Choose a color theme"));

		const cards: HTMLElement[] = [];
		for (const theme of this.themes()) {
			const card = append(grid, $('div.onboarding-a-theme-card'));
			card.setAttribute('role', 'radio');
			card.setAttribute('aria-label', theme.label);
			card.dataset.id = theme.id;
			cards.push(card);
			this.stepFocusable.push(card);

			const preview = append(card, $('div.onboarding-a-theme-preview'));
			const img = append(preview, $<HTMLImageElement>('img.onboarding-a-theme-preview-img'));
			img.alt = '';
			img.src = FileAccess.asBrowserUri(`vs/workbench/contrib/welcomeOnboarding/browser/media/theme-preview-${theme.id}.svg`).toString(true);
			append(card, $('div.onboarding-a-theme-label')).textContent = theme.label;

			this.stepDisposables.add(addDisposableListener(card, EventType.CLICK, () => {
				this.selectedThemeId = theme.id;
				this.updateRadioGroup(cards, theme.id);
				this.applyTheme(theme);
				this.accessibilityService.alert(localize('nh.theme.selected', "{0} theme selected", theme.label));
			}));
		}
		this.updateRadioGroup(cards, this.selectedThemeId);
		this.setupRadioGroupNavigation(cards);
	}

	private async applyTheme(theme: IOnboardingThemeOption): Promise<void> {
		const match = (await this.themeService.getColorThemes()).find(t => t.settingsId === theme.themeId);
		if (match) {
			await this.themeService.setColorTheme(match.id, ConfigurationTarget.USER);
		}
	}

	// --- step: model

	private renderModelStep(container: HTMLElement): void {
		const wrapper = append(container, $('.nh-onboarding-model'));
		const grid = append(wrapper, $('.nh-onboarding-providers'));
		grid.setAttribute('role', 'radiogroup');
		grid.setAttribute('aria-label', localize('nh.model.aria', "Choose a model provider"));

		const tiles: HTMLElement[] = [];
		for (const provider of PROVIDERS) {
			const tile = append(grid, $<HTMLButtonElement>('button.nh-onboarding-provider'));
			tile.type = 'button';
			tile.setAttribute('role', 'radio');
			tile.dataset.id = provider.label;
			tiles.push(tile);
			this.stepFocusable.push(tile);

			const mark = append(tile, $('span.nh-onboarding-provider-mark'));
			mark.setAttribute('aria-hidden', 'true');
			if (provider.preset) {
				mark.textContent = provider.monogram;
				mark.style.backgroundColor = provider.color;
			} else {
				mark.classList.add('other');
				mark.appendChild(renderIcon(Codicon.ellipsis));
			}
			const text = append(tile, $('span.nh-onboarding-provider-text'));
			append(text, $('span.nh-onboarding-provider-name')).textContent = provider.label;
			append(text, $('span.nh-onboarding-provider-detail')).textContent = provider.detail;

			this.stepDisposables.add(addDisposableListener(tile, EventType.CLICK, () => {
				if (!provider.preset) {
					this.runInteractiveSetup();
					return;
				}
				if (provider !== this.provider) {
					this.provider = provider;
					this.apiKey = '';
					this.modelState = { kind: 'idle' };
					this.updateRadioGroup(tiles, provider.label);
					this.renderModelForm();
					this.updateFooter();
				}
			}));
		}
		this.updateRadioGroup(tiles, this.provider.label);
		this.setupRadioGroupNavigation(tiles, false);

		this.modelForm = append(wrapper, $('.nh-onboarding-model-form'));
		this.renderModelForm();
	}

	private renderModelForm(): void {
		const form = this.modelForm;
		if (!form) {
			return;
		}
		clearNode(form);
		const provider = this.provider;
		if (!provider.preset) {
			// Set up through the agent's own prompts; only the result is shown.
			this.modelStatus = append(form, $('.nh-onboarding-status'));
			this.modelStatus.setAttribute('aria-live', 'polite');
			this.renderModelStatus();
			return;
		}

		const row = append(form, $('.nh-onboarding-key-row'));
		if (provider.needsKey) {
			const field = append(row, $('.nh-onboarding-key-field'));
			const input = this.stepDisposables.add(new InputBox(field, undefined, {
				type: 'password',
				placeholder: localize('nh.model.keyPlaceholder', "Paste your {0} API key", provider.label),
				ariaLabel: localize('nh.model.keyAria', "{0} API key", provider.label),
				inputBoxStyles: defaultInputBoxStyles,
			}));
			input.value = this.apiKey;
			this.stepFocusable.push(input.inputElement);
			this.stepDisposables.add(input.onDidChange(value => { this.apiKey = value; }));
			this.stepDisposables.add(addDisposableListener(input.inputElement, EventType.KEY_DOWN, (e: KeyboardEvent) => {
				if (e.key === 'Enter') {
					e.preventDefault();
					this.connect();
				}
			}));
		} else {
			const local = append(row, $('.nh-onboarding-local-hint'));
			local.appendChild(renderIcon(Codicon.info));
			append(local, $('span')).textContent = localize('nh.model.localHint', "Start {0} on this computer, then connect. Nighthawk lists the models you have downloaded.", provider.label);
		}

		const connect = append(row, $<HTMLButtonElement>('button.onboarding-a-btn.onboarding-a-btn-primary.nh-onboarding-connect'));
		connect.type = 'button';
		connect.textContent = this.modelState.kind === 'connected' ? localize('nh.model.reconnect', "Reconnect") : localize('nh.model.connect', "Connect");
		this.stepFocusable.push(connect);
		this.stepDisposables.add(addDisposableListener(connect, EventType.CLICK, () => this.connect()));

		if (provider.keyUrl) {
			const link = append(form, $<HTMLAnchorElement>('a.nh-onboarding-link'));
			link.textContent = localize('nh.model.getKey', "Don't have a key? Create one at {0}", URI.parse(provider.keyUrl).authority);
			link.href = provider.keyUrl;
			link.setAttribute('role', 'link');
			this.stepFocusable.push(link);
			this.stepDisposables.add(addDisposableListener(link, EventType.CLICK, (e: MouseEvent) => {
				e.preventDefault();
				this.openerService.open(URI.parse(provider.keyUrl!), { openExternal: true });
			}));
		}

		this.modelStatus = append(form, $('.nh-onboarding-status'));
		this.modelStatus.setAttribute('aria-live', 'polite');
		this.renderModelStatus();
	}

	private renderModelStatus(): void {
		const status = this.modelStatus;
		if (!status) {
			return;
		}
		clearNode(status);
		status.className = 'nh-onboarding-status';
		const state = this.modelState;
		switch (state.kind) {
			case 'connecting': {
				status.classList.add('connecting');
				status.appendChild(renderIcon(ThemeIcon.modify(Codicon.loading, 'spin')));
				append(status, $('span')).textContent = localize('nh.model.connecting', "Connecting to {0}...", this.provider.label);
				break;
			}
			case 'error': {
				status.classList.add('error');
				status.appendChild(renderIcon(Codicon.error));
				append(status, $('span')).textContent = state.message;
				break;
			}
			case 'connected': {
				status.classList.add('connected');
				const line = append(status, $('.nh-onboarding-status-line'));
				line.appendChild(renderIcon(Codicon.passFilled));
				append(line, $('span')).textContent = state.models.length === 1
					? localize('nh.model.connectedOne', "Connected to {0}.", state.name)
					: localize('nh.model.connectedMany', "Connected to {0}. {1} models available.", state.name, state.models.length);
				if (state.models.length > 1 && this.provider.preset) {
					const pick = append(status, $('label.nh-onboarding-model-pick'));
					append(pick, $('span')).textContent = localize('nh.model.default', "Default model");
					const select = append(pick, $<HTMLSelectElement>('select.nh-onboarding-select'));
					for (const model of state.models) {
						const option = append(select, $<HTMLOptionElement>('option'));
						option.value = model;
						option.textContent = model;
						option.selected = model === state.chosen;
					}
					this.stepFocusable.push(select);
					this.stepDisposables.add(addDisposableListener(select, EventType.CHANGE, () => { state.chosen = select.value; }));
				}
				break;
			}
		}
		this.updateFooter();
	}

	private async connect(): Promise<void> {
		const provider = this.provider;
		if (this.busy || !provider.preset) {
			return;
		}
		if (provider.needsKey && !this.apiKey.trim()) {
			this.modelState = { kind: 'error', message: localize('nh.model.needKey', "Paste your {0} API key first.", provider.label) };
			this.renderModelStatus();
			return;
		}
		this.modelState = { kind: 'connecting' };
		this.renderModelStatus();
		this.setBusy(true);
		try {
			const result = await this.commandService.executeCommand<QuickSetupResult>(ADD_ENDPOINT_COMMAND, { preset: provider.preset, apiKey: this.apiKey });
			if (provider !== this.provider) {
				return;
			}
			if (!result?.models.length) {
				this.modelState = { kind: 'error', message: localize('nh.model.noModels', "{0} answered but offers no models.", provider.label) };
			} else {
				this.modelState = { kind: 'connected', name: result.name, models: result.models, chosen: result.suggested ?? result.models[0] };
				this.accessibilityService.alert(localize('nh.model.connectedAlert', "Connected to {0}", result.name));
			}
		} catch (err) {
			if (provider === this.provider) {
				this.modelState = { kind: 'error', message: errorMessage(err) };
			}
		} finally {
			this.setBusy(false);
		}
		this.renderModelStatus();
	}

	/** Runs the agent's own step-by-step setup for providers without a tile, with the modal hidden meanwhile. */
	private async runInteractiveSetup(): Promise<void> {
		const overlay = this.overlay;
		if (!overlay || this.busy) {
			return;
		}
		overlay.style.display = 'none';
		this.setBusy(true);
		let added: { name?: string; models?: string[] } | undefined;
		try {
			added = await this.commandService.executeCommand(ADD_ENDPOINT_COMMAND);
		} catch (err) {
			this.modelState = { kind: 'error', message: errorMessage(err) };
		} finally {
			this.setBusy(false);
			overlay.style.display = '';
		}
		if (added?.name && added.models?.length) {
			this.provider = PROVIDERS[PROVIDERS.length - 1];
			this.modelState = { kind: 'connected', name: added.name, models: added.models, chosen: added.models[0], saved: added.models[0] };
		}
		this.render();
	}

	// --- step: notes

	private renderNotesStep(container: HTMLElement): void {
		const wrapper = append(container, $('.onboarding-a-ai-pref.nh-onboarding-notes'));
		const cards = append(wrapper, $('.onboarding-a-ai-pref-cards.nh-two-columns'));
		cards.setAttribute('role', 'radiogroup');
		cards.setAttribute('aria-label', localize('nh.notes.aria', "Choose a notes folder"));

		const home = this.pathService.userHome({ preferLocal: true });
		const options: { id: 'fresh' | 'existing'; icon: ThemeIcon; title: string; detail: string }[] = [
			{
				id: 'fresh',
				icon: Codicon.notebook,
				title: localize('nh.notes.fresh', "Start fresh"),
				detail: localize('nh.notes.fresh.detail', "Nighthawk keeps your notes in a \"Nighthawk Notes\" folder in your home folder ({0}).", home.fsPath),
			},
			{
				id: 'existing',
				icon: Codicon.folderOpened,
				title: localize('nh.notes.existing', "Use a folder I already have"),
				detail: this.vaultFolder
					? localize('nh.notes.existing.chosen', "Using {0}", this.vaultFolder.fsPath)
					: localize('nh.notes.existing.detail', "Any folder of Markdown files works, including an Obsidian vault."),
			},
		];

		const buttons: HTMLElement[] = [];
		for (const option of options) {
			const card = append(cards, $<HTMLButtonElement>('button.onboarding-a-ai-pref-card'));
			card.type = 'button';
			card.setAttribute('role', 'radio');
			card.dataset.id = option.id;
			buttons.push(card);
			this.stepFocusable.push(card);
			const icon = append(card, $('span.onboarding-a-ai-pref-card-icon'));
			icon.setAttribute('aria-hidden', 'true');
			icon.appendChild(renderIcon(option.icon));
			append(card, $('div.onboarding-a-ai-pref-card-title')).textContent = option.title;
			append(card, $('div.onboarding-a-ai-pref-card-desc')).textContent = option.detail;

			this.stepDisposables.add(addDisposableListener(card, EventType.CLICK, async () => {
				if (option.id === 'existing') {
					const picked = await this.fileDialogService.showOpenDialog({
						title: localize('nh.notes.pick', "Choose Your Notes Folder"),
						openLabel: localize('nh.notes.pickLabel', "Use This Folder"),
						canSelectFolders: true,
						canSelectFiles: false,
						canSelectMany: false,
						defaultUri: this.vaultFolder ?? home,
					});
					if (!picked?.length) {
						return;
					}
					this.vaultFolder = picked[0];
				}
				this.vaultChoice = option.id;
				this.render();
			}));
		}
		this.updateRadioGroup(buttons, this.vaultChoice);

		const hint = append(wrapper, $('div.onboarding-a-ai-pref-hint'));
		hint.textContent = localize('nh.notes.hint', "Open the Notes view from the activity bar. To share notes, create a team from its Teams section and invite people with a link.");
	}

	// --- step: ready

	private renderReadyStep(container: HTMLElement): void {
		const actions: ReadyAction[] = [
			{ icon: Codicon.sparkle, title: localize('nh.ready.agent', "Ask Nighthawk Agent"), detail: localize('nh.ready.agent.detail', "Describe a change and the agent edits, runs and checks it for you."), command: 'nighthawk.agent.open' },
			{ icon: Codicon.folderOpened, title: localize('nh.ready.folder', "Open a project"), detail: localize('nh.ready.folder.detail', "Open a folder to start working on your code."), command: isMacintosh ? 'workbench.action.files.openFileFolder' : 'workbench.action.files.openFolder' },
			{ icon: Codicon.notebook, title: localize('nh.ready.notes', "Open your notes"), detail: localize('nh.ready.notes.detail', "Daily notes, [[links]], templates, and your team's workspace."), command: 'workbench.view.extension.nighthawk-notes' },
			{ icon: Codicon.keyboard, title: localize('nh.ready.commands', "Find any command"), detail: localize('nh.ready.commands.detail', "Every feature is in the Command Palette."), command: 'workbench.action.showCommands' },
		];

		const grid = append(container, $('.nh-onboarding-ready'));
		for (const action of actions) {
			const tile = append(grid, $<HTMLButtonElement>('button.nh-onboarding-ready-tile'));
			tile.type = 'button';
			this.stepFocusable.push(tile);
			const icon = append(tile, $('span.nh-onboarding-ready-icon'));
			icon.setAttribute('aria-hidden', 'true');
			icon.appendChild(renderIcon(action.icon));
			const text = append(tile, $('span.nh-onboarding-ready-text'));
			const title = append(text, $('span.nh-onboarding-ready-title'));
			append(title, $('span')).textContent = action.title;
			const key = this.keybindingLabel(action.command);
			if (key) {
				append(title, $('kbd.onboarding-a-kbd')).textContent = key;
			}
			append(text, $('span.nh-onboarding-ready-detail')).textContent = action.detail;
			this.stepDisposables.add(addDisposableListener(tile, EventType.CLICK, () => this.dismiss(action.command)));
		}
	}

	// --- helpers

	private keybindingLabel(command: string): string | undefined {
		return this.keybindingService.lookupKeybinding(command)?.getLabel() ?? undefined;
	}

	private updateRadioGroup(items: HTMLElement[], selectedId: string | undefined): void {
		for (const item of items) {
			const selected = item.dataset.id === selectedId;
			item.classList.toggle('selected', selected);
			item.setAttribute('aria-checked', String(selected));
		}
	}

	/** Arrow keys move between the items of a radio group; `select` also clicks the item focused. */
	private setupRadioGroupNavigation(items: HTMLElement[], select = true): void {
		for (let i = 0; i < items.length; i++) {
			items[i].tabIndex = 0;
			this.stepDisposables.add(addDisposableListener(items[i], EventType.KEY_DOWN, (e: KeyboardEvent) => {
				const event = new StandardKeyboardEvent(e);
				let target: number | undefined;
				if (event.keyCode === KeyCode.RightArrow || event.keyCode === KeyCode.DownArrow) {
					target = (i + 1) % items.length;
				} else if (event.keyCode === KeyCode.LeftArrow || event.keyCode === KeyCode.UpArrow) {
					target = (i - 1 + items.length) % items.length;
				} else if (event.keyCode === KeyCode.Enter || event.keyCode === KeyCode.Space) {
					e.preventDefault();
					items[i].click();
					return;
				}
				if (target !== undefined) {
					e.preventDefault();
					items[target].focus();
					if (select) {
						items[target].click();
					}
				}
			}));
		}
	}

	private trapTab(e: KeyboardEvent, shiftKey: boolean): void {
		const focusable = [...(this.closeButton ? [this.closeButton] : []), ...this.stepFocusable, ...this.footerFocusable].filter(el => this.isTabbable(el));
		if (!focusable.length) {
			e.preventDefault();
			return;
		}
		const active = getActiveWindow().document.activeElement;
		if (shiftKey && active === focusable[0]) {
			e.preventDefault();
			focusable[focusable.length - 1].focus();
		} else if (!shiftKey && active === focusable[focusable.length - 1]) {
			e.preventDefault();
			focusable[0].focus();
		}
	}

	private isTabbable(element: HTMLElement): boolean {
		if (!element.isConnected || element.tabIndex === -1 || element.hasAttribute('disabled')) {
			return false;
		}
		const style = getActiveWindow().getComputedStyle(element);
		return style.display !== 'none' && style.visibility !== 'hidden';
	}

	private removeFromDOM(): void {
		this.overlay?.remove();
		this.overlay = undefined;
		this.progressContainer = this.bodyEl = this.titleEl = this.subtitleEl = this.contentEl = this.footerLeft = undefined;
		this.backButton = this.nextButton = this.closeButton = undefined;
		this.modelForm = this.modelStatus = undefined;
		this.stepFocusable.length = 0;
		this.footerFocusable.length = 0;
		this.disposables.clear();
		this.stepDisposables.clear();
		this.stepIndex = 0;
		this.busy = false;
		this.previouslyFocused?.focus();
		this.previouslyFocused = undefined;
	}

	override dispose(): void {
		this.removeFromDOM();
		super.dispose();
	}
}

function errorMessage(err: unknown): string {
	const message = err instanceof Error ? err.message : String(err);
	if (/command '.*' not found/i.test(message)) {
		return localize('nh.model.noAgent', "Nighthawk Agent is not available. Enable the built-in Nighthawk Agent extension and try again.");
	}
	return message;
}
