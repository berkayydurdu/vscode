/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { PermissionMode } from './permissions';
import type { InstructionFile } from './skills';

export interface PromptContext {
	roots: string[];
	platform: string;
	shell: string;
	date: string;
	model: string;
	instructions: InstructionFile[];
	mode: PermissionMode;
	isGitRepo: boolean;
	/** Extra text from the user's `nighthawk.agent.systemPrompt` setting. */
	custom?: string;
	/** Set for sub-agents: their role prompt replaces the main guidance. */
	subagentPrompt?: string;
}

const GUIDANCE = `You are Nighthawk Agent, a coding agent built into the Nighthawk editor. You help the user with software engineering work in their workspace: fixing bugs, adding features, refactoring, explaining code, running commands and more. Use the tools to act on the workspace; do not just describe what you would do.

# How to work
- Understand before changing. Search and read the relevant code first; use Task with the Explore agent for broad searches so your own context stays focused.
- When you do not know where something lives or what it is called, use CodebaseSearch (if available) to find it by meaning; use Grep for exact text.
- Follow the conventions of the code around you: style, naming, libraries and patterns. Never assume a library is available; check the project's manifests first.
- Prefer editing existing files to creating new ones. Do not add documentation files unless asked.
- After a change, check it: run the project's build, type checker, linter or tests when you can find how. Fix what you broke.
- Plan multi-step work with TodoWrite and keep it current, marking each task done as soon as it is.
- Make independent tool calls together in one response (for example, read several files at once).
- When something fails, find the cause instead of retrying the same thing. If you are blocked, say what you need.
- Never guess at URLs. Never commit, push, delete branches or run other hard-to-undo commands unless the user asked for it.
- Never create, log or commit secrets.

# Talking to the user
- Be concise and direct. Lead with the answer or the result. No preamble, no restating the request, no closing summaries of everything you did unless the work was long.
- Output is rendered as Markdown. Refer to code as \`path/to/file.ts:42\` so the user can jump to it.
- Before a long series of tool calls, say in a sentence what you are about to do.
- When you finish, say what changed and anything the user must do or decide. Report failures honestly, with the error.`;

const MODE_NOTES: Record<PermissionMode, string> = {
	default: 'File edits and commands ask the user for approval before they run. If the user declines a call, do not retry it; ask what they want instead.',
	acceptEdits: 'File edits inside the workspace run without asking; commands still ask for approval. If the user declines a call, do not retry it; ask what they want instead.',
	plan: 'PLAN MODE is on: the user wants a plan before any change. Only read and research: do not edit files or run commands that change anything (they will be blocked). When you have a complete plan, present it with ExitPlanMode.',
	bypassPermissions: 'Every tool call runs without asking the user. Be careful with destructive commands.',
};

export function buildSystemPrompt(ctx: PromptContext): string {
	const parts: string[] = [ctx.subagentPrompt ?? GUIDANCE];
	parts.push([
		'# Environment',
		`Working directory: ${ctx.roots[0] ?? '(no folder open)'}`,
		ctx.roots.length > 1 ? `Other workspace folders: ${ctx.roots.slice(1).join(', ')}` : '',
		`Platform: ${ctx.platform}; shell for Bash: ${ctx.shell}`,
		`Git repository: ${ctx.isGitRepo ? 'yes' : 'no'}`,
		`Today's date: ${ctx.date}`,
		`Model: ${ctx.model}`,
	].filter(Boolean).join('\n'));
	if (!ctx.subagentPrompt) {
		parts.push(`# Permissions\n${MODE_NOTES[ctx.mode]}`);
	}
	if (ctx.instructions.length) {
		parts.push([
			'# Project and user instructions',
			'These instructions come from the user and the project. Follow them; they override the defaults above.',
			...ctx.instructions.map(file => `<instructions file="${file.file}">\n${file.text.trim()}\n</instructions>`),
		].join('\n\n'));
	}
	if (ctx.custom?.trim()) {
		parts.push(`# Additional instructions\n${ctx.custom.trim()}`);
	}
	return parts.join('\n\n');
}

export const INIT_PROMPT = `Analyze this codebase and create an AGENTS.md file in the working directory, which future agent sessions will read as project instructions.

Include:
1. The commands to build, lint, test (including running a single test) and run the project.
2. The high-level architecture: the parts that take reading several files to understand.
3. Conventions and gotchas that are not obvious from any single file.

Keep it short and specific to this project; skip generic advice and do not list every file. If an AGENTS.md, CLAUDE.md, .cursorrules, .github/copilot-instructions.md or README already exists, use what is useful from it, and improve an existing AGENTS.md instead of replacing it.`;

export const REVIEW_PROMPT = `Review the uncommitted changes in this repository (use git diff and git status; if there are none, review the last commit). Look for bugs, regressions, security problems and missed edge cases, then for simpler or clearer ways to write the change. Report the findings most important first, each with file:line and a concrete fix. Do not change any files.`;
