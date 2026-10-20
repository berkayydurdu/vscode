/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };

interface GraphNode {
	uri: string;
	name: string;
	active: boolean;
	x: number;
	y: number;
	vx: number;
	vy: number;
	degree: number;
}

interface GraphMessage {
	type: 'graph';
	nodes: { uri: string; name: string; active: boolean }[];
	edges: [number, number][];
}

(function () {
	const vscode = acquireVsCodeApi();
	const canvas = document.getElementById('graph') as HTMLCanvasElement;
	const empty = document.getElementById('empty') as HTMLElement;
	const ctx = canvas.getContext('2d')!;

	let nodes: GraphNode[] = [];
	let edges: [number, number][] = [];
	const view = { x: 0, y: 0, scale: 1 };
	let hover: number | undefined;
	let drag: { node?: number; x: number; y: number; moved: boolean } | undefined;
	let heat = 1;

	function color(name: string, fallback: string): string {
		return getComputedStyle(document.body).getPropertyValue(name).trim() || fallback;
	}

	function resize() {
		const ratio = window.devicePixelRatio || 1;
		canvas.width = canvas.clientWidth * ratio;
		canvas.height = canvas.clientHeight * ratio;
		ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
	}

	window.addEventListener('message', (event: MessageEvent<GraphMessage>) => {
		const message = event.data;
		if (event.origin !== window.origin || message?.type !== 'graph') {
			return;
		}
		// Keep positions of notes that were already on screen.
		const previous = new Map(nodes.map(n => [n.uri, n]));
		nodes = message.nodes.map((n, i) => {
			const old = previous.get(n.uri);
			const angle = i * 2.399963;
			const radius = 30 * Math.sqrt(i + 1);
			return { ...n, x: old?.x ?? Math.cos(angle) * radius, y: old?.y ?? Math.sin(angle) * radius, vx: 0, vy: 0, degree: 0 };
		});
		edges = message.edges;
		for (const [a, b] of edges) {
			nodes[a].degree++;
			nodes[b].degree++;
		}
		empty.style.display = nodes.length ? 'none' : 'flex';
		heat = previous.size ? Math.max(heat, 0.3) : 1;
	});

	function step() {
		if (heat > 0.005) {
			const repulsion = 2000;
			for (let i = 0; i < nodes.length; i++) {
				const a = nodes[i];
				for (let j = i + 1; j < nodes.length; j++) {
					const b = nodes[j];
					let dx = a.x - b.x, dy = a.y - b.y;
					let d2 = dx * dx + dy * dy;
					if (d2 < 0.01) {
						dx = Math.random() - 0.5; dy = Math.random() - 0.5; d2 = 0.5;
					}
					if (d2 > 250000) {
						continue;
					}
					const f = repulsion / d2;
					const d = Math.sqrt(d2);
					a.vx += dx / d * f; a.vy += dy / d * f;
					b.vx -= dx / d * f; b.vy -= dy / d * f;
				}
			}
			for (const [i, j] of edges) {
				const a = nodes[i], b = nodes[j];
				const dx = b.x - a.x, dy = b.y - a.y;
				const d = Math.sqrt(dx * dx + dy * dy) || 1;
				const f = (d - 80) * 0.02;
				a.vx += dx / d * f; a.vy += dy / d * f;
				b.vx -= dx / d * f; b.vy -= dy / d * f;
			}
			for (const n of nodes) {
				// Gentle pull to the centre keeps unlinked notes on screen.
				n.vx -= n.x * 0.002;
				n.vy -= n.y * 0.002;
				if (drag?.node !== undefined && nodes[drag.node] === n) {
					n.vx = n.vy = 0;
					continue;
				}
				n.x += n.vx * heat;
				n.y += n.vy * heat;
				n.vx *= 0.6;
				n.vy *= 0.6;
			}
			heat *= 0.99;
		}
		draw();
		requestAnimationFrame(step);
	}

	function radius(n: GraphNode): number {
		return 4 + Math.min(10, Math.sqrt(n.degree) * 2);
	}

	function draw() {
		const w = canvas.clientWidth, h = canvas.clientHeight;
		ctx.clearRect(0, 0, w, h);
		ctx.save();
		ctx.translate(w / 2 + view.x, h / 2 + view.y);
		ctx.scale(view.scale, view.scale);

		const linkColor = color('--vscode-editorIndentGuide-background1', '#8884');
		const nodeColor = color('--vscode-descriptionForeground', '#888');
		const accent = color('--vscode-focusBorder', '#3b82f6');
		const text = color('--vscode-editor-foreground', '#ccc');
		const neighbours = new Set<number>();
		if (hover !== undefined) {
			for (const [a, b] of edges) {
				if (a === hover) { neighbours.add(b); }
				if (b === hover) { neighbours.add(a); }
			}
		}

		ctx.lineWidth = 1 / view.scale;
		for (const [a, b] of edges) {
			const highlighted = a === hover || b === hover;
			ctx.strokeStyle = highlighted ? accent : linkColor;
			ctx.beginPath();
			ctx.moveTo(nodes[a].x, nodes[a].y);
			ctx.lineTo(nodes[b].x, nodes[b].y);
			ctx.stroke();
		}
		ctx.font = `${12 / view.scale}px ${color('--vscode-font-family', 'sans-serif')}`;
		ctx.textAlign = 'center';
		nodes.forEach((n, i) => {
			const dimmed = hover !== undefined && i !== hover && !neighbours.has(i);
			ctx.globalAlpha = dimmed ? 0.25 : 1;
			ctx.fillStyle = n.active || i === hover ? accent : nodeColor;
			ctx.beginPath();
			ctx.arc(n.x, n.y, radius(n), 0, Math.PI * 2);
			ctx.fill();
			if (view.scale > 0.6 || i === hover || n.active) {
				ctx.fillStyle = text;
				ctx.fillText(n.name, n.x, n.y + radius(n) + 12 / view.scale);
			}
		});
		ctx.globalAlpha = 1;
		ctx.restore();
	}

	function toWorld(clientX: number, clientY: number) {
		const rect = canvas.getBoundingClientRect();
		return {
			x: (clientX - rect.left - rect.width / 2 - view.x) / view.scale,
			y: (clientY - rect.top - rect.height / 2 - view.y) / view.scale,
		};
	}

	function nodeAt(clientX: number, clientY: number): number | undefined {
		const p = toWorld(clientX, clientY);
		for (let i = nodes.length - 1; i >= 0; i--) {
			const n = nodes[i];
			const r = radius(n) + 3 / view.scale;
			if ((n.x - p.x) ** 2 + (n.y - p.y) ** 2 <= r * r) {
				return i;
			}
		}
		return undefined;
	}

	canvas.addEventListener('mousedown', e => {
		drag = { node: nodeAt(e.clientX, e.clientY), x: e.clientX, y: e.clientY, moved: false };
		canvas.classList.add('dragging');
	});
	window.addEventListener('mousemove', e => {
		if (!drag) {
			hover = nodeAt(e.clientX, e.clientY);
			return;
		}
		const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
		if (Math.abs(dx) + Math.abs(dy) > 3) {
			drag.moved = true;
		}
		if (drag.node !== undefined) {
			const p = toWorld(e.clientX, e.clientY);
			nodes[drag.node].x = p.x;
			nodes[drag.node].y = p.y;
			heat = Math.max(heat, 0.2);
		} else {
			view.x += dx;
			view.y += dy;
		}
		drag.x = e.clientX;
		drag.y = e.clientY;
	});
	window.addEventListener('mouseup', () => {
		if (drag && !drag.moved && drag.node !== undefined) {
			vscode.postMessage({ type: 'open', uri: nodes[drag.node].uri });
		}
		drag = undefined;
		canvas.classList.remove('dragging');
	});
	canvas.addEventListener('wheel', e => {
		e.preventDefault();
		const before = toWorld(e.clientX, e.clientY);
		view.scale = Math.min(4, Math.max(0.15, view.scale * Math.exp(-e.deltaY * 0.0015)));
		const after = toWorld(e.clientX, e.clientY);
		view.x += (after.x - before.x) * view.scale;
		view.y += (after.y - before.y) * view.scale;
	}, { passive: false });

	window.addEventListener('resize', resize);
	resize();
	requestAnimationFrame(step);
	vscode.postMessage({ type: 'ready' });
}());
