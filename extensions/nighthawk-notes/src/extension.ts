/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { expandTemplate, sanitizeFileName } from './core/notes';
import { GraphPanel } from './graph';
import { FOLLOW_LINK_COMMAND, followLink, registerLanguageFeatures, renameNote } from './language';
import { NoteIndex, type IndexedNote } from './noteIndex';
import { Account } from './teams/account';
import { LocalServer } from './teams/localServer';
import type { Team } from './teams/client';
import { InviteUriHandler, registerTeamCommands } from './teams/teamCommands';
import { TEAM_SCHEME, TeamFileSystem, teamCollection, teamNoteUri } from './teams/teamFileSystem';
import { VAULT_COLLECTION, Vault } from './vault';
import { BacklinksProvider, TagsProvider, VaultTreeProvider } from './views/vaultViews';
import { roleLabel, TeamsTreeProvider } from './views/teamsView';
import { TicketStatus } from './codeLinks';
import { ActivityTracker } from './timeTracking';
import { WorkspacePanel } from './workspace';

const encoder = new TextEncoder();

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	const index = new NoteIndex();
	const vault = new Vault(index);
	const localServer = new LocalServer(context);
	const account = new Account(context, localServer);
	const teamFs = new TeamFileSystem(account, index);
	const ticketStatus = new TicketStatus(teamFs);
	const tracker = new ActivityTracker(context, account, () => ticketStatus.context(), teamId => {
		const team = teamFs.getTeam(teamId);
		if (team) {
			WorkspacePanel.show(context, account, teamFs, tracker, team).revealView('timesheet');
		}
	});

	const collectionLabel = (note: IndexedNote): string => note.collection === VAULT_COLLECTION
		? vscode.l10n.t('My notes')
		: teamFs.getTeam(note.uri.authority)?.name ?? vscode.l10n.t('Team');

	const vaultTree = new VaultTreeProvider(vault);
	const backlinks = new BacklinksProvider(index);
	const tags = new TagsProvider(index, collectionLabel);
	const teamsTree = new TeamsTreeProvider(account, teamFs);

	const vaultView = vscode.window.createTreeView('nighthawk.notes.vault', { treeDataProvider: vaultTree, showCollapseAll: true });
	const backlinksView = vscode.window.createTreeView('nighthawk.notes.backlinks', { treeDataProvider: backlinks });
	backlinks.view = backlinksView;
	const teamsView = vscode.window.createTreeView('nighthawk.notes.teams', { treeDataProvider: teamsTree, showCollapseAll: true });
	teamsTree.view = teamsView;

	context.subscriptions.push(
		localServer,
		index, vault, account, teamFs, vaultTree, backlinks, tags, teamsTree,
		vaultView, backlinksView, teamsView,
		vscode.window.registerTreeDataProvider('nighthawk.notes.tags', tags),
		vscode.workspace.registerFileSystemProvider(TEAM_SCHEME, teamFs, { isCaseSensitive: true }),
		vscode.window.registerUriHandler(new InviteUriHandler()),
		registerLanguageFeatures(index),
		registerTeamCommands(account, teamFs, teamsTree),
	);

	const activeNote = (uri?: vscode.Uri): IndexedNote | undefined => {
		const target = uri ?? vscode.window.activeTextEditor?.document.uri;
		return target && index.get(target);
	};

	/** Where a link to a missing note creates it: next to its collection's root. */
	const createLinkedNote = async (from: IndexedNote, name: string): Promise<vscode.Uri | undefined> => {
		const parts = name.split('/').map(sanitizeFileName);
		const title = parts.pop()!;
		if (from.collection === VAULT_COLLECTION) {
			return vault.createNote(title, `# ${title}\n\n`, vscode.Uri.joinPath(vault.root, ...parts));
		}
		const uri = teamNoteUri(from.uri.authority, [...parts, `${title}.md`].join('/'));
		await vscode.workspace.fs.writeFile(uri, encoder.encode(`# ${title}\n\n`));
		return uri;
	};

	const folderArg = (uri?: vscode.Uri): vscode.Uri => {
		if (!uri || !vault.contains(uri)) {
			return vault.root;
		}
		return uri.path.toLowerCase().endsWith('.md') ? vscode.Uri.joinPath(uri, '..') : uri;
	};

	const command = (id: string, handler: (...args: any[]) => unknown) => context.subscriptions.push(vscode.commands.registerCommand(id, async (...args: any[]) => {
		try {
			await handler(...args);
		} catch (err) {
			vscode.window.showErrorMessage(err.message);
		}
	}));

	command(FOLLOW_LINK_COMMAND, (from: string, target: string, heading: string | null) =>
		followLink(index, vscode.Uri.parse(from), target, heading ?? undefined, createLinkedNote));

	command('nighthawk.notes.newNote', async (folder?: vscode.Uri) => {
		const title = await vscode.window.showInputBox({ prompt: vscode.l10n.t('Name of the new note'), ignoreFocusOut: true });
		if (title?.trim()) {
			const uri = await vault.createNote(title.trim(), `# ${title.trim()}\n\n`, folderArg(folder));
			const editor = await vscode.window.showTextDocument(uri);
			const end = editor.document.lineAt(editor.document.lineCount - 1).range.end;
			editor.selection = new vscode.Selection(end, end);
		}
	});

	command('nighthawk.notes.newNoteFromTemplate', async (folder?: vscode.Uri) => {
		const templates = await vault.templates();
		if (!templates.length) {
			const create = vscode.l10n.t('Create Template');
			const choice = await vscode.window.showInformationMessage(
				vscode.l10n.t('No templates yet. Templates are notes in the "{0}" folder of your vault, and {1} in them are filled in.', vault.templatesFolder().path.split('/').pop() ?? '', '{{title}}, {{date}}, {{time}}'), create);
			if (choice === create) {
				const uri = await vault.createNote('Meeting', '# {{title}}\n\nDate: {{date}}\n\n## Attendees\n\n- \n\n## Notes\n\n## Action items\n\n- [ ] \n', vault.templatesFolder());
				await vscode.window.showTextDocument(uri);
			}
			return;
		}
		const template = await vscode.window.showQuickPick(templates, { placeHolder: vscode.l10n.t('Pick a template') });
		const title = template && await vscode.window.showInputBox({ prompt: vscode.l10n.t('Name of the new note'), ignoreFocusOut: true });
		if (template && title?.trim()) {
			const text = await vault.readTemplate(template) ?? '';
			const uri = await vault.createNote(title.trim(), expandTemplate(text, title.trim(), new Date()), folderArg(folder));
			await vscode.window.showTextDocument(uri);
		}
	});

	command('nighthawk.notes.newFolder', async (parent?: vscode.Uri) => {
		const name = await vscode.window.showInputBox({ prompt: vscode.l10n.t('Folder name') });
		if (name?.trim()) {
			await vault.ensureRoot();
			const uri = vscode.Uri.joinPath(folderArg(parent), sanitizeFileName(name));
			await vscode.workspace.fs.createDirectory(uri);
			vaultTree.refresh();
		}
	});

	command('nighthawk.notes.openDailyNote', async () => {
		await vscode.window.showTextDocument(await vault.dailyNote());
	});

	command('nighthawk.notes.quickOpen', async () => {
		const items = index.all()
			.sort((a, b) => a.name.localeCompare(b.name))
			.map(note => ({ label: note.name, description: `${collectionLabel(note)} · ${note.path}`, note: note as IndexedNote | undefined }));
		const create = { label: '', description: '', note: undefined as IndexedNote | undefined };
		const pick = vscode.window.createQuickPick<typeof items[number]>();
		pick.placeholder = vscode.l10n.t('Find a note, or type a new name to create it');
		pick.matchOnDescription = true;
		pick.items = items;
		pick.onDidChangeValue(value => {
			const exists = items.some(i => i.label.toLowerCase() === value.trim().toLowerCase());
			create.label = vscode.l10n.t('Create "{0}"', value.trim());
			create.description = vscode.l10n.t('New note in My notes');
			pick.items = value.trim() && !exists ? [...items, create] : items;
		});
		pick.onDidAccept(async () => {
			const selected = pick.selectedItems[0];
			const value = pick.value.trim();
			pick.hide();
			if (selected?.note) {
				await vscode.window.showTextDocument(selected.note.uri);
			} else if (value) {
				await vscode.window.showTextDocument(await vault.createNote(value, `# ${value}\n\n`));
			}
		});
		pick.onDidHide(() => pick.dispose());
		pick.show();
	});

	command('nighthawk.notes.rename', async (uri?: vscode.Uri) => {
		const note = activeNote(uri);
		if (!note) {
			return;
		}
		const name = await vscode.window.showInputBox({ prompt: vscode.l10n.t('New name for {0}', note.name), value: note.name, ignoreFocusOut: true });
		if (name?.trim() && name.trim() !== note.name) {
			await renameNote(index, note, sanitizeFileName(name));
		}
	});

	command('nighthawk.notes.delete', async (uri?: vscode.Uri) => {
		const target = uri ?? vscode.window.activeTextEditor?.document.uri;
		if (!target || !vault.contains(target)) {
			return;
		}
		const remove = vscode.l10n.t('Move to Trash');
		const name = target.path.split('/').pop();
		if (await vscode.window.showWarningMessage(vscode.l10n.t('Move {0} to the trash?', name ?? ''), { modal: true }, remove) === remove) {
			await vscode.workspace.fs.delete(target, { recursive: true, useTrash: true });
			vaultTree.refresh();
		}
	});

	command('nighthawk.notes.openVaultInWindow', () =>
		vscode.commands.executeCommand('vscode.openFolder', vault.root, { forceNewWindow: true }));

	command('nighthawk.notes.revealVault', () =>
		vscode.commands.executeCommand('revealFileInOS', vault.root));

	command('nighthawk.notes.changeVault', async () => {
		const picked = await vscode.window.showOpenDialog({
			canSelectFiles: false,
			canSelectFolders: true,
			defaultUri: vault.root,
			openLabel: vscode.l10n.t('Use as Vault'),
		});
		if (picked?.[0]) {
			// An existing Obsidian vault works as is.
			await vscode.workspace.getConfiguration('nighthawk.notes').update('vaultPath', picked[0].fsPath, vscode.ConfigurationTarget.Global);
		}
	});

	command('nighthawk.notes.refresh', async () => {
		await vault.start();
		await teamFs.syncAll();
	});

	command('nighthawk.notes.showGraph', () => {
		const note = activeNote();
		const collection = note?.collection ?? VAULT_COLLECTION;
		const title = collection === VAULT_COLLECTION
			? vscode.l10n.t('Graph: My notes')
			: vscode.l10n.t('Graph: {0}', teamFs.getTeam(collection.slice('team:'.length))?.name ?? '');
		GraphPanel.show(context, index, collection, title);
	});

	command('nighthawk.notes.showTeamGraph', (node?: { team?: { id: string; name: string } }) => {
		if (node?.team) {
			GraphPanel.show(context, index, teamCollection(node.team.id), vscode.l10n.t('Graph: {0}', node.team.name));
		}
	});

	command('nighthawk.notes.teams.openWorkspace', async (node?: { team?: Team }) => {
		let team = node?.team;
		if (!team) {
			if (!account.user) {
				await vscode.commands.executeCommand('nighthawk.notes.teams.signIn');
				if (!account.user) {
					return;
				}
			}
			const teams = teamFs.allTeams();
			if (!teams.length) {
				vscode.window.showInformationMessage(vscode.l10n.t('Create or join a team first.'));
				return;
			}
			team = teams.length === 1 ? teams[0] : (await vscode.window.showQuickPick(
				teams.map(candidate => ({ label: candidate.name, description: roleLabel(candidate.role), team: candidate })),
				{ placeHolder: vscode.l10n.t('Open the workspace of which team?') },
			))?.team;
		}
		if (team) {
			WorkspacePanel.show(context, account, teamFs, tracker, team);
		}
	});
	command('nighthawk.notes.teams.openTicket', (teamId?: string, number?: number) => {
		const team = typeof teamId === 'string' ? teamFs.getTeam(teamId) : undefined;
		if (team && typeof number === 'number') {
			WorkspacePanel.show(context, account, teamFs, tracker, team).revealItem(number);
		}
	});
	context.subscriptions.push({ dispose: () => WorkspacePanel.closeAll() }, ticketStatus, tracker);
	ticketStatus.showTracked(work => tracker.trackedToday(work), tracker.onDidChange);

	try {
		await vault.start();
	} catch (err) {
		vscode.window.showErrorMessage(vscode.l10n.t('Could not open the notes vault at {0}: {1}', vault.root.fsPath, err.message));
	}
	await account.restore();
}

export function deactivate(): void { }
