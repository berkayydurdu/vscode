/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { sanitizeFileName } from '../core/notes';
import { config } from '../vault';
import { roleLabel, TeamsTreeProvider, type TeamNode } from '../views/teamsView';
import { Account } from './account';
import { parseInvite, ROLE_RANK, type Role, type Team } from './client';
import { TeamFileSystem, teamNoteUri, teamPathOf } from './teamFileSystem';

const encoder = new TextEncoder();

/**
 * Commands for accounts, teams, members, invites and team notes.
 */
export function registerTeamCommands(account: Account, fs: TeamFileSystem, tree: TeamsTreeProvider): vscode.Disposable {

	const run = (id: string, handler: (...args: any[]) => Promise<unknown>) => vscode.commands.registerCommand(id, async (...args: any[]) => {
		try {
			await handler(...args);
		} catch (err) {
			vscode.window.showErrorMessage(err.message);
		}
	});

	const requireSignIn = async (): Promise<boolean> => {
		if (account.user) {
			return true;
		}
		const signIn = vscode.l10n.t('Sign In');
		const register = vscode.l10n.t('Create Account');
		const choice = await vscode.window.showInformationMessage(vscode.l10n.t('Sign in to a notes server to use teams.'), signIn, register);
		if (choice === signIn) {
			await vscode.commands.executeCommand('nighthawk.notes.teams.signIn');
		} else if (choice === register) {
			await vscode.commands.executeCommand('nighthawk.notes.teams.register');
		}
		return !!account.user;
	};

	const pickTeam = async (minimum: Role, node?: TeamNode): Promise<Team | undefined> => {
		if (node?.team) {
			return node.team;
		}
		if (!await requireSignIn()) {
			return undefined;
		}
		const teams = fs.allTeams().filter(team => ROLE_RANK[team.role] >= ROLE_RANK[minimum]);
		if (!teams.length) {
			vscode.window.showInformationMessage(vscode.l10n.t('You have no teams where you can do this yet. Create or join a team first.'));
			return undefined;
		}
		if (teams.length === 1) {
			return teams[0];
		}
		const picked = await vscode.window.showQuickPick(teams.map(team => ({ label: team.name, description: roleLabel(team.role), team })), { placeHolder: vscode.l10n.t('Pick a team') });
		return picked?.team;
	};

	const pickRole = async (placeHolder: string, allowOwner: boolean, current?: Role): Promise<Role | undefined> => {
		const roles: { role: Role; detail: string }[] = [
			{ role: 'viewer', detail: vscode.l10n.t('Can read the team\'s notes') },
			{ role: 'editor', detail: vscode.l10n.t('Can read, create and edit notes') },
			{ role: 'admin', detail: vscode.l10n.t('Can also invite and manage members') },
		];
		if (allowOwner) {
			roles.push({ role: 'owner', detail: vscode.l10n.t('Full control, including deleting the team') });
		}
		const picked = await vscode.window.showQuickPick(
			roles.map(r => ({ label: roleLabel(r.role), detail: r.detail, description: r.role === current ? vscode.l10n.t('current') : undefined, role: r.role })),
			{ placeHolder },
		);
		return picked?.role;
	};

	const askCredentials = async (withName: boolean) => {
		const server = Account.serverUrl();
		const email = await vscode.window.showInputBox({ title: vscode.l10n.t('Nighthawk Notes ({0})', server), prompt: vscode.l10n.t('Email'), ignoreFocusOut: true, value: '' });
		if (!email) {
			return undefined;
		}
		let name: string | undefined = '';
		if (withName) {
			name = await vscode.window.showInputBox({ title: vscode.l10n.t('Nighthawk Notes ({0})', server), prompt: vscode.l10n.t('Your name, as teammates will see it'), ignoreFocusOut: true });
			if (!name) {
				return undefined;
			}
		}
		const password = await vscode.window.showInputBox({
			title: vscode.l10n.t('Nighthawk Notes ({0})', server),
			prompt: withName ? vscode.l10n.t('Choose a password (at least 8 characters)') : vscode.l10n.t('Password'),
			password: true,
			ignoreFocusOut: true,
			validateInput: value => withName && value.length < 8 ? vscode.l10n.t('Use at least 8 characters') : undefined,
		});
		return password ? { email, name, password } : undefined;
	};

	const joinWithCode = async (code: string, server: string | undefined) => {
		if (server && server.replace(/\/+$/, '') !== Account.serverUrl()) {
			const switchServer = vscode.l10n.t('Switch Server');
			const choice = await vscode.window.showWarningMessage(
				vscode.l10n.t('This invite is for the notes server at {0}, but Nighthawk is set to use {1}. Switch to the invite\'s server?', server, Account.serverUrl()),
				{ modal: true }, switchServer);
			if (choice !== switchServer) {
				return;
			}
			await config().update('server.url', server, vscode.ConfigurationTarget.Global);
			await account.restore();
		}
		const preview = (await account.clientFor().previewInvite(code)).invite;
		if (!await requireSignIn()) {
			return;
		}
		const join = vscode.l10n.t('Join');
		const choice = await vscode.window.showInformationMessage(
			vscode.l10n.t('Join {0} as {1}?', preview.team.name, roleLabel(preview.role).toLowerCase()), { modal: true }, join);
		if (choice !== join) {
			return;
		}
		const result = await account.client.acceptInvite(code);
		await fs.reloadTeams();
		vscode.window.showInformationMessage(result.alreadyMember
			? vscode.l10n.t('You are already a member of {0}.', result.team.name)
			: vscode.l10n.t('You joined {0}.', result.team.name));
		await vscode.commands.executeCommand('nighthawk.notes.teams.focus');
	};

	/** Emails invites, or opens the mail app with a link when the server cannot send email. */
	const inviteByEmail = async (team: Team): Promise<void> => {
		const input = await vscode.window.showInputBox({
			title: vscode.l10n.t('Invite to {0} by Email', team.name),
			prompt: vscode.l10n.t('Email addresses, separated by commas or spaces'),
			placeHolder: 'ada@example.com, grace@example.com',
			ignoreFocusOut: true,
			validateInput: value => {
				const bad = emailList(value).filter(email => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email));
				return bad.length ? vscode.l10n.t('Not an email address: {0}', bad.join(', ')) : undefined;
			},
		});
		const emails = input ? emailList(input) : [];
		if (!emails.length) {
			return;
		}
		const role = await pickRole(vscode.l10n.t('What can they do in {0}?', team.name), team.role === 'owner');
		if (!role) {
			return;
		}
		const message = await vscode.window.showInputBox({
			title: vscode.l10n.t('Invite to {0} by Email', team.name),
			prompt: vscode.l10n.t('A note to add to the email (optional)'),
			ignoreFocusOut: true,
		});
		if (message === undefined) {
			return;
		}
		const hours = config().get<number>('teams.inviteExpiryHours', 168);
		if (!(await account.client.info()).email) {
			// The server has no mail set up: write the email in the user's mail app instead.
			const invite = await account.client.createInvite(team.id, role, hours, emails.length);
			tree.refresh();
			const body = [
				vscode.l10n.t('{0} invited you to the team {1} on Nighthawk Notes.', account.user?.name ?? '', team.name),
				...(message.trim() ? ['', message.trim()] : []),
				'',
				vscode.l10n.t('Accept the invite: {0}', invite.url),
				vscode.l10n.t('Or, in Nighthawk, run "Notes: Join Team with Invite..." and enter the code {0}.', invite.code),
			].join('\n');
			const subject = vscode.l10n.t('Join {0} on Nighthawk Notes', team.name);
			await vscode.env.clipboard.writeText(invite.url);
			await vscode.env.openExternal(vscode.Uri.parse(`mailto:${emails.map(encodeURIComponent).join(',')}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`, true));
			vscode.window.showInformationMessage(vscode.l10n.t('This notes server cannot send email, so your mail app opened with the invite. The link is also copied.'));
			return;
		}
		const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Sending invites...') },
			() => account.client.emailInvites(team.id, emails, role, hours, message.trim() || undefined));
		tree.refresh();
		if (result.failed.length) {
			vscode.window.showWarningMessage(vscode.l10n.t('Could not email {0}: {1}', result.failed.map(f => f.email).join(', '), result.failed[0].error));
		}
		if (result.sent.length) {
			vscode.window.showInformationMessage(result.sent.length === 1
				? vscode.l10n.t('Invite sent to {0}.', result.sent[0].email ?? '')
				: vscode.l10n.t('Invites sent to {0} people.', result.sent.length));
		}
	};

	return vscode.Disposable.from(
		run('nighthawk.notes.teams.signIn', async () => {
			const credentials = await askCredentials(false);
			if (credentials) {
				const user = await account.signIn(credentials.email, credentials.password);
				vscode.window.showInformationMessage(vscode.l10n.t('Signed in as {0}.', user.name));
			}
		}),

		run('nighthawk.notes.teams.register', async () => {
			const info = await account.clientFor().info();
			if (!info.allowRegistration) {
				throw new Error(vscode.l10n.t('This notes server does not allow new accounts. Ask its administrator.'));
			}
			const credentials = await askCredentials(true);
			if (credentials) {
				const user = await account.register(credentials.email, credentials.name, credentials.password);
				vscode.window.showInformationMessage(vscode.l10n.t('Welcome, {0}! Create a team or join one with an invite code.', user.name));
			}
		}),

		run('nighthawk.notes.teams.signOut', async () => {
			await account.signOut();
		}),

		run('nighthawk.notes.teams.setServer', async () => {
			const value = await vscode.window.showInputBox({
				prompt: vscode.l10n.t('Address of the Nighthawk Notes server'),
				value: Account.serverUrl(),
				ignoreFocusOut: true,
				validateInput: v => /^https?:\/\/[^\s/]+/.test(v.trim()) ? undefined : vscode.l10n.t('Enter an http:// or https:// address'),
			});
			if (value) {
				await account.clientFor(value.trim()).info();
				await config().update('server.url', value.trim(), vscode.ConfigurationTarget.Global);
			}
		}),

		run('nighthawk.notes.teams.refresh', async () => {
			await fs.reloadTeams();
			tree.refresh();
		}),

		run('nighthawk.notes.teams.createTeam', async () => {
			if (!await requireSignIn()) {
				return;
			}
			const name = await vscode.window.showInputBox({ prompt: vscode.l10n.t('Team name'), ignoreFocusOut: true });
			if (name?.trim()) {
				const team = await account.client.createTeam(name.trim());
				await fs.reloadTeams();
				const invite = vscode.l10n.t('Invite Members');
				if (await vscode.window.showInformationMessage(vscode.l10n.t('Created {0}.', team.name), invite) === invite) {
					await vscode.commands.executeCommand('nighthawk.notes.teams.invite', { kind: 'team', team: fs.getTeam(team.id) ?? team });
				}
			}
		}),

		run('nighthawk.notes.teams.renameTeam', async (node?: TeamNode) => {
			const team = await pickTeam('admin', node);
			const name = team && await vscode.window.showInputBox({ prompt: vscode.l10n.t('New team name'), value: team.name });
			if (team && name?.trim()) {
				await account.client.renameTeam(team.id, name.trim());
				await fs.reloadTeams();
			}
		}),

		run('nighthawk.notes.teams.deleteTeam', async (node?: TeamNode) => {
			const team = await pickTeam('owner', node);
			if (!team) {
				return;
			}
			const remove = vscode.l10n.t('Delete Team');
			const choice = await vscode.window.showWarningMessage(
				vscode.l10n.t('Delete {0} and all of its notes for every member? This cannot be undone.', team.name), { modal: true }, remove);
			if (choice === remove) {
				await account.client.deleteTeam(team.id);
				await fs.reloadTeams();
			}
		}),

		run('nighthawk.notes.teams.leaveTeam', async (node?: TeamNode) => {
			const team = await pickTeam('viewer', node);
			if (!team) {
				return;
			}
			const leave = vscode.l10n.t('Leave');
			if (await vscode.window.showWarningMessage(vscode.l10n.t('Leave {0}? You will need a new invite to come back.', team.name), { modal: true }, leave) === leave) {
				await account.client.leaveTeam(team.id);
				await fs.reloadTeams();
			}
		}),

		run('nighthawk.notes.teams.invite', async (node?: TeamNode) => {
			const team = await pickTeam('admin', node);
			if (!team) {
				return;
			}
			const how = await vscode.window.showQuickPick([
				{ label: `$(mail) ${vscode.l10n.t('Invite by Email')}`, detail: vscode.l10n.t('Each person gets an email with a link that only works for their address'), byEmail: true },
				{ label: `$(link) ${vscode.l10n.t('Copy an Invite Link')}`, detail: vscode.l10n.t('Share it any way you like'), byEmail: false },
			], { placeHolder: vscode.l10n.t('How do you want to invite people to {0}?', team.name) });
			if (!how) {
				return;
			}
			if (how.byEmail) {
				await inviteByEmail(team);
				return;
			}
			const role = await pickRole(vscode.l10n.t('What can people who join with this invite do?'), team.role === 'owner');
			if (!role) {
				return;
			}
			const uses = await vscode.window.showQuickPick([
				{ label: vscode.l10n.t('One person'), maxUses: 1 },
				{ label: vscode.l10n.t('Anyone with the link'), detail: vscode.l10n.t('Until it expires or is revoked'), maxUses: undefined },
			], { placeHolder: vscode.l10n.t('Who can use this invite?') });
			if (!uses) {
				return;
			}
			const invite = await account.client.createInvite(team.id, role, config().get<number>('teams.inviteExpiryHours', 168), uses.maxUses);
			await vscode.env.clipboard.writeText(invite.url);
			tree.refresh();
			vscode.window.showInformationMessage(
				vscode.l10n.t('Invite link copied. Send it to the people you want in {0}. They can also join with the code {1}.', team.name, invite.code));
		}),

		run('nighthawk.notes.teams.copyInvite', async (node?: TeamNode) => {
			if (node?.kind === 'invite') {
				await vscode.env.clipboard.writeText(node.invite.url);
				vscode.window.showInformationMessage(vscode.l10n.t('Invite link copied.'));
			}
		}),

		run('nighthawk.notes.teams.revokeInvite', async (node?: TeamNode) => {
			if (node?.kind === 'invite') {
				await account.client.revokeInvite(node.team.id, node.invite.code);
				tree.refresh();
			}
		}),

		run('nighthawk.notes.teams.join', async (arg?: string | { code: string; server?: string }) => {
			if (typeof arg === 'object') {
				await joinWithCode(arg.code, arg.server);
				return;
			}
			const input = arg ?? await vscode.window.showInputBox({
				prompt: vscode.l10n.t('Paste an invite link or code'),
				placeHolder: 'ABCD-EFGH-JKLM',
				ignoreFocusOut: true,
				validateInput: value => !value || parseInvite(value) ? undefined : vscode.l10n.t('That does not look like an invite link or code'),
			});
			const invite = input && parseInvite(input);
			if (invite) {
				await joinWithCode(invite.code, invite.server);
			}
		}),

		run('nighthawk.notes.teams.changeRole', async (node?: TeamNode) => {
			if (node?.kind !== 'member') {
				return;
			}
			const role = await pickRole(vscode.l10n.t('Role for {0}', node.member.name), node.team.role === 'owner', node.member.role);
			if (role && role !== node.member.role) {
				await account.client.setRole(node.team.id, node.member.userId, role);
				tree.refresh();
			}
		}),

		run('nighthawk.notes.teams.removeMember', async (node?: TeamNode) => {
			if (node?.kind !== 'member') {
				return;
			}
			const remove = vscode.l10n.t('Remove');
			if (await vscode.window.showWarningMessage(vscode.l10n.t('Remove {0} from {1}?', node.member.name, node.team.name), { modal: true }, remove) === remove) {
				await account.client.removeMember(node.team.id, node.member.userId);
				tree.refresh();
			}
		}),

		run('nighthawk.notes.teams.newNote', async (node?: TeamNode) => {
			const team = await pickTeam('editor', node);
			if (!team) {
				return;
			}
			const title = await vscode.window.showInputBox({ prompt: vscode.l10n.t('Name of the new note in {0}', team.name), ignoreFocusOut: true });
			if (!title?.trim()) {
				return;
			}
			const folder = node?.kind === 'entry' && node.isFolder ? teamPathOf(node.uri) + '/' : '';
			const name = sanitizeFileName(title);
			const uri = teamNoteUri(team.id, `${folder}${name}.md`);
			await vscode.workspace.fs.writeFile(uri, encoder.encode(`# ${title.trim()}\n\n`));
			await vscode.window.showTextDocument(uri);
		}),

		run('nighthawk.notes.teams.newFolder', async (node?: TeamNode) => {
			const team = await pickTeam('editor', node);
			const name = team && await vscode.window.showInputBox({ prompt: vscode.l10n.t('Folder name') });
			if (team && name?.trim()) {
				const parent = node?.kind === 'entry' && node.isFolder ? teamPathOf(node.uri) + '/' : '';
				await vscode.workspace.fs.createDirectory(teamNoteUri(team.id, parent + sanitizeFileName(name)));
			}
		}),

		run('nighthawk.notes.teams.renameNote', async (node?: TeamNode) => {
			if (node?.kind === 'entry' && !node.isFolder) {
				await vscode.commands.executeCommand('nighthawk.notes.rename', node.uri);
			}
		}),

		run('nighthawk.notes.teams.deleteNote', async (node?: TeamNode) => {
			if (node?.kind !== 'entry') {
				return;
			}
			const remove = vscode.l10n.t('Delete');
			const name = node.uri.path.split('/').pop();
			const message = node.isFolder
				? vscode.l10n.t('Delete the folder {0} and its notes for everyone in {1}?', name ?? '', node.team.name)
				: vscode.l10n.t('Delete {0} for everyone in {1}?', name ?? '', node.team.name);
			if (await vscode.window.showWarningMessage(message, { modal: true }, remove) === remove) {
				await vscode.workspace.fs.delete(node.uri, { recursive: true });
			}
		}),

		run('nighthawk.notes.teams.shareNote', async (uri?: vscode.Uri) => {
			const source = uri ?? vscode.window.activeTextEditor?.document.uri;
			if (!source || source.scheme !== 'file') {
				vscode.window.showInformationMessage(vscode.l10n.t('Open a note from your vault to share it with a team.'));
				return;
			}
			const team = await pickTeam('editor');
			if (!team) {
				return;
			}
			const name = source.path.split('/').pop()!;
			const target = teamNoteUri(team.id, name.toLowerCase().endsWith('.md') ? name : `${name}.md`);
			const open = vscode.workspace.textDocuments.find(doc => doc.uri.toString() === source.toString());
			const content = open ? encoder.encode(open.getText()) : await vscode.workspace.fs.readFile(source);
			await vscode.workspace.fs.writeFile(target, content);
			const show = vscode.l10n.t('Open Team Copy');
			if (await vscode.window.showInformationMessage(vscode.l10n.t('Copied {0} to {1}.', name, team.name), show) === show) {
				await vscode.window.showTextDocument(target);
			}
		}),
	);
}

/**
 * Handles `nighthawk://vscode.nighthawk-notes/join?server=...&code=...`,
 * the link on a notes server's invite page.
 */
export class InviteUriHandler implements vscode.UriHandler {
	handleUri(uri: vscode.Uri): void {
		if (uri.path === '/join') {
			const params = new URLSearchParams(uri.query);
			const code = params.get('code');
			if (code) {
				vscode.commands.executeCommand('nighthawk.notes.teams.join', { code, server: params.get('server') ?? undefined });
			}
		}
	}
}

/** The addresses in what a person typed or pasted, such as "Ada <ada@example.com>, grace@example.com". */
function emailList(text: string): string[] {
	const emails = text.split(/[\s,;]+/).map(part => part.replace(/^<|>$/g, '').trim()).filter(part => part.includes('@'));
	return [...new Set(emails.map(email => email.toLowerCase()))];
}
