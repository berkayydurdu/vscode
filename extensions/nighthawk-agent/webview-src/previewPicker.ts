/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Runs inside the user's page in the live preview (added by the preview's
// proxy). It talks only to the preview tab that frames the page.

import type { ConsoleEntry, PickedElement, PickerCommand, PickerMessage } from '../src/core/preview';

const STYLE_NAMES = ['display', 'position', 'width', 'height', 'margin', 'padding', 'color', 'background-color', 'font-family', 'font-size', 'font-weight', 'line-height', 'border', 'border-radius', 'gap', 'flex-direction', 'justify-content', 'align-items'];
const SOURCE_ATTRIBUTES = ['data-source', 'data-insp-path', 'data-v-inspector', 'data-astro-source-file', 'data-sveltekit-source', 'data-locator'];

(() => {
	if (window.parent === window || (window as unknown as { __nighthawkPreview?: boolean }).__nighthawkPreview) {
		return;
	}
	(window as unknown as { __nighthawkPreview?: boolean }).__nighthawkPreview = true;

	const send = (message: PickerMessage) => window.parent.postMessage(message, '*');

	// --- Console errors

	const describe = (value: unknown): string => {
		if (value instanceof Error) {
			return value.stack ?? `${value.name}: ${value.message}`;
		}
		if (typeof value === 'string') {
			return value;
		}
		try {
			return JSON.stringify(value);
		} catch {
			return String(value);
		}
	};
	const report = (level: ConsoleEntry['level'], parts: unknown[]) => {
		const text = parts.map(describe).join(' ').slice(0, 2000);
		send({ type: 'nighthawk:console', entry: { level, text, time: Date.now() } });
	};
	for (const level of ['error', 'warn'] as const) {
		const original = console[level].bind(console);
		console[level] = (...parts: unknown[]) => {
			report(level, parts);
			original(...parts);
		};
	}
	window.addEventListener('error', event => report('error', [event.error ?? `${event.message} (${event.filename}:${event.lineno})`]));
	window.addEventListener('unhandledrejection', event => report('error', ['Unhandled promise rejection:', event.reason]));

	// --- Picking

	let picking = false;
	let current: Element | undefined;
	const box = document.createElement('div');
	const label = document.createElement('div');
	box.setAttribute('style', 'position:fixed;z-index:2147483647;pointer-events:none;border:2px solid #7c6cff;background:rgba(124,108,255,.12);border-radius:3px;display:none;transition:all 60ms ease-out');
	label.setAttribute('style', 'position:fixed;z-index:2147483647;pointer-events:none;background:#7c6cff;color:#fff;font:600 11px/1.6 system-ui,sans-serif;padding:1px 6px;border-radius:3px;display:none;white-space:nowrap');

	const fiberOf = (el: Element): { type?: unknown; return?: unknown; _debugSource?: { fileName: string; lineNumber: number } } | undefined => {
		const key = Object.keys(el).find(k => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'));
		return key ? (el as unknown as Record<string, never>)[key] : undefined;
	};

	const components = (el: Element): { names: string[]; source?: string } => {
		const names: string[] = [];
		let source: string | undefined;
		// React: walk the fiber tree up through the components.
		let fiber = fiberOf(el);
		for (let i = 0; fiber && i < 200 && names.length < 6; i++) {
			const type = fiber.type as { name?: string; displayName?: string } | string | undefined;
			if (typeof type === 'function' || (type && typeof type === 'object')) {
				const name = (type as { displayName?: string; name?: string }).displayName ?? (type as { name?: string }).name;
				if (name && !names.includes(name)) {
					names.push(name);
				}
			}
			if (!source && fiber._debugSource) {
				source = `${fiber._debugSource.fileName}:${fiber._debugSource.lineNumber}`;
			}
			fiber = fiber.return as typeof fiber;
		}
		// Vue 3: the component instance on the element or a parent.
		let node: Element | null = el;
		while (node && !names.length) {
			let instance = (node as unknown as { __vueParentComponent?: { type: { __name?: string; name?: string; __file?: string }; parent?: unknown } }).__vueParentComponent;
			for (let i = 0; instance && i < 6; i++) {
				const name = instance.type.__name ?? instance.type.name;
				if (name) {
					names.push(name);
				}
				source ??= instance.type.__file;
				instance = instance.parent as typeof instance;
			}
			node = node.parentElement;
		}
		// Dev tools that write the source into attributes.
		for (let n: Element | null = el; n && !source; n = n.parentElement) {
			for (const attribute of SOURCE_ATTRIBUTES) {
				const value = n.getAttribute(attribute);
				if (value) {
					source = value;
					break;
				}
			}
		}
		return { names, source };
	};

	const selectorOf = (el: Element): string => {
		const parts: string[] = [];
		for (let node: Element | null = el; node && node !== document.documentElement && parts.length < 6; node = node.parentElement) {
			if (node.id && document.querySelectorAll(`#${CSS.escape(node.id)}`).length === 1) {
				parts.unshift(`#${CSS.escape(node.id)}`);
				break;
			}
			let part = node.tagName.toLowerCase();
			const parent = node.parentElement;
			if (parent) {
				const same = [...parent.children].filter(c => c.tagName === node!.tagName);
				if (same.length > 1) {
					part += `:nth-of-type(${same.indexOf(node) + 1})`;
				}
			}
			parts.unshift(part);
		}
		return parts.join(' > ');
	};

	const shortHtml = (el: Element): string => {
		const html = el.outerHTML.replace(/\s+/g, ' ');
		if (html.length <= 1500) {
			return html;
		}
		const open = html.slice(0, html.indexOf('>') + 1);
		return `${open.slice(0, 1000)} ... (${el.children.length} children) </${el.tagName.toLowerCase()}>`;
	};

	const describeElement = (el: Element): PickedElement => {
		const rect = el.getBoundingClientRect();
		const computed = getComputedStyle(el);
		const styles: Record<string, string> = {};
		for (const name of STYLE_NAMES) {
			const value = computed.getPropertyValue(name);
			if (value && value !== 'normal' && value !== 'none' && value !== 'auto' && value !== '0px' && value !== 'rgba(0, 0, 0, 0)') {
				styles[name] = value;
			}
		}
		const attributes: Record<string, string> = {};
		for (const attribute of [...el.attributes].slice(0, 20)) {
			attributes[attribute.name] = attribute.value.slice(0, 300);
		}
		const { names, source } = components(el);
		return {
			url: location.href,
			selector: selectorOf(el),
			tag: el.tagName.toLowerCase(),
			text: ((el as HTMLElement).innerText ?? el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 200),
			html: shortHtml(el),
			attributes,
			styles,
			rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
			components: names,
			source,
		};
	};

	const show = (el: Element) => {
		current = el;
		const rect = el.getBoundingClientRect();
		Object.assign(box.style, { display: 'block', left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
		const { names } = components(el);
		const classes = [...el.classList].slice(0, 2).map(c => `.${c}`).join('');
		label.textContent = `${names[0] ? `<${names[0]}> ` : ''}${el.tagName.toLowerCase()}${classes}  ${Math.round(rect.width)}×${Math.round(rect.height)}`;
		Object.assign(label.style, { display: 'block', left: `${Math.max(0, rect.left)}px`, top: `${rect.top > 22 ? rect.top - 20 : rect.bottom + 2}px` });
	};

	const stop = () => {
		picking = false;
		current = undefined;
		box.style.display = 'none';
		label.style.display = 'none';
		document.documentElement.style.removeProperty('cursor');
		send({ type: 'nighthawk:pickEnded' });
	};

	const swallow = (event: Event) => {
		if (picking) {
			event.preventDefault();
			event.stopPropagation();
		}
	};

	document.addEventListener('mousemove', event => {
		if (picking && event.target instanceof Element && event.target !== current) {
			show(event.target);
		}
	}, true);
	for (const type of ['mousedown', 'mouseup', 'pointerdown', 'pointerup']) {
		document.addEventListener(type, swallow, true);
	}
	document.addEventListener('click', event => {
		if (!picking) {
			return;
		}
		swallow(event);
		const el = event.target instanceof Element ? event.target : current;
		if (el) {
			send({ type: 'nighthawk:picked', element: describeElement(el) });
		}
		stop();
	}, true);
	document.addEventListener('keydown', event => {
		if (picking && event.key === 'Escape') {
			swallow(event);
			stop();
		}
	}, true);

	window.addEventListener('message', event => {
		if (event.source !== window.parent) {
			return;
		}
		const command = event.data as PickerCommand;
		if (command?.type !== 'nighthawk:pick') {
			return;
		}
		if (command.on && !picking) {
			picking = true;
			document.documentElement.append(box, label);
			document.documentElement.style.setProperty('cursor', 'crosshair');
		} else if (!command.on && picking) {
			stop();
		}
	});

	const ready = () => send({ type: 'nighthawk:ready', url: location.href, title: document.title });
	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', ready);
	} else {
		ready();
	}
	// Single-page apps change the address without loading a page.
	for (const method of ['pushState', 'replaceState'] as const) {
		const original = history[method].bind(history);
		history[method] = (...args: Parameters<History['pushState']>) => {
			original(...args);
			ready();
		};
	}
	window.addEventListener('popstate', ready);
})();
