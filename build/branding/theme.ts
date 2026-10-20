/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Generates the Nighthawk color themes from the built-in 2026 themes.
 *
 * Every color of `2026 Dark` and `2026 Light` is carried over, with three changes:
 * - neutral grays get a faint indigo tint, so the workbench reads as "night sky" instead of plain gray,
 * - the blue accent becomes the Nighthawk indigo from `branding/icon.svg`,
 * - syntax colors use the Nighthawk palette below.
 * The few colors that need a hand-picked value are listed in `overrides`.
 *
 * Usage: `npm run brand:theme`. The output goes to `extensions/theme-defaults/themes/nighthawk-{dark,light}.json`.
 * Because the themes are derived, upstream changes to the 2026 themes carry over on the next run.
 */

import fs from 'fs';
import path from 'path';

const root = path.join(import.meta.dirname, '..', '..');
const themesDir = path.join(root, 'extensions', 'theme-defaults', 'themes');

/** Hue of the Nighthawk indigo (#4F46E5). */
const INDIGO_HUE = 244;

interface ThemeSpec {
	readonly source: string;
	readonly target: string;
	readonly name: string;
	readonly dark: boolean;
	/** Source syntax color (lowercase) to Nighthawk syntax color. */
	readonly syntax: Record<string, string>;
	/** Token colors for scopes whose meaning must not follow the palette swap (diff insertions stay green). */
	readonly scopeColors: Record<string, string>;
	readonly overrides: Record<string, string>;
}

const specs: ThemeSpec[] = [
	{
		source: '2026-dark.json',
		target: 'nighthawk-dark.json',
		name: 'Nighthawk Dark',
		dark: true,
		syntax: {
			'#ff7b72': '#c3a6ff', // keywords, storage: lavender
			'#79c0ff': '#89b4fa', // constants, support, properties: sky
			'#d2a8ff': '#7dd3e0', // functions: cyan
			'#ffa657': '#f5bd7a', // declared names, variables: amber
			'#a5d6ff': '#a6dfa8', // strings: mint
			'#7ee787': '#f5a3c0', // tags, JSON keys: rose
			'#8b949e': '#6f6d96', // comments: dusk
			'#c9d1d9': '#cfd0e8', // plain identifiers
			'#ffa198': '#ff9e9e', // invalid
			'#f0f6fc': '#f1f0ff',
			'#0d1117': '#0e0d1a',
		},
		scopeColors: {
			'markup.inserted': '#a6dfa8',
			'markup.quote': '#a6dfa8',
			'string.regexp constant.character.escape': '#f5a3c0',
		},
		overrides: {
			'focusBorder': '#7c74ffb3',
			'button.background': '#5148d9',
			'button.border': '#5148d9',
			'button.hoverBackground': '#5d55e6',
			'textLink.foreground': '#9d97ff',
			'textLink.activeForeground': '#b2adff',
			'editor.selectionBackground': '#4f46e566',
			'editor.inactiveSelectionBackground': '#4f46e533',
			'editorCursor.foreground': '#a5a0ff',
			'activityBarBadge.background': '#5148d9',
			'statusBarItem.remoteBackground': '#5148d9',
			'progressBar.background': '#7c74ff',
			'tab.activeBorderTop': '#7c74ff',
		},
	},
	{
		source: '2026-light.json',
		target: 'nighthawk-light.json',
		name: 'Nighthawk Light',
		dark: false,
		syntax: {
			'#cf222e': '#7c3aed', // keywords, storage: violet
			'#0550ae': '#3346c7', // constants, support, properties: indigo blue
			'#8250df': '#0e7c86', // functions: teal
			'#953800': '#b45309', // declared names, variables: amber
			'#0a3069': '#1a7f4b', // strings: green
			'#116329': '#c0265f', // tags, JSON keys: rose
			'#6e7781': '#7d7ba3', // comments: dusk
			'#1f2328': '#24223b', // plain identifiers
			'#57606a': '#5b5979',
			'#82071e': '#a3123f', // invalid
		},
		scopeColors: {
			'markup.inserted': '#1a7f4b',
			'markup.quote': '#1a7f4b',
			'string.regexp constant.character.escape': '#c0265f',
		},
		overrides: {
			'focusBorder': '#4f46e5',
			'button.background': '#4f46e5',
			'button.border': '#4f46e5',
			'button.hoverBackground': '#4338ca',
			'textLink.foreground': '#4f46e5',
			'textLink.activeForeground': '#4338ca',
			'editor.selectionBackground': '#4f46e530',
			'editorCursor.foreground': '#4f46e5',
			'activityBarBadge.background': '#4f46e5',
			'statusBarItem.remoteBackground': '#4f46e5',
			'progressBar.background': '#4f46e5',
			'tab.activeBorderTop': '#4f46e5',
		},
	},
];

interface Hsl { h: number; s: number; l: number }

function parseHex(hex: string): { rgb: [number, number, number]; alpha: string } | undefined {
	const match = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(hex);
	if (!match) {
		return undefined;
	}
	const n = parseInt(match[1], 16);
	return { rgb: [(n >> 16) & 255, (n >> 8) & 255, n & 255], alpha: match[2] ?? '' };
}

function toHsl([r, g, b]: [number, number, number]): Hsl {
	r /= 255; g /= 255; b /= 255;
	const max = Math.max(r, g, b);
	const min = Math.min(r, g, b);
	const l = (max + min) / 2;
	if (max === min) {
		return { h: 0, s: 0, l };
	}
	const d = max - min;
	const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
	let h: number;
	if (max === r) {
		h = (g - b) / d + (g < b ? 6 : 0);
	} else if (max === g) {
		h = (b - r) / d + 2;
	} else {
		h = (r - g) / d + 4;
	}
	return { h: h * 60, s, l };
}

function toHex({ h, s, l }: Hsl, alpha: string): string {
	const c = (1 - Math.abs(2 * l - 1)) * s;
	const x = c * (1 - Math.abs((h / 60) % 2 - 1));
	const m = l - c / 2;
	const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
	const channel = (v: number) => Math.round(Math.min(1, Math.max(0, v + m)) * 255).toString(16).padStart(2, '0');
	return `#${channel(r)}${channel(g)}${channel(b)}${alpha}`;
}

function clamp(v: number): number {
	return Math.min(1, Math.max(0, v));
}

/** Tints a workbench color: grays toward indigo, the blue accent to the Nighthawk indigo. */
function tint(color: string, dark: boolean): string {
	const parsed = parseHex(color);
	if (!parsed) {
		return color;
	}
	const hsl = toHsl(parsed.rgb);
	// Pure white and black (often used with alpha for overlays) stay neutral.
	if (hsl.l >= 0.995 || hsl.l <= 0.005) {
		return color;
	}
	if (hsl.s < 0.12) {
		const s = dark ? (hsl.l < 0.2 ? 0.28 : hsl.l < 0.5 ? 0.16 : 0.1) : (hsl.l > 0.9 ? 0.4 : 0.12);
		return toHex({ h: INDIGO_HUE, s, l: hsl.l }, parsed.alpha);
	}
	if (hsl.h >= 185 && hsl.h <= 225) {
		return toHex({ h: INDIGO_HUE, s: Math.max(0.6, Math.min(hsl.s, 0.78)), l: clamp(hsl.l + (dark ? 0.08 : 0.1)) }, parsed.alpha);
	}
	return color;
}

function readTheme(file: string): any {
	const text = fs.readFileSync(path.join(themesDir, file), 'utf8');
	return JSON.parse(text.replace(/,(\s*[}\]])/g, '$1'));
}

function generate(spec: ThemeSpec): void {
	const theme = readTheme(spec.source);

	const colors: Record<string, string> = {};
	for (const [key, value] of Object.entries<string>(theme.colors)) {
		colors[key] = tint(value, spec.dark);
	}
	Object.assign(colors, spec.overrides);

	const tokenColors = theme.tokenColors.map((rule: any) => {
		const scopes: string[] = Array.isArray(rule.scope) ? rule.scope : [rule.scope];
		const settings = { ...rule.settings };
		const fixed = scopes.map(scope => spec.scopeColors[scope]).find(color => color);
		if (fixed) {
			settings.foreground = fixed;
		} else if (typeof settings.foreground === 'string') {
			settings.foreground = spec.syntax[settings.foreground.toLowerCase()] ?? settings.foreground;
		}
		if (scopes.includes('comment')) {
			settings.fontStyle = 'italic';
		}
		return { ...rule, settings };
	});

	const output = {
		$schema: 'vscode://schemas/color-theme',
		name: spec.name,
		include: theme.include,
		type: theme.type,
		colors,
		tokenColors,
		semanticHighlighting: theme.semanticHighlighting,
	};
	fs.writeFileSync(path.join(themesDir, spec.target), JSON.stringify(output, undefined, '\t') + '\n');
	console.log(`Wrote ${spec.target}`);
}

for (const spec of specs) {
	generate(spec);
}
