/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Account } from '../teams/account';
import { ROLE_RANK, type Invite, type Member, type Team } from '../teams/client';
import { TeamFileSystem, teamNoteUri } from '../teams/teamFileSystem';

export type TeamNode =
	| { kind: 'team'; team: Team }
	| { kind: 'workspace'; team: Team }
	| { kind: 'notes'; team: Team }
	| { kind: 'entry'; team: Team; uri: vscode.Uri; isFolder: boolean }
	| { kind: 'members'; team: Team }
	| { kind: 'member'; team: Team; member: Member; isMe: boolean }
	| { kind: 'invites'; team: Team }
	| { kind: 'invite'; team: Team; invite: Invite };

/**
 * Teams the signed-in person belongs to, each with its shared notes, its
 * members and, for admins, its open invites.
 */
export class TeamsTreeProvider implements vscode.TreeDataProvider<TeamNode>, vscode.Disposable {

	private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<TeamNode | void>();
	readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;
	private readonly disposables: vscode.Disposable[] = [];
	view: vscode.TreeView<TeamNode> | undefined;

	constructor(private readonly account: Account, private readonly fs: TeamFileSystem) {
		this.disposables.push(
			fs.onDidChangeTeams(() => this.refresh()),
			account.onDidChange(() => this.refresh()),
		);
	}

	dispose(): void {
		this.disposables.forEach(d => d.dispose());
		this.onDidChangeTreeDataEmitter.dispose();
	}

	refresh(): void {
		if (this.view) {
			this.view.description = this.account.user ? this.account.user.name : undefined;
		}
		this.onDidChangeTreeDataEmitter.fire();
	}

	async getChildren(element?: TeamNode): Promise<TeamNode[]> {
		if (!this.account.user) {
			return [];
		}
		if (!element) {
			return this.fs.allTeams()
				.sort((a, b) => a.name.localeCompare(b.name))
				.map(team => ({ kind: 'team', team }));
		}
		const team = element.team;
		switch (element.kind) {
			case 'team': {
				const children: TeamNode[] = [{ kind: 'workspace', team }, { kind: 'notes', team }, { kind: 'members', team }];
				if (ROLE_RANK[team.role] >= ROLE_RANK.admin) {
					children.push({ kind: 'invites', team });
				}
				return children;
			}
			case 'notes':
				return this.entries(team, teamNoteUri(team.id));
			case 'entry':
				return element.isFolder ? this.entries(team, element.uri) : [];
			case 'members': {
				const { members } = await this.account.client.team(team.id);
				return members.map(member => ({ kind: 'member', team, member, isMe: member.userId === this.account.user?.id }));
			}
			case 'invites': {
				const invites = await this.account.client.invites(team.id);
				return invites.map(invite => ({ kind: 'invite', team, invite }));
			}
			default:
				return [];
		}
	}

	private async entries(team: Team, folder: vscode.Uri): Promise<TeamNode[]> {
		try {
			const entries = await this.fs.readDirectory(folder);
			return entries
				.sort(([a, aType], [b, bType]) => (bType & vscode.FileType.Directory) - (aType & vscode.FileType.Directory) || a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }))
				.map(([name, type]) => ({ kind: 'entry', team, uri: vscode.Uri.joinPath(folder, name), isFolder: !!(type & vscode.FileType.Directory) }));
		} catch (err) {
			vscode.window.showWarningMessage(vscode.l10n.t('Could not load notes for {0}: {1}', team.name, err.message));
			return [];
		}
	}

	getTreeItem(element: TeamNode): vscode.TreeItem {
		const canAdmin = ROLE_RANK[element.team.role] >= ROLE_RANK.admin;
		const canEdit = ROLE_RANK[element.team.role] >= ROLE_RANK.editor;
		switch (element.kind) {
			case 'team': {
				const item = new vscode.TreeItem(element.team.name, vscode.TreeItemCollapsibleState.Collapsed);
				item.id = `team/${element.team.id}`;
				item.iconPath = new vscode.ThemeIcon('organization');
				item.description = roleLabel(element.team.role);
				item.contextValue = `team role-${element.team.role}`;
				return item;
			}
			case 'workspace': {
				const item = new vscode.TreeItem(vscode.l10n.t('Workspace'), vscode.TreeItemCollapsibleState.None);
				item.id = `team/${element.team.id}/workspace`;
				item.iconPath = new vscode.ThemeIcon('project');
				item.description = vscode.l10n.t('Board, tickets, time, RFCs');
				item.contextValue = 'teamWorkspace';
				item.command = { command: 'nighthawk.notes.teams.openWorkspace', title: vscode.l10n.t('Open Team Workspace'), arguments: [element] };
				return item;
			}
			case 'notes': {
				const item = new vscode.TreeItem(vscode.l10n.t('Notes'), vscode.TreeItemCollapsibleState.Expanded);
				item.id = `team/${element.team.id}/notes`;
				item.iconPath = new vscode.ThemeIcon('notebook');
				item.description = String(this.fs.notesOf(element.team.id).length);
				item.contextValue = canEdit ? 'teamNotes editable' : 'teamNotes';
				return item;
			}
			case 'entry': {
				const item = new vscode.TreeItem(element.uri, element.isFolder ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
				item.id = element.uri.toString();
				if (element.isFolder) {
					item.contextValue = canEdit ? 'teamFolder editable' : 'teamFolder';
				} else {
					item.label = element.uri.path.split('/').pop()!.replace(/\.md$/i, '');
					item.contextValue = canEdit ? 'teamNote editable' : 'teamNote';
					item.command = { command: 'vscode.open', title: vscode.l10n.t('Open Note'), arguments: [element.uri] };
					const meta = this.fs.notesOf(element.team.id).find(n => element.uri.path === '/' + n.path);
					if (meta) {
						item.tooltip = vscode.l10n.t('Last edited by {0} on {1}', meta.updatedByName, new Date(meta.updatedAt).toLocaleString());
					}
				}
				return item;
			}
			case 'members': {
				const item = new vscode.TreeItem(vscode.l10n.t('Members'), vscode.TreeItemCollapsibleState.Collapsed);
				item.id = `team/${element.team.id}/members`;
				item.iconPath = new vscode.ThemeIcon('person');
				item.contextValue = canAdmin ? 'teamMembers admin' : 'teamMembers';
				return item;
			}
			case 'member': {
				const item = new vscode.TreeItem(element.member.name + (element.isMe ? ` ${vscode.l10n.t('(you)')}` : ''), vscode.TreeItemCollapsibleState.None);
				item.description = roleLabel(element.member.role);
				item.tooltip = `${element.member.email}\n${vscode.l10n.t('Joined {0}', new Date(element.member.joinedAt).toLocaleDateString())}`;
				item.iconPath = new vscode.ThemeIcon(element.member.role === 'owner' ? 'star-full' : 'account');
				// Admins manage others; only owners manage owners.
				const manageable = !element.isMe && canAdmin && (element.member.role !== 'owner' || element.team.role === 'owner');
				item.contextValue = manageable ? 'teamMember manageable' : 'teamMember';
				return item;
			}
			case 'invites': {
				const item = new vscode.TreeItem(vscode.l10n.t('Invites'), vscode.TreeItemCollapsibleState.Collapsed);
				item.id = `team/${element.team.id}/invites`;
				item.iconPath = new vscode.ThemeIcon('mail');
				item.contextValue = 'teamInvites';
				return item;
			}
			case 'invite': {
				const { invite } = element;
				const item = new vscode.TreeItem(invite.email ?? invite.code, vscode.TreeItemCollapsibleState.None);
				const uses = invite.email
					? vscode.l10n.t('emailed, not accepted yet')
					: invite.maxUses === null
						? vscode.l10n.t('{0} used', invite.uses)
						: vscode.l10n.t('{0} of {1} used', invite.uses, invite.maxUses);
				item.description = `${roleLabel(invite.role)} · ${uses}`;
				item.tooltip = invite.expiresAt
					? vscode.l10n.t('{0}\nExpires {1}', invite.url, new Date(invite.expiresAt).toLocaleString())
					: invite.url;
				item.iconPath = new vscode.ThemeIcon(invite.email ? 'mail' : 'link');
				item.contextValue = 'teamInvite';
				item.command = { command: 'nighthawk.notes.teams.copyInvite', title: vscode.l10n.t('Copy Invite Link'), arguments: [element] };
				return item;
			}
		}
	}
}

export function roleLabel(role: Team['role']): string {
	switch (role) {
		case 'owner': return vscode.l10n.t('Owner');
		case 'admin': return vscode.l10n.t('Admin');
		case 'editor': return vscode.l10n.t('Editor');
		default: return vscode.l10n.t('Viewer');
	}
}
