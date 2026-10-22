/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { addStep, describeMacro, describeStep, editStep, parseMacros, planEdit, type Macro, type MacroStep } from '../core/macros';

const SAVED_KEY = 'nighthawk.macros';
const LAST_KEY = 'nighthawk.macros.last';
const RECORDING_CONTEXT = 'nighthawk.macro.recording';
/** Lines "Play Back on Each Selected Line" goes through at most. */
const MAX_LINES = 10_000;

/** What `nighthawk.macro.wrap` gets from the keybindings that are on while recording. */
interface WrapArgs {
	command: string;
	args?: unknown;
	/** Record the edit the command makes, not the command, as accepting a suggestion depends on what the widget showed. */
	edit?: boolean;
}

/**
 * Keyboard macros. While recording, the editor's typing commands are taken
 * over (the way the Vim extension does it) and the editing keys run through
 * `nighthawk.macro.wrap` (keybindings that are on only while recording), so
 * each becomes a step. Playing back runs the steps on the active editor.
 */
export class Macros implements vscode.Disposable {
	private recording: MacroStep[] | undefined;
	private overrideStore: vscode.Disposable[] = [];
	private playing = false;
	private readonly status = vscode.window.createStatusBarItem('nighthawk.macro', vscode.StatusBarAlignment.Left, 1000);

	constructor(private readonly state: vscode.Memento) {
		this.status.name = vscode.l10n.t('Macro Recording');
		this.status.command = 'nighthawk.macro.toggleRecording';
		this.status.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
	}

	dispose(): void {
		this.stopOverrides();
		this.status.dispose();
	}

	private get last(): MacroStep[] | undefined {
		return parseMacros([{ name: '', steps: this.state.get(LAST_KEY), created: 0 }])[0]?.steps;
	}

	private saved(): Macro[] {
		return parseMacros(this.state.get(SAVED_KEY));
	}

	async toggle(): Promise<void> {
		if (this.playing) {
			return;
		}
		if (this.recording) {
			return this.stop();
		}
		if (!this.startOverrides()) {
			vscode.window.showErrorMessage(vscode.l10n.t('Macros cannot record typing while another extension, such as Vim, handles it.'));
			return;
		}
		this.recording = [];
		await vscode.commands.executeCommand('setContext', RECORDING_CONTEXT, true);
		this.showStatus();
	}

	private async stop(): Promise<void> {
		const steps = this.recording ?? [];
		this.recording = undefined;
		this.stopOverrides();
		this.status.hide();
		await vscode.commands.executeCommand('setContext', RECORDING_CONTEXT, false);
		if (!steps.length) {
			vscode.window.setStatusBarMessage(vscode.l10n.t('Nothing was recorded.'), 4000);
			return;
		}
		await this.state.update(LAST_KEY, steps);
		vscode.window.setStatusBarMessage(vscode.l10n.t('Recorded a macro of {0} steps: {1}', steps.length, describeMacro(steps, 60)), 6000);
	}

	private showStatus(): void {
		const steps = this.recording ?? [];
		this.status.text = `$(record) ${vscode.l10n.t('Recording macro ({0})', steps.length)}`;
		this.status.tooltip = steps.length ? vscode.l10n.t('Click to stop. So far: {0}', describeMacro(steps)) : vscode.l10n.t('Type and edit, then click here or press the record key again to stop.');
		this.status.show();
	}

	private record(step: MacroStep): void {
		if (this.recording) {
			addStep(this.recording, step);
			this.showStatus();
		}
	}

	/** Takes over the editor's typing commands, passing each on to the editor after noting it. */
	private startOverrides(): boolean {
		const take = (command: string, handle: (args: Record<string, unknown>) => Thenable<unknown>) => {
			this.overrideStore.push(vscode.commands.registerCommand(command, (args: Record<string, unknown> = {}) => handle(args)));
		};
		try {
			take('type', args => {
				this.record({ kind: 'type', text: String(args.text ?? '') });
				return vscode.commands.executeCommand('default:type', args);
			});
			take('replacePreviousChar', args => {
				this.record({ kind: 'command', command: 'default:replacePreviousChar', args: { text: args.text, replaceCharCnt: args.replaceCharCnt } });
				return vscode.commands.executeCommand('default:replacePreviousChar', args);
			});
			take('compositionType', args => {
				this.record({ kind: 'command', command: 'default:compositionType', args: { text: args.text, replacePrevCharCnt: args.replacePrevCharCnt, replaceNextCharCnt: args.replaceNextCharCnt, positionDelta: args.positionDelta } });
				return vscode.commands.executeCommand('default:compositionType', args);
			});
			return true;
		} catch {
			this.stopOverrides();
			return false;
		}
	}

	private stopOverrides(): void {
		for (const d of this.overrideStore) {
			d.dispose();
		}
		this.overrideStore = [];
	}

	/** Runs an editing key's command, noting it first when recording. */
	async wrap(args: WrapArgs | undefined): Promise<void> {
		if (typeof args?.command !== 'string') {
			return;
		}
		const editor = vscode.window.activeTextEditor;
		if (!this.recording || !args.edit || !editor) {
			if (this.recording) {
				this.record({ kind: 'command', command: args.command, args: args.args });
			}
			await vscode.commands.executeCommand(args.command, args.args);
			return;
		}
		const cursor = editor.document.offsetAt(editor.selection.active);
		let step: MacroStep | undefined;
		const listener = vscode.workspace.onDidChangeTextDocument(e => {
			if (e.document === editor.document) {
				for (const change of e.contentChanges) {
					step ??= editStep(cursor, { offset: change.rangeOffset, length: change.rangeLength, text: change.text });
				}
			}
		});
		try {
			await vscode.commands.executeCommand(args.command, args.args);
		} finally {
			listener.dispose();
		}
		if (step) {
			this.record(step);
		}
	}

	private recordingWarning(): boolean {
		if (this.recording) {
			vscode.window.showInformationMessage(vscode.l10n.t('Stop recording before playing a macro back.'));
			return true;
		}
		return false;
	}

	private lastOrTell(): MacroStep[] | undefined {
		const steps = this.last;
		if (!steps?.length) {
			vscode.window.showInformationMessage(vscode.l10n.t('There is no macro yet. Run "Macro: Start or Stop Recording" (Ctrl+Alt+R), edit, and run it again to stop.'));
		}
		return steps?.length ? steps : undefined;
	}

	async play(steps = this.lastOrTell(), times = 1): Promise<void> {
		if (!steps || this.recordingWarning() || this.playing) {
			return;
		}
		if (times <= 1) {
			await this.run(() => this.playOnce(steps));
			return;
		}
		await this.run(() => vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Playing the macro'), cancellable: true }, async (progress, token) => {
			for (let i = 0; i < times && !token.isCancellationRequested; i++) {
				progress.report({ message: vscode.l10n.t('{0} of {1}', i + 1, times), increment: 100 / times });
				await this.playOnce(steps);
			}
		}));
	}

	async playTimes(): Promise<void> {
		const steps = this.lastOrTell();
		if (!steps) {
			return;
		}
		const value = await vscode.window.showInputBox({
			title: vscode.l10n.t('Play Back Last Macro Several Times'),
			prompt: vscode.l10n.t('How many times? Playing stops early if a step fails, such as moving past the end of the file.'),
			value: '10',
			validateInput: text => /^\d+$/.test(text.trim()) && Number(text) >= 1 && Number(text) <= 100_000 ? undefined : vscode.l10n.t('Enter a whole number from 1 to 100000.'),
		});
		if (value) {
			await this.play(steps, Number(value));
		}
	}

	/** Puts the cursor at the start of each selected line, from the last up so line numbers stay put, and plays the macro there. */
	async playEachLine(): Promise<void> {
		const editor = vscode.window.activeTextEditor;
		const steps = this.lastOrTell();
		if (!editor || !steps || this.recordingWarning() || this.playing) {
			return;
		}
		const lines = new Set<number>();
		for (const selection of editor.selections) {
			// A selection that ends at the start of a line does not take that line in.
			const end = selection.end.character === 0 && selection.end.line > selection.start.line ? selection.end.line - 1 : selection.end.line;
			for (let line = selection.start.line; line <= end && lines.size < MAX_LINES; line++) {
				lines.add(line);
			}
		}
		const order = [...lines].sort((a, b) => b - a);
		await this.run(() => vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Playing the macro on {0} lines', order.length), cancellable: true }, async (_progress, token) => {
			for (const line of order) {
				if (token.isCancellationRequested || vscode.window.activeTextEditor !== editor || line >= editor.document.lineCount) {
					break;
				}
				const start = new vscode.Position(line, 0);
				editor.selection = new vscode.Selection(start, start);
				await this.playOnce(steps);
			}
		}));
	}

	private async run(play: () => Thenable<void>): Promise<void> {
		this.playing = true;
		try {
			await play();
		} catch (err) {
			vscode.window.showErrorMessage((err as Error).message);
		} finally {
			this.playing = false;
		}
	}

	private async playOnce(steps: readonly MacroStep[]): Promise<void> {
		for (const [index, step] of steps.entries()) {
			try {
				await this.playStep(step);
			} catch (err) {
				throw new Error(vscode.l10n.t('The macro stopped at step {0} ({1}): {2}', index + 1, describeStep(step), (err as Error).message));
			}
		}
	}

	private async playStep(step: MacroStep): Promise<void> {
		switch (step.kind) {
			case 'type':
				// Straight to the editor, past any extension (such as Vim) that took over typing.
				await vscode.commands.executeCommand('default:type', { text: step.text });
				return;
			case 'command':
				await vscode.commands.executeCommand(step.command, step.args);
				return;
			case 'edit': {
				const editor = vscode.window.activeTextEditor;
				if (!editor) {
					throw new Error(vscode.l10n.t('No editor is open.'));
				}
				const document = editor.document;
				const plan = planEdit(step, editor.selections.map(s => document.offsetAt(s.active)), document.getText().length);
				const ranges = plan.replacements.map(r => new vscode.Range(document.positionAt(r.start), document.positionAt(r.end)));
				await editor.edit(builder => ranges.forEach(range => builder.replace(range, step.text)), { undoStopBefore: false, undoStopAfter: false });
				editor.selections = plan.cursors.map(offset => {
					const at = document.positionAt(offset);
					return new vscode.Selection(at, at);
				});
				return;
			}
		}
	}

	async save(): Promise<void> {
		const steps = this.lastOrTell();
		if (!steps) {
			return;
		}
		const saved = this.saved();
		const name = (await vscode.window.showInputBox({
			title: vscode.l10n.t('Save Last Macro'),
			prompt: describeMacro(steps),
			placeHolder: vscode.l10n.t('A name, such as "Wrap in quotes"'),
			validateInput: value => saved.some(m => m.name === value.trim()) ? { message: vscode.l10n.t('Replaces the saved macro of this name.'), severity: vscode.InputBoxValidationSeverity.Warning } : undefined,
		}))?.trim();
		if (!name) {
			return;
		}
		await this.state.update(SAVED_KEY, [...saved.filter(m => m.name !== name), { name, steps, created: Date.now() }]);
		vscode.window.setStatusBarMessage(vscode.l10n.t('Saved the macro "{0}". Run it from "Macro: Run Saved Macro...", or give it a key.', name), 6000);
	}

	/** Runs a saved macro: the one named in `args`, which lets a keybinding run it, or one picked from a list. */
	async runSaved(args?: { name?: unknown }): Promise<void> {
		const saved = this.saved();
		if (typeof args?.name === 'string') {
			const macro = saved.find(m => m.name === args.name);
			if (!macro) {
				vscode.window.showErrorMessage(vscode.l10n.t('There is no saved macro named "{0}".', args.name));
				return;
			}
			return this.play(macro.steps);
		}
		if (!saved.length) {
			vscode.window.showInformationMessage(vscode.l10n.t('There are no saved macros yet. Record one, then run "Macro: Save Last Macro...".'));
			return;
		}
		type Item = vscode.QuickPickItem & { macro: Macro };
		const keyButton: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('keyboard'), tooltip: vscode.l10n.t('Add Keyboard Shortcut') };
		const removeButton: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('trash'), tooltip: vscode.l10n.t('Delete') };
		const editor = vscode.window.activeTextEditor;
		const pick = vscode.window.createQuickPick<Item>();
		pick.title = vscode.l10n.t('Run Saved Macro');
		pick.placeholder = vscode.l10n.t('Pick a macro to play back in the editor');
		const render = (list: Macro[]) => {
			pick.items = list.sort((a, b) => a.name.localeCompare(b.name)).map(macro => ({ label: macro.name, description: vscode.l10n.t('{0} steps', macro.steps.length), detail: describeMacro(macro.steps, 120), buttons: [keyButton, removeButton], macro }));
		};
		render(saved);
		pick.onDidTriggerItemButton(async e => {
			if (e.button === removeButton) {
				const rest = this.saved().filter(m => m.name !== e.item.macro.name);
				await this.state.update(SAVED_KEY, rest);
				render(rest);
				return;
			}
			pick.hide();
			await this.addKeybinding(e.item.macro.name);
		});
		pick.onDidAccept(async () => {
			const macro = pick.selectedItems[0]?.macro;
			pick.hide();
			if (macro) {
				if (editor) {
					await vscode.window.showTextDocument(editor.document, editor.viewColumn);
				}
				await this.play(macro.steps);
			}
		});
		pick.onDidHide(() => pick.dispose());
		pick.show();
	}

	/** Copies a keybinding that runs the macro and opens keybindings.json to paste it in. */
	private async addKeybinding(name: string): Promise<void> {
		const binding = { key: '', command: 'nighthawk.macro.run', args: { name }, when: 'editorTextFocus' };
		await vscode.env.clipboard.writeText(`${JSON.stringify(binding, null, '\t')},`);
		await vscode.commands.executeCommand('workbench.action.openGlobalKeybindingsFile');
		vscode.window.showInformationMessage(vscode.l10n.t('Copied a keybinding for "{0}". Paste it into the list and fill in "key", such as "ctrl+alt+1".', name));
	}
}
