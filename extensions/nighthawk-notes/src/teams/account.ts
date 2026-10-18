/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { config } from '../vault';
import { NotesClient, NotesServerError, type User } from './client';

const DEFAULT_SERVER = 'http://localhost:8787';

/**
 * The signed-in account on the configured notes server. The session token
 * is kept in the OS keychain through SecretStorage, never in settings.
 */
export class Account implements vscode.Disposable {

	private _user: User | undefined;
	private _client: NotesClient;
	private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
	readonly onDidChange = this.onDidChangeEmitter.event;
	private readonly disposables: vscode.Disposable[] = [];

	constructor(private readonly context: vscode.ExtensionContext) {
		this._client = new NotesClient(Account.serverUrl());
		this.disposables.push(
			vscode.workspace.onDidChangeConfiguration(e => {
				if (e.affectsConfiguration('nighthawk.notes.server.url')) {
					this.restore();
				}
			}),
			context.secrets.onDidChange(e => {
				if (e.key === this.secretKey()) {
					this.restore();
				}
			}),
		);
	}

	static serverUrl(): string {
		return (config().get<string>('server.url', DEFAULT_SERVER).trim() || DEFAULT_SERVER).replace(/\/+$/, '');
	}

	get user(): User | undefined {
		return this._user;
	}

	get client(): NotesClient {
		return this._client;
	}

	dispose(): void {
		this.disposables.forEach(d => d.dispose());
		this.onDidChangeEmitter.dispose();
	}

	private secretKey(server = Account.serverUrl()): string {
		return `nighthawk.notes.token:${server}`;
	}

	/** Picks up a stored session for the configured server, if there is one. */
	async restore(): Promise<void> {
		const server = Account.serverUrl();
		const token = await this.context.secrets.get(this.secretKey(server));
		this._client = new NotesClient(server, token);
		this._user = undefined;
		if (token) {
			try {
				this._user = (await this._client.me()).user;
			} catch (err) {
				if (err instanceof NotesServerError && err.status === 401) {
					// Expired or revoked session.
					await this.context.secrets.delete(this.secretKey(server));
					this._client = new NotesClient(server);
				} else {
					// Server unreachable: stay signed in with what we know so a
					// temporary outage does not log people out.
					this._user = this.context.globalState.get<User>(this.secretKey(server));
				}
			}
		}
		await this.updateContext();
	}

	async signIn(email: string, password: string): Promise<User> {
		const result = await new NotesClient(Account.serverUrl()).login(email, password);
		await this.store(result.token, result.user);
		return result.user;
	}

	async register(email: string, name: string, password: string): Promise<User> {
		const result = await new NotesClient(Account.serverUrl()).register(email, name, password);
		await this.store(result.token, result.user);
		return result.user;
	}

	async signOut(): Promise<void> {
		try {
			await this._client.logout();
		} catch {
			// The session is forgotten locally either way.
		}
		await this.context.secrets.delete(this.secretKey());
		await this.context.globalState.update(this.secretKey(), undefined);
		this._client = new NotesClient(Account.serverUrl());
		this._user = undefined;
		await this.updateContext();
	}

	private async store(token: string, user: User): Promise<void> {
		const server = Account.serverUrl();
		await this.context.secrets.store(this.secretKey(server), token);
		await this.context.globalState.update(this.secretKey(server), user);
		this._client = new NotesClient(server, token);
		this._user = user;
		await this.updateContext();
	}

	private async updateContext(): Promise<void> {
		await vscode.commands.executeCommand('setContext', 'nighthawk.notes.signedIn', !!this._user);
		this.onDidChangeEmitter.fire();
	}
}
