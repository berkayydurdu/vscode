/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Scratch files, as in JetBrains IDEs: throwaway files of any language
// that live outside the project, shared by every workspace, and run with
// one click through the language's usual command.

import { access } from 'node:fs/promises';
import * as path from 'node:path';

export interface ScratchLanguage {
	/** The editor's language id. */
	id: string;
	label: string;
	ext: string;
	/** What a new file starts with, for languages that need a main function to run. */
	template?: string;
}

export const SCRATCH_LANGUAGES: ScratchLanguage[] = [
	{ id: 'javascript', label: 'JavaScript', ext: 'js' },
	{ id: 'typescript', label: 'TypeScript', ext: 'ts' },
	{ id: 'python', label: 'Python', ext: 'py' },
	{ id: 'shellscript', label: 'Shell', ext: 'sh' },
	{ id: 'powershell', label: 'PowerShell', ext: 'ps1' },
	{ id: 'go', label: 'Go', ext: 'go', template: 'package main\n\nimport "fmt"\n\nfunc main() {\n\tfmt.Println("Hello")\n}\n' },
	{ id: 'rust', label: 'Rust', ext: 'rs', template: 'fn main() {\n    println!("Hello");\n}\n' },
	{ id: 'java', label: 'Java', ext: 'java', template: 'class Scratch {\n\tpublic static void main(String[] args) {\n\t\tSystem.out.println("Hello");\n\t}\n}\n' },
	{ id: 'csharp', label: 'C#', ext: 'cs', template: 'Console.WriteLine("Hello");\n' },
	{ id: 'c', label: 'C', ext: 'c', template: '#include <stdio.h>\n\nint main(void) {\n\tprintf("Hello\\n");\n\treturn 0;\n}\n' },
	{ id: 'cpp', label: 'C++', ext: 'cpp', template: '#include <iostream>\n\nint main() {\n\tstd::cout << "Hello" << std::endl;\n\treturn 0;\n}\n' },
	{ id: 'ruby', label: 'Ruby', ext: 'rb' },
	{ id: 'php', label: 'PHP', ext: 'php', template: '<?php\n\n' },
	{ id: 'lua', label: 'Lua', ext: 'lua' },
	{ id: 'perl', label: 'Perl', ext: 'pl' },
	{ id: 'r', label: 'R', ext: 'r' },
	{ id: 'dart', label: 'Dart', ext: 'dart', template: 'void main() {\n  print(\'Hello\');\n}\n' },
	{ id: 'swift', label: 'Swift', ext: 'swift' },
	{ id: 'sql', label: 'SQL', ext: 'sql' },
	{ id: 'json', label: 'JSON', ext: 'json' },
	{ id: 'markdown', label: 'Markdown', ext: 'md' },
	{ id: 'plaintext', label: 'Plain Text', ext: 'txt' },
];

/**
 * The commands that run a file, by extension. `${file}` is the file and
 * `${out}` a program a compiler writes; a line with `&&` runs the next
 * command only when the one before it worked.
 */
export function defaultRunners(platform: NodeJS.Platform): Record<string, string> {
	const win = platform === 'win32';
	return {
		js: 'node ${file}',
		mjs: 'node ${file}',
		cjs: 'node ${file}',
		// Node 22.6 and later run TypeScript by dropping the types.
		ts: 'node --experimental-strip-types --no-warnings ${file}',
		mts: 'node --experimental-strip-types --no-warnings ${file}',
		py: win ? 'python ${file}' : 'python3 ${file}',
		sh: 'bash ${file}',
		bash: 'bash ${file}',
		zsh: 'zsh ${file}',
		ps1: `${win ? 'powershell' : 'pwsh'} -NoProfile -ExecutionPolicy Bypass -File \${file}`,
		go: 'go run ${file}',
		rs: 'rustc -o ${out} ${file} && ${out}',
		java: 'java ${file}',
		cs: 'dotnet run ${file}',
		c: `${win ? 'gcc' : 'cc'} \${file} -o \${out} && \${out}`,
		cpp: `${win ? 'g++' : 'c++'} -std=c++17 \${file} -o \${out} && \${out}`,
		rb: 'ruby ${file}',
		php: 'php ${file}',
		lua: 'lua ${file}',
		pl: 'perl ${file}',
		r: 'Rscript ${file}',
		dart: 'dart run ${file}',
		swift: 'swift ${file}',
		kts: 'kotlin ${file}',
		exs: 'elixir ${file}',
		jl: 'julia ${file}',
		hs: 'runghc ${file}',
	};
}

/** Splits a command line into words, keeping "quoted parts" together. */
export function splitCommand(line: string): string[] {
	const words: string[] = [];
	const pattern = /"(?<double>[^"]*)"|'(?<single>[^']*)'|(?<bare>[^\s"']+)/g;
	let current: string | undefined;
	let last = 0;
	for (const match of line.matchAll(pattern)) {
		const piece = match.groups?.double ?? match.groups?.single ?? match.groups?.bare ?? '';
		// Pieces with no space between them, such as --out="a b", make one word.
		if (current !== undefined && match.index === last) {
			current += piece;
		} else {
			if (current !== undefined) {
				words.push(current);
			}
			current = piece;
		}
		last = match.index + match[0].length;
	}
	if (current !== undefined) {
		words.push(current);
	}
	return words;
}

export interface RunPlan {
	/** Each command as a program and its arguments, run in order while they succeed. */
	steps: string[][];
	/** Where the plan came from, shown when a program is missing. */
	source: 'shebang' | 'setting' | 'default';
}

/**
 * How to run a file: its configured runner, else its `#!` line (not on
 * Windows), else the usual command for its extension. Undefined when
 * nothing is known.
 */
export function runPlan(file: string, firstLine: string, options: { platform: NodeJS.Platform; configured?: Record<string, string>; out: string }): RunPlan | undefined {
	const ext = path.extname(file).slice(1).toLowerCase();
	const fill = (word: string) => word.replace(/\$\{file\}/g, file).replace(/\$\{out\}/g, options.out).replace(/\$\{dir\}/g, path.dirname(file));
	const fromTemplate = (template: string) => template.split('&&').map(part => splitCommand(part.trim()).map(fill)).filter(step => step.length);
	const configured = options.configured?.[ext] ?? options.configured?.[`.${ext}`];
	if (typeof configured === 'string' && configured.trim()) {
		return { steps: fromTemplate(configured), source: 'setting' };
	}
	const shebang = /^#!\s*(?<line>\S.*)$/.exec(firstLine.trim())?.groups?.line;
	if (shebang && options.platform !== 'win32') {
		const words = splitCommand(shebang);
		// "/usr/bin/env node" and "/usr/bin/env -S deno run" run the named program.
		const program = path.basename(words[0]) === 'env' ? words.slice(words[1] === '-S' ? 2 : 1) : words;
		if (program.length) {
			return { steps: [[...program, file]], source: 'shebang' };
		}
	}
	const template = defaultRunners(options.platform)[ext];
	return template ? { steps: fromTemplate(template), source: 'default' } : undefined;
}

async function fileExists(file: string): Promise<boolean> {
	try {
		await access(file);
		return true;
	} catch {
		return false;
	}
}

/** Where a program is on PATH (trying PATHEXT on Windows), or undefined. */
export async function findProgram(program: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, exists = fileExists): Promise<string | undefined> {
	const extensions = platform === 'win32' ? ['', ...(env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map(e => e.toLowerCase())] : [''];
	if (program.includes('/') || (platform === 'win32' && program.includes('\\'))) {
		for (const ext of extensions) {
			if (await exists(program + ext)) {
				return program + ext;
			}
		}
		return undefined;
	}
	const pathValue = env.PATH ?? env.Path ?? '';
	for (const dir of pathValue.split(platform === 'win32' ? ';' : ':').filter(Boolean)) {
		for (const ext of extensions) {
			const candidate = (platform === 'win32' ? path.win32 : path.posix).join(dir, program + ext);
			if (await exists(candidate)) {
				return candidate;
			}
		}
	}
	return undefined;
}

/** A name for a new scratch file that is not taken: scratch.py, then scratch-2.py and so on. */
export function scratchName(ext: string, taken: ReadonlySet<string>): string {
	for (let n = 1; ; n++) {
		const name = n === 1 ? `scratch.${ext}` : `scratch-${n}.${ext}`;
		if (!taken.has(name.toLowerCase())) {
			return name;
		}
	}
}

/** Seconds with two decimals below ten, then one, as a run's time is shown. */
export function formatDuration(ms: number): string {
	const seconds = ms / 1000;
	return seconds < 10 ? `${seconds.toFixed(2)} s` : `${seconds.toFixed(1)} s`;
}
