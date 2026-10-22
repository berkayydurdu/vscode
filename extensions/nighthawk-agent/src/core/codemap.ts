/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Code maps (as in Windsurf's Codemaps): the agent explores the code for a
// question such as "how does sign-in work?" and answers with a map: groups
// of code locations, each with a note, and arrows for how they connect. The
// editor shows it as a diagram and an outline whose entries open the code.

export interface MapItem {
	id: string;
	/** Path relative to the workspace folder, as the agent gave it. */
	file: string;
	/** 1-based. */
	line: number;
	endLine?: number;
	symbol?: string;
	note: string;
}

export interface MapSection {
	title: string;
	description?: string;
	items: MapItem[];
}

export interface MapEdge {
	from: string;
	to: string;
	label?: string;
}

export interface CodeMap {
	id: string;
	title: string;
	question: string;
	summary: string;
	created: number;
	sections: MapSection[];
	flow: MapEdge[];
}

export const MAX_ITEMS = 60;

/** The CodeMap tool's input schema. */
export const CODE_MAP_SCHEMA = {
	type: 'object',
	properties: {
		title: { type: 'string', description: 'A short title, e.g. "Sign-in flow".' },
		summary: { type: 'string', description: 'Two to four sentences answering the question at a high level.' },
		sections: {
			type: 'array',
			description: 'Groups of locations in the order a reader should follow, e.g. "Entry points", "Token check", "Session storage". Two to six sections.',
			items: {
				type: 'object',
				properties: {
					title: { type: 'string' },
					description: { type: 'string', description: 'One sentence on what this part does.' },
					items: {
						type: 'array',
						items: {
							type: 'object',
							properties: {
								id: { type: 'string', description: 'A short unique id to use in flow, e.g. "login".' },
								file: { type: 'string', description: 'Path relative to the workspace.' },
								line: { type: 'number', description: '1-based line where the code starts.' },
								endLine: { type: 'number' },
								symbol: { type: 'string', description: 'The function, class or variable, e.g. "AuthService.login".' },
								note: { type: 'string', description: 'One sentence on what happens here and why it matters for the question.' },
							},
							required: ['file', 'line', 'note'],
						},
					},
				},
				required: ['title', 'items'],
			},
		},
		flow: {
			type: 'array',
			description: 'How the items connect: calls, data flowing, events. Use the item ids.',
			items: {
				type: 'object',
				properties: {
					from: { type: 'string' },
					to: { type: 'string' },
					label: { type: 'string', description: 'A few words, e.g. "calls", "emits session".' },
				},
				required: ['from', 'to'],
			},
		},
	},
	required: ['title', 'summary', 'sections'],
	additionalProperties: false,
};

const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
const lineOf = (value: unknown): number | undefined => {
	const n = typeof value === 'number' ? value : typeof value === 'string' ? Number.parseInt(value, 10) : NaN;
	return Number.isFinite(n) && n >= 1 ? Math.floor(n) : undefined;
};

/**
 * Checks the agent's map against the code: locations in files that do not
 * exist, or past their end, are left out and listed, so the agent can fix
 * them. `lineCount` gives a workspace-relative file's lines, or undefined.
 */
export async function checkCodeMap(input: Record<string, unknown>, question: string, lineCount: (file: string) => Promise<number | undefined>): Promise<{ map: CodeMap; problems: string[] }> {
	const problems: string[] = [];
	const ids = new Set<string>();
	const sections: MapSection[] = [];
	let count = 0;
	const rawSections = Array.isArray(input.sections) ? input.sections : [];
	for (const [s, rawSection] of rawSections.entries()) {
		const section = (rawSection ?? {}) as Record<string, unknown>;
		const items: MapItem[] = [];
		for (const [i, rawItem] of (Array.isArray(section.items) ? section.items : []).entries()) {
			const item = (rawItem ?? {}) as Record<string, unknown>;
			const file = text(item.file).replace(/^\.\//, '');
			const line = lineOf(item.line);
			if (!file || !line) {
				problems.push(`An item in "${text(section.title)}" has no file or line.`);
				continue;
			}
			if (count >= MAX_ITEMS) {
				problems.push(`More than ${MAX_ITEMS} locations; the rest were left out.`);
				break;
			}
			const lines = await lineCount(file);
			if (lines === undefined) {
				problems.push(`${file} does not exist.`);
				continue;
			}
			if (line > lines) {
				problems.push(`${file}:${line} is past the end of the file (${lines} lines).`);
				continue;
			}
			let id = text(item.id) || `${s + 1}.${i + 1}`;
			while (ids.has(id)) {
				id += '*';
			}
			ids.add(id);
			const endLine = lineOf(item.endLine);
			items.push({
				id,
				file,
				line,
				endLine: endLine && endLine >= line ? Math.min(endLine, lines) : undefined,
				symbol: text(item.symbol) || undefined,
				note: text(item.note),
			});
			count++;
		}
		if (items.length) {
			sections.push({ title: text(section.title) || `Part ${s + 1}`, description: text(section.description) || undefined, items });
		}
	}
	const flow = (Array.isArray(input.flow) ? input.flow : []).flatMap(raw => {
		const edge = (raw ?? {}) as Record<string, unknown>;
		const from = text(edge.from);
		const to = text(edge.to);
		if (!ids.has(from) || !ids.has(to)) {
			if (from || to) {
				problems.push(`The arrow ${from || '?'} -> ${to || '?'} names an unknown item id.`);
			}
			return [];
		}
		return [{ from, to, label: text(edge.label) || undefined }];
	});
	return {
		map: { id: '', title: text(input.title) || question, question, summary: text(input.summary), created: Date.now(), sections, flow },
		problems,
	};
}

/** The map as Markdown, for copying into notes or a pull request. */
export function codeMapMarkdown(map: CodeMap): string {
	const out = [`# ${map.title}`, '', `> ${map.question}`, '', map.summary, ''];
	for (const section of map.sections) {
		out.push(`## ${section.title}`, '');
		if (section.description) {
			out.push(section.description, '');
		}
		for (const item of section.items) {
			const where = `${item.file}:${item.line}${item.endLine && item.endLine !== item.line ? `-${item.endLine}` : ''}`;
			out.push(`- ${item.symbol ? `\`${item.symbol}\` ` : ''}(${where}): ${item.note}`);
		}
		out.push('');
	}
	if (map.flow.length) {
		const names = new Map(map.sections.flatMap(s => s.items).map(i => [i.id, i.symbol ?? `${i.file}:${i.line}`]));
		out.push('## Flow', '', ...map.flow.map(e => `- ${names.get(e.from)} → ${names.get(e.to)}${e.label ? ` (${e.label})` : ''}`), '');
	}
	return out.join('\n');
}

/** What the agent is asked to do for "AI: New Code Map...". */
export function mapPrompt(question: string): string {
	return [
		`Make a code map that answers: ${question}`,
		'',
		'Explore the code with Read, Grep, Glob and CodebaseSearch until you understand it; do not change any files. Then call the CodeMap tool once with:',
		'- a short summary that answers the question,',
		'- two to six sections in the order a reader should follow (entry points first), each with the few locations that matter most (usually 2-6 per section, at most 40 in total), each with the exact line where the code starts and one sentence on what it does,',
		'- flow arrows between the items for calls, data and events.',
		'Only use locations you have read. After the map is shown, reply with one or two sentences; the map holds the details.',
	].join('\n');
}

/** Messages from the extension to the map tab. */
export type CodeMapHostMessage = { type: 'map'; map: CodeMap; l10n?: Record<string, string> };

/** Messages from the map tab to the extension. */
export type CodeMapPageMessage =
	| { type: 'ready' }
	| { type: 'open'; file: string; line: number; endLine?: number }
	| { type: 'copy' }
	| { type: 'followUp' }
	| { type: 'regenerate' };
