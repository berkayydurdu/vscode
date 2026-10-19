/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { access } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { mergeHookConfigs, type HookConfig } from '../core/hooks';
import { parseRule, type Rule } from '../core/permissions';
import { loadAgents, loadCommands, loadInstructions, loadSettingsFiles, loadSkills, type AgentDefinition, type Command, type InstructionFile, type Locations, type Skill } from '../core/skills';

/** Everything the agent reads from the user's and the project's config files. */
export interface Project {
	locations: Locations;
	instructions: InstructionFile[];
	skills: Skill[];
	commands: Command[];
	agents: AgentDefinition[];
	hooks: HookConfig;
	allow: Rule[];
	deny: Rule[];
}

export function locations(): Locations {
	return {
		roots: (vscode.workspace.workspaceFolders ?? []).filter(f => f.uri.scheme === 'file').map(f => f.uri.fsPath),
		home: os.homedir(),
		trusted: vscode.workspace.isTrusted,
	};
}

function rules(values: unknown): Rule[] {
	return Array.isArray(values) ? values.map(v => parseRule(String(v))).filter((r): r is Rule => !!r) : [];
}

export async function loadProject(): Promise<Project> {
	const loc = locations();
	const config = vscode.workspace.getConfiguration('nighthawk.agent');
	const [instructions, skills, commands, agents, settingsFiles] = await Promise.all([
		loadInstructions(loc), loadSkills(loc), loadCommands(loc), loadAgents(loc), loadSettingsFiles(loc),
	]);
	const allow = rules(config.get('permissions.allow'));
	const deny = rules(config.get('permissions.deny'));
	for (const { json } of settingsFiles) {
		const permissions = json.permissions as { allow?: unknown; deny?: unknown } | undefined;
		allow.push(...rules(permissions?.allow));
		deny.push(...rules(permissions?.deny));
	}
	const hooks = mergeHookConfigs([config.get('hooks'), ...settingsFiles.map(f => f.json.hooks)]);
	return { locations: loc, instructions, skills, commands, agents, hooks, allow, deny };
}

/** The ripgrep binary that ships with the editor. */
export async function findRipgrep(): Promise<string | undefined> {
	const exe = process.platform === 'win32' ? 'rg.exe' : 'rg';
	const candidates = [
		path.join(vscode.env.appRoot, 'node_modules', '@vscode', 'ripgrep', 'bin', exe),
		path.join(vscode.env.appRoot, 'node_modules.asar.unpacked', '@vscode', 'ripgrep', 'bin', exe),
	];
	for (const candidate of candidates) {
		try {
			await access(candidate);
			return candidate;
		} catch {
			// Try the next location.
		}
	}
	return undefined;
}
