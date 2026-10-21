/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Spec mode: before building something, the agent writes what it must do
// (requirements), how (design) and the steps (tasks), each approved by the
// user, then works through the tasks one at a time.

/** Where specs live, relative to the workspace folder. */
export const SPECS_DIR = '.nighthawk/specs';

export type SpecPhase = 'requirements' | 'design' | 'tasks';
export const SPEC_PHASES: SpecPhase[] = ['requirements', 'design', 'tasks'];

/** spec.json in a spec's folder. */
export interface SpecState {
	title: string;
	/** What the user asked for, in their words. */
	request: string;
	created: number;
	/** When each document was approved. */
	approved: Partial<Record<SpecPhase, number>>;
	/** The conversation working on the spec. */
	chat?: string;
}

export function specFile(phase: SpecPhase): string {
	return `${phase}.md`;
}

export function phaseOf(fileName: string): SpecPhase | undefined {
	const name = fileName.replace(/\\/g, '/').split('/').pop()?.toLowerCase();
	return SPEC_PHASES.find(phase => specFile(phase) === name);
}

/** A folder name for a spec: lower case words joined by dashes. */
export function specSlug(title: string): string {
	const slug = title.toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().split(/[\s_-]+/).filter(Boolean).slice(0, 6).join('-');
	return slug.slice(0, 48).replace(/-+$/, '') || 'spec';
}

/** The first document not approved yet, or undefined when all three are. */
export function currentPhase(state: SpecState): SpecPhase | undefined {
	return SPEC_PHASES.find(phase => !state.approved[phase]);
}

export function parseSpecState(text: string): SpecState | undefined {
	try {
		const value = JSON.parse(text) as Partial<SpecState>;
		if (typeof value.title !== 'string') {
			return undefined;
		}
		const approved: SpecState['approved'] = {};
		for (const phase of SPEC_PHASES) {
			const at = value.approved?.[phase];
			if (typeof at === 'number') {
				approved[phase] = at;
			}
		}
		return {
			title: value.title,
			request: typeof value.request === 'string' ? value.request : value.title,
			created: typeof value.created === 'number' ? value.created : 0,
			approved,
			chat: typeof value.chat === 'string' ? value.chat : undefined,
		};
	} catch {
		return undefined;
	}
}

export interface SpecTask {
	/** Zero-based line in tasks.md. */
	line: number;
	/** The task's number as written, like `2` or `2.1`; else its position. */
	number: string;
	title: string;
	done: boolean;
	/** Nesting: 0 for a top-level task. */
	depth: number;
}

/** The checklist items in tasks.md, in order. */
export function parseTasks(markdown: string): SpecTask[] {
	const tasks: SpecTask[] = [];
	let fence = false;
	markdown.split(/\r?\n/).forEach((text, line) => {
		if (/^\s*(```|~~~)/.test(text)) {
			fence = !fence;
			return;
		}
		const match = fence ? null : /^(\s*)[-*+]\s+\[([ xX])\]\s+(?:(\d+(?:\.\d+)*)\.?\s+)?(.+?)\s*$/.exec(text);
		if (!match) {
			return;
		}
		const indent = match[1].replace(/\t/g, '  ').length;
		tasks.push({
			line,
			number: match[3] ?? String(tasks.filter(t => t.depth === 0).length + 1),
			title: match[4].replace(/\*\*/g, ''),
			done: match[2] !== ' ',
			depth: Math.floor(indent / 2),
		});
	});
	return tasks;
}

/** The tasks still to do that have no unfinished sub-tasks of their own: the ones to work on. */
export function openTasks(tasks: SpecTask[]): SpecTask[] {
	return tasks.filter((task, i) => {
		if (task.done) {
			return false;
		}
		const next = tasks[i + 1];
		return !next || next.depth <= task.depth;
	});
}

export interface SpecInfo {
	/** The spec's folder, relative to the workspace folder, with forward slashes. */
	dir: string;
	state: SpecState;
}

function files(spec: SpecInfo, phases: SpecPhase[]): string {
	return phases.map(phase => `@${spec.dir}/${specFile(phase)}`).join(', ');
}

const REQUIREMENTS = [
	'Write requirements.md in this form:',
	'# Requirements: <title>',
	'A short introduction: the problem, who it is for, and what is out of scope.',
	'Then numbered requirements. Each has a user story ("As a <role>, I want <feature>, so that <benefit>") and numbered acceptance criteria written as "WHEN <event> THEN the system SHALL <response>" (or "IF <condition> THEN ... SHALL ..."). Cover edge cases and errors.',
].join('\n');

const DESIGN = [
	'Write design.md: overview, architecture (a Mermaid diagram when it helps), the components and interfaces with the files they live in, data models, error handling and the testing strategy. Refer to requirements by number.',
	'Base it on the code as it is: read and search the codebase first, and follow its existing patterns and libraries.',
].join('\n');

const TASKS = [
	'Write tasks.md: a numbered checklist of coding steps that build the design incrementally, each small enough for one focused session and testable on its own, in an order where every step builds on the ones before.',
	'Use "- [ ] 1. Title" with up to one level of sub-tasks ("  - [ ] 1.1 Title"). Under each task, add short bullets with the details and the requirements it covers ("_Requirements: 1.2, 3.1_"). Only coding and testing steps: no deployment, user testing or other work outside the editor.',
].join('\n');

/** The prompt that has the agent write one of the spec's documents. */
export function phasePrompt(spec: SpecInfo, phase: SpecPhase): string {
	const intro = phase === 'requirements'
		? [
			`We are starting a spec for this request:\n\n${spec.state.request}`,
			'',
			`Work in spec mode: first requirements, then a design, then tasks, each approved by me before the next. Only files in ${spec.dir}/ can change until the tasks are approved; do not write code yet.`,
			'Research the codebase as much as you need to understand the request. If something essential is unclear, make a reasonable assumption and list it under "Open questions" at the end of the document.',
		]
		: [
			`I approved ${phase === 'design' ? files(spec, ['requirements']) : files(spec, ['requirements', 'design'])} for the spec "${spec.state.title}". Read ${phase === 'design' ? 'it' : 'them'} again, as I may have edited ${phase === 'design' ? 'it' : 'them'}.`,
		];
	return [
		...intro,
		'',
		phase === 'requirements' ? REQUIREMENTS : phase === 'design' ? DESIGN : TASKS,
		'',
		`Save it as ${spec.dir}/${specFile(phase)}, then stop and ask me to review it. Keep your reply short: what the document covers and anything you want me to decide.`,
	].join('\n');
}

/** The prompt that has the agent revise a document after feedback. */
export function revisePrompt(spec: SpecInfo, phase: SpecPhase, feedback: string): string {
	return [
		`Revise ${files(spec, [phase])} for the spec "${spec.state.title}" with this feedback:`,
		'',
		feedback,
		'',
		'Read it again first, as I may have edited it. Then stop and ask me to review it again.',
	].join('\n');
}

/** The prompt that has the agent do one task, or all open ones when `task` is undefined. */
export function taskPrompt(spec: SpecInfo, task: SpecTask | undefined): string {
	return [
		task
			? `Implement task ${task.number} of the spec "${spec.state.title}": ${task.title}`
			: `Implement the open tasks of the spec "${spec.state.title}", in order.`,
		'',
		`Read ${files(spec, ['requirements', 'design', 'tasks'])} first. Follow the design and check the work against the requirements the task lists.`,
		task
			? 'Do only this task: no work on later tasks. When it is done and checked (build, type check or tests where the project has them), mark it done in tasks.md by changing its "- [ ]" to "- [x]", and its parent task too once all its sub-tasks are done.'
			: 'Work through the tasks one at a time. After each, check it (build, type check or tests where the project has them) and mark it done in tasks.md by changing its "- [ ]" to "- [x]" before starting the next. Stop and ask me if a task cannot be done as designed.',
		'Then say briefly what changed.',
	].join('\n');
}

/** The text that starts a spec, shown in the chat in place of the full prompt. */
export function shownRequest(title: string): string {
	return `/spec ${title}`;
}

/** A short title from a request: its first line or sentence. */
export function titleFrom(request: string): string {
	const first = request.trim().split(/\r?\n/)[0].split(/(?<=[.!?])\s/)[0].trim();
	return first.length > 60 ? `${first.slice(0, 57).replace(/\s+\S*$/, '')}...` : first;
}
