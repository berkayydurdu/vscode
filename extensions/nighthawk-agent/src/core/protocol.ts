/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Types shared by the extension and the agent page. Types only: the page
// bundles this file too, so it must not import anything that needs Node.

/** The files of every folder the agent works in at one moment: a snapshot per folder. */
export interface Checkpoint {
	at: number;
	refs: { root: string; commit: string }[];
}

export interface DiffLine {
	kind: ' ' | '+' | '-';
	text: string;
	/** Line number in the old file for ' ' and '-', in the new file for '+'. */
	line: number;
}

export interface Hunk {
	oldStart: number;
	newStart: number;
	lines: DiffLine[];
}

export interface LineDiff {
	added: number;
	removed: number;
	hunks: Hunk[];
}

export type ToolDisplay =
	/** `before` and `after` stay in the extension, for the diff editor. */
	| { kind: 'diff'; path: string; diff: LineDiff; created?: boolean; before?: string; after?: string }
	| { kind: 'output'; text: string; exitCode?: number | null }
	| { kind: 'text'; text: string }
	| { kind: 'files'; files: string[] };

export interface Question {
	question: string;
	header?: string;
	options: { label: string; description?: string }[];
	multiSelect?: boolean;
}

export interface Todo {
	content: string;
	status: 'pending' | 'in_progress' | 'completed';
	activeForm?: string;
}

export type ItemStatus = 'running' | 'awaiting' | 'done' | 'error' | 'denied';

export type TranscriptItem =
	| {
		kind: 'user'; id: string; text: string; queued?: boolean;
		/** The conversation can go back to before this message. */
		canRewind?: boolean;
		/** The files as they were when the message was sent. */
		checkpoint?: Checkpoint;
	}
	| { kind: 'assistant'; id: string; text: string }
	| { kind: 'thinking'; id: string; text: string; done?: boolean }
	| {
		kind: 'tool'; id: string; name: string; title: string; status: ItemStatus;
		/** The command, path or arguments, for the expanded card. */
		detail?: string;
		summary?: string;
		output?: string;
		display?: ToolDisplay;
		/** Set while the call waits for the user's approval. */
		approval?: { always: string; outside?: boolean };
		/** The Task call this one runs under. */
		parent?: string;
		canOpenDiff?: boolean;
	}
	| { kind: 'question'; id: string; questions: Question[]; answer?: string }
	| { kind: 'plan'; id: string; text: string; status: 'awaiting' | 'approved' | 'rejected' }
	| { kind: 'notice'; id: string; level: 'info' | 'warning' | 'error'; text: string; actions?: { label: string; action: string }[] }
	| { kind: 'compacted'; id: string; summary: string };

export type PermissionModeId = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions';

export interface SlashCommandInfo {
	name: string;
	description: string;
	hint?: string;
}

export interface ViewState {
	configured: boolean;
	model?: string;
	mode: PermissionModeId;
	running: boolean;
	/** Share of the context window in use, 0 to 1. */
	context?: number;
	tokens?: number;
	/** US dollars this conversation has cost so far. */
	cost?: number;
	todos: Todo[];
	commands: SlashCommandInfo[];
	queued: number;
	title: string;
	/** Absent for an untitled, empty conversation. */
	sessionId?: string;
}

export interface SessionSummary {
	id: string;
	title: string;
	updated: number;
}

export interface MentionResult {
	label: string;
	detail?: string;
	insert: string;
}

export type HostMessage =
	| { type: 'init'; l10n?: Record<string, string>; state: ViewState; items: TranscriptItem[] }
	| { type: 'state'; state: ViewState }
	| { type: 'items'; items: TranscriptItem[] }
	| { type: 'upsert'; item: TranscriptItem }
	| { type: 'append'; id: string; field: 'text' | 'output'; text: string }
	| { type: 'sessions'; sessions: SessionSummary[] }
	| { type: 'mentions'; requestId: number; results: MentionResult[] }
	| { type: 'prefill'; text: string; append?: boolean }
	| { type: 'focus' };

export type PageMessage =
	| { type: 'ready' }
	| { type: 'send'; text: string }
	| { type: 'stop' }
	| { type: 'approve'; id: string; decision: 'allow' | 'always' | 'deny'; feedback?: string }
	| { type: 'answer'; id: string; answer: string }
	| { type: 'plan'; id: string; approve: boolean; mode?: PermissionModeId }
	| { type: 'setMode'; mode: PermissionModeId }
	| { type: 'pickModel' }
	| { type: 'newSession' }
	| { type: 'history' }
	| { type: 'openSession'; id: string }
	| { type: 'deleteSession'; id: string }
	| { type: 'mention'; requestId: number; query: string }
	| { type: 'openFile'; path: string; line?: number }
	| { type: 'openDiff'; id: string }
	| { type: 'rewind'; id: string }
	| { type: 'action'; action: string };
