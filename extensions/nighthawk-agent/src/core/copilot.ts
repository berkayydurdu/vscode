/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// GitHub Copilot as a model provider. The user signs in to GitHub with the
// device flow; the GitHub token is exchanged for a short-lived Copilot token,
// which calls Copilot's OpenAI-compatible chat API. The endpoint's baseUrl is
// the GitHub API (https://api.github.com, or a GitHub Enterprise one); the chat
// API's URL comes from the token response.

import { readError } from './anthropic';
import { streamOpenAI } from './openai';
import { ProviderError, type ChatRequest, type Endpoint, type Message, type StreamEvent } from './types';

/** The OAuth app Copilot's editor plugins sign in with; the token exchange accepts only its tokens. */
export const COPILOT_CLIENT_ID = 'Iv1.b507a08c87ecfe98';
export const GITHUB_API_URL = 'https://api.github.com';

const EDITOR_HEADERS: Record<string, string> = {
	'editor-version': 'Nighthawk/1.0',
	'editor-plugin-version': 'nighthawk-agent/1.0',
	'copilot-integration-id': 'vscode-chat',
	'user-agent': 'Nighthawk',
};

function trimSlash(url: string): string {
	return url.replace(/\/+$/, '');
}

/** The GitHub web URL that serves the device flow, for a GitHub API URL. */
export function githubWebUrl(apiUrl: string): string {
	const url = new URL(apiUrl);
	if (url.hostname.startsWith('api.')) {
		url.hostname = url.hostname.slice(4);
	}
	return `${url.protocol}//${url.host}`;
}

export interface DeviceCode {
	deviceCode: string;
	userCode: string;
	verificationUri: string;
	/** Seconds between polls. */
	interval: number;
	/** Seconds until the code expires. */
	expiresIn: number;
}

async function postForm(url: string, form: Record<string, string>, signal?: AbortSignal): Promise<Record<string, unknown>> {
	let response: Response;
	try {
		response = await fetch(url, {
			method: 'POST',
			headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded', 'user-agent': EDITOR_HEADERS['user-agent'] },
			body: new URLSearchParams(form).toString(),
			signal,
		});
	} catch (err) {
		if (signal?.aborted) {
			throw err;
		}
		throw new ProviderError(`Could not reach GitHub: ${err.cause?.message ?? err.message}`, 0, true);
	}
	if (!response.ok) {
		throw await readError(response);
	}
	return await response.json() as Record<string, unknown>;
}

/** Starts a GitHub sign-in: the user enters `userCode` at `verificationUri`. */
export async function requestDeviceCode(apiUrl: string, signal?: AbortSignal): Promise<DeviceCode> {
	const json = await postForm(`${githubWebUrl(apiUrl)}/login/device/code`, { client_id: COPILOT_CLIENT_ID, scope: 'read:user' }, signal);
	if (typeof json.device_code !== 'string' || typeof json.user_code !== 'string' || typeof json.verification_uri !== 'string') {
		throw new ProviderError('GitHub did not start the sign-in.');
	}
	return {
		deviceCode: json.device_code,
		userCode: json.user_code,
		verificationUri: json.verification_uri,
		interval: typeof json.interval === 'number' ? json.interval : 5,
		expiresIn: typeof json.expires_in === 'number' ? json.expires_in : 900,
	};
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener('abort', () => {
			clearTimeout(timer);
			reject(signal.reason ?? new Error('Aborted'));
		}, { once: true });
	});
}

/** Waits until the user approves the sign-in and returns the GitHub token. */
export async function pollDeviceToken(apiUrl: string, code: DeviceCode, signal?: AbortSignal, sleep = defaultSleep): Promise<string> {
	const deadline = Date.now() + code.expiresIn * 1000;
	let interval = code.interval;
	while (Date.now() < deadline) {
		await sleep(interval * 1000, signal);
		const json = await postForm(`${githubWebUrl(apiUrl)}/login/oauth/access_token`, {
			client_id: COPILOT_CLIENT_ID,
			device_code: code.deviceCode,
			grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
		}, signal);
		if (typeof json.access_token === 'string' && json.access_token) {
			return json.access_token;
		}
		if (json.error === 'authorization_pending') {
			continue;
		}
		if (json.error === 'slow_down') {
			interval = typeof json.interval === 'number' ? json.interval : interval + 5;
			continue;
		}
		if (json.error === 'access_denied') {
			throw new ProviderError('The GitHub sign-in was cancelled.');
		}
		if (json.error === 'expired_token') {
			break;
		}
		throw new ProviderError(`GitHub sign-in failed: ${String(json.error_description ?? json.error ?? 'unknown error')}`);
	}
	throw new ProviderError('The GitHub sign-in code expired. Try again.');
}

export interface CopilotSession {
	token: string;
	/** Copilot's chat API, such as https://api.githubcopilot.com. */
	apiUrl: string;
	/** Milliseconds since the epoch. */
	expiresAt: number;
}

const sessions = new Map<string, Promise<CopilotSession>>();

function isLoopback(url: URL): boolean {
	return url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]';
}

async function fetchSession(apiUrl: string, githubToken: string, signal?: AbortSignal): Promise<CopilotSession> {
	let response: Response;
	try {
		response = await fetch(`${trimSlash(apiUrl)}/copilot_internal/v2/token`, {
			headers: { ...EDITOR_HEADERS, accept: 'application/json', authorization: `token ${githubToken}` },
			signal,
		});
	} catch (err) {
		if (signal?.aborted) {
			throw err;
		}
		throw new ProviderError(`Could not reach GitHub: ${err.cause?.message ?? err.message}`, 0, true);
	}
	if (response.status === 401) {
		throw new ProviderError('Your GitHub sign-in for Copilot has expired. Run "AI: Sign In to GitHub Copilot" again.', 401);
	}
	if (response.status === 403 || response.status === 404) {
		throw new ProviderError('This GitHub account cannot use Copilot. Check that it has a Copilot plan (Copilot Free works) and that your organization allows Copilot in other editors.', response.status);
	}
	if (!response.ok) {
		throw await readError(response);
	}
	const json = await response.json() as { token?: unknown; expires_at?: unknown; endpoints?: { api?: unknown } };
	if (typeof json.token !== 'string') {
		throw new ProviderError('GitHub did not return a Copilot token.');
	}
	let chatUrl = 'https://api.githubcopilot.com';
	if (typeof json.endpoints?.api === 'string') {
		const parsed = new URL(json.endpoints.api);
		// The token only ever goes to https, or to a test server on this computer.
		if (parsed.protocol === 'https:' || (isLoopback(parsed) && isLoopback(new URL(apiUrl)))) {
			chatUrl = trimSlash(parsed.href);
		}
	}
	const expiresAt = typeof json.expires_at === 'number' ? json.expires_at * 1000 : Date.now() + 20 * 60_000;
	return { token: json.token, apiUrl: chatUrl, expiresAt };
}

/** A Copilot token for the GitHub token, reused until a minute before it expires. */
export async function copilotSession(apiUrl: string, githubToken: string, signal?: AbortSignal): Promise<CopilotSession> {
	const key = `${apiUrl}\n${githubToken}`;
	const cached = sessions.get(key);
	if (cached) {
		const session = await cached.catch(() => undefined);
		if (session && session.expiresAt - 60_000 > Date.now()) {
			return session;
		}
	}
	const pending = fetchSession(apiUrl, githubToken, signal);
	sessions.set(key, pending);
	pending.catch(() => sessions.delete(key));
	return pending;
}

function forgetSession(apiUrl: string, githubToken: string): void {
	sessions.delete(`${apiUrl}\n${githubToken}`);
}

/** Who started the request: Copilot counts premium requests only for the user's own messages, not tool follow-ups. */
export function initiator(messages: Message[]): 'user' | 'agent' {
	const last = messages[messages.length - 1];
	if (!last || last.role !== 'user') {
		return 'agent';
	}
	return last.content.some(p => p.type === 'tool_result') ? 'agent' : 'user';
}

function chatEndpoint(endpoint: Endpoint, session: CopilotSession, request?: ChatRequest): Endpoint {
	const headers: Record<string, string> = { ...EDITOR_HEADERS, 'openai-intent': 'conversation-edits' };
	if (request) {
		headers['x-initiator'] = initiator(request.messages);
		if (request.messages.some(m => m.content.some(p => p.type === 'image' || p.type === 'tool_result' && p.images?.length))) {
			headers['copilot-vision-request'] = 'true';
		}
	}
	return { ...endpoint, provider: 'openai', baseUrl: session.apiUrl, headers: { ...headers, ...endpoint.headers } };
}

function needsGithubToken(githubToken: string | undefined): string {
	if (!githubToken) {
		throw new ProviderError('Sign in to GitHub Copilot first: run "AI: Sign In to GitHub Copilot".', 401);
	}
	return githubToken;
}

export async function* streamCopilot(endpoint: Endpoint, model: string, githubToken: string | undefined, request: ChatRequest, signal: AbortSignal): AsyncGenerator<StreamEvent> {
	const token = needsGithubToken(githubToken);
	for (let attempt = 0; ; attempt++) {
		const session = await copilotSession(endpoint.baseUrl, token, signal);
		let started = false;
		try {
			for await (const event of streamOpenAI(chatEndpoint(endpoint, session, request), model, session.token, request, signal)) {
				started = true;
				yield event;
			}
			return;
		} catch (err) {
			// The Copilot token can be revoked before it expires; get a new one once.
			if (attempt === 0 && !started && err instanceof ProviderError && err.status === 401) {
				forgetSession(endpoint.baseUrl, token);
				continue;
			}
			throw err;
		}
	}
}

interface CopilotModel {
	id?: unknown;
	model_picker_enabled?: unknown;
	capabilities?: { type?: unknown };
	supported_endpoints?: unknown;
	policy?: { state?: unknown };
}

/** The chat models the user can pick in Copilot, as Copilot's own model picker shows them. */
export function chatModels(data: CopilotModel[]): string[] {
	const ids = data.filter(m => typeof m.id === 'string'
		&& m.model_picker_enabled !== false
		&& (m.capabilities?.type === undefined || m.capabilities.type === 'chat')
		&& m.policy?.state !== 'disabled'
		// Models that only speak the Responses API, such as the Codex ones, are left out.
		&& (!Array.isArray(m.supported_endpoints) || m.supported_endpoints.includes('/chat/completions')))
		.map(m => m.id as string);
	return [...new Set(ids)].sort();
}

export async function listCopilotModels(endpoint: Endpoint, githubToken: string | undefined, signal?: AbortSignal): Promise<string[]> {
	const session = await copilotSession(endpoint.baseUrl, needsGithubToken(githubToken), signal);
	const chat = chatEndpoint(endpoint, session);
	const response = await fetch(`${session.apiUrl}/models`, { headers: { ...chat.headers, authorization: `Bearer ${session.token}` }, signal });
	if (!response.ok) {
		throw await readError(response);
	}
	const json = await response.json() as { data?: CopilotModel[] };
	return chatModels(json.data ?? []);
}
