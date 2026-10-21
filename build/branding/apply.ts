/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Applies the product branding in `branding/` to the rest of the repository:
 *
 * - `branding/brand.json` sets the product name and every identifier derived from it
 *   (application name, data folders, bundle and app ids, URL protocol, ...) in `product.json`.
 * - `branding/icon.svg` is rendered into all the platform icons (png, ico, icns, bmp).
 * - `branding/letterpress.svg` becomes the empty-editor watermark for each theme.
 *
 * Usage: `npm run brand` (pass `--no-icons` to only update `product.json`).
 * Rendering the icons uses the Playwright Chromium that the repository already depends on
 * (`npx playwright install chromium`, or point CHROMIUM_PATH at an existing Chromium).
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const root = path.join(import.meta.dirname, '..', '..');
const brandingDir = path.join(root, 'branding');

interface Brand {
	/** Display name, e.g. "Nighthawk". */
	readonly name: string;
	/** Lowercase identifier used for the executable, data folders and URL protocol, e.g. "nighthawk". */
	readonly id: string;
	/** Reverse domain identifier used for the macOS bundle and Linux desktop file, e.g. "io.github.user.nighthawk". */
	readonly reverseDomain: string;
	/** Repository that issues and the license link point at. */
	readonly repository: string;
	/** Background color of the Windows start menu tile. */
	readonly tileBackgroundColor: string;
}

function readBrand(): Brand {
	const brand = JSON.parse(fs.readFileSync(path.join(brandingDir, 'brand.json'), 'utf8')) as Brand;
	if (!/^[a-z][a-z0-9-]*$/.test(brand.id)) {
		throw new Error(`brand.json: "id" must be lowercase letters, digits and dashes, got "${brand.id}"`);
	}
	return brand;
}

/** A stable GUID derived from the brand, so ids change with the name but not between runs. */
function guid(brand: Brand, purpose: string): string {
	const hex = crypto.createHash('sha256').update(`${brand.reverseDomain}/${purpose}`).digest('hex').toUpperCase();
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Auto-update checks the repository's GitHub Releases, which the Fork Build workflow publishes
 * on every push to main. The asset names must match the files that workflow uploads.
 */
function releaseUpdates(brand: Brand): { url: string; assets: Record<string, string> } {
	const repository = new URL(brand.repository);
	if (repository.hostname !== 'github.com') {
		throw new Error(`brand.json: "repository" must be a github.com URL for updates, got "${brand.repository}"`);
	}
	const compact = brand.name.replace(/[^A-Za-z0-9]/g, '');
	return {
		url: `https://api.github.com/repos${repository.pathname.replace(/\/$/, '')}/releases`,
		assets: {
			'win32-x64-user': `${compact}UserSetup-x64.exe`,
			'win32-x64-archive': `${brand.id}-win32-x64.zip`,
			'linux-x64': `${brand.id}-linux-x64.tar.gz`,
		},
	};
}

function applyProduct(brand: Brand): void {
	const productPath = path.join(root, 'product.json');
	const product = JSON.parse(fs.readFileSync(productPath, 'utf8'));
	const compact = brand.name.replace(/[^A-Za-z0-9]/g, '');
	const mutex = brand.id.replace(/-/g, '');
	const licenseUrl = `${brand.repository}/blob/main/LICENSE.txt`;

	Object.assign(product, {
		nameShort: brand.name,
		nameLong: brand.name,
		applicationName: brand.id,
		dataFolderName: `.${brand.id}`,
		sharedDataFolderName: `.${brand.id}-shared`,
		win32MutexName: mutex,
		licenseUrl,
		serverLicenseUrl: licenseUrl,
		serverApplicationName: `${brand.id}-server`,
		serverDataFolderName: `.${brand.id}-server`,
		tunnelApplicationName: `${brand.id}-tunnel`,
		win32DirName: brand.name,
		win32NameVersion: brand.name,
		win32RegValueName: compact,
		win32x64AppId: `{{${guid(brand, 'win32x64AppId')}}`,
		win32arm64AppId: `{{${guid(brand, 'win32arm64AppId')}}`,
		win32x64UserAppId: `{{${guid(brand, 'win32x64UserAppId')}}`,
		win32arm64UserAppId: `{{${guid(brand, 'win32arm64UserAppId')}}`,
		win32AppUserModelId: brand.reverseDomain,
		win32ShellNameShort: `&${brand.name}`,
		win32TunnelServiceMutex: `${mutex}-tunnelservice`,
		win32TunnelMutex: `${mutex}-tunnel`,
		darwinBundleIdentifier: brand.reverseDomain,
		darwinProfileUUID: guid(brand, 'darwinProfileUUID'),
		darwinProfilePayloadUUID: guid(brand, 'darwinProfilePayloadUUID'),
		linuxDesktopName: brand.reverseDomain,
		linuxIconName: brand.id,
		reportIssueUrl: `${brand.repository}/issues/new`,
		urlProtocol: brand.id,
		releaseUpdates: releaseUpdates(brand),
	});

	fs.writeFileSync(productPath, JSON.stringify(product, null, '\t') + '\n');

	const manifestPath = path.join(root, 'resources', 'win32', 'VisualElementsManifest.xml');
	const manifest = fs.readFileSync(manifestPath, 'utf8')
		.replace(/BackgroundColor="[^"]*"/, `BackgroundColor="${brand.tileBackgroundColor}"`)
		.replace(/ShortDisplayName="[^"]*"/, `ShortDisplayName="${brand.name}"`);
	fs.writeFileSync(manifestPath, manifest);
}

function applyLetterpress(): void {
	const source = fs.readFileSync(path.join(brandingDir, 'letterpress.svg'), 'utf8');
	const variants: Record<string, { color: string; opacity?: string }> = {
		'light': { color: '#000000', opacity: '0.1' },
		'dark': { color: '#000000', opacity: '0.3' },
		'hcLight': { color: '#D9D9D9' },
		'hcDark': { color: '#3C3C3C' },
	};
	for (const [theme, { color, opacity }] of Object.entries(variants)) {
		let svg = source.replace(/currentColor/g, color);
		if (opacity) {
			svg = svg.replace('<svg ', `<svg opacity="${opacity}" `);
		}
		fs.writeFileSync(path.join(root, 'src', 'vs', 'workbench', 'browser', 'parts', 'editor', 'media', `letterpress-${theme}.svg`), svg);
	}
}

interface Rendered {
	readonly png: Buffer;
	/** RGBA pixels, top row first. */
	readonly rgba: Buffer;
	readonly width: number;
	readonly height: number;
}

interface RenderRequest {
	readonly width: number;
	readonly height: number;
	/** Edge length of the square icon, centered in the canvas. */
	readonly iconSize: number;
	/** Fill behind the icon; transparent when omitted. */
	readonly background?: string;
}

// Runs inside the page; kept as source text because the build scripts are compiled without DOM types.
const pageScript = `
	const icon = document.getElementById('icon');
	window.iconReady = icon.decode();
	window.renderIcon = ({ width, height, iconSize, background }) => {
		const canvas = document.createElement('canvas');
		canvas.width = width;
		canvas.height = height;
		const ctx = canvas.getContext('2d');
		if (background) {
			ctx.fillStyle = background;
			ctx.fillRect(0, 0, width, height);
		}
		ctx.imageSmoothingQuality = 'high';
		ctx.drawImage(icon, Math.round((width - iconSize) / 2), Math.round((height - iconSize) / 2), iconSize, iconSize);
		return {
			png: canvas.toDataURL('image/png').split(',')[1],
			rgba: Array.from(ctx.getImageData(0, 0, width, height).data),
		};
	};
`;

interface IconPage {
	readonly iconReady: Promise<void>;
	renderIcon(request: RenderRequest): { png: string; rgba: number[] };
}

async function createRenderer(svg: string): Promise<{ render(request: RenderRequest): Promise<Rendered>; dispose(): Promise<void> }> {
	const { chromium } = await import('@playwright/test');
	// Set CHROMIUM_PATH to use an existing Chromium instead of the one `npx playwright install chromium` downloads
	const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
	const page = await browser.newPage();
	await page.setContent(`<img id="icon" src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}"><script>${pageScript}</script>`);
	await page.evaluate(() => (globalThis as unknown as IconPage).iconReady);

	return {
		async render(request) {
			const result = await page.evaluate(request => (globalThis as unknown as IconPage).renderIcon(request), request);
			return { png: Buffer.from(result.png, 'base64'), rgba: Buffer.from(result.rgba), width: request.width, height: request.height };
		},
		dispose: () => browser.close(),
	};
}

/** ICO file with PNG-compressed entries (supported since Windows Vista). */
function toIco(images: Rendered[]): Buffer {
	const header = Buffer.alloc(6 + 16 * images.length);
	header.writeUInt16LE(0, 0);
	header.writeUInt16LE(1, 2);
	header.writeUInt16LE(images.length, 4);
	let offset = header.length;
	images.forEach((image, i) => {
		const entry = 6 + 16 * i;
		header.writeUInt8(image.width >= 256 ? 0 : image.width, entry);
		header.writeUInt8(image.height >= 256 ? 0 : image.height, entry + 1);
		header.writeUInt16LE(1, entry + 4);
		header.writeUInt16LE(32, entry + 6);
		header.writeUInt32LE(image.png.length, entry + 8);
		header.writeUInt32LE(offset, entry + 12);
		offset += image.png.length;
	});
	return Buffer.concat([header, ...images.map(image => image.png)]);
}

/** ICNS file with PNG entries, keyed by OSType. */
function toIcns(entries: [type: string, image: Rendered][]): Buffer {
	const chunks = entries.map(([type, image]) => {
		const head = Buffer.alloc(8);
		head.write(type, 0, 'ascii');
		head.writeUInt32BE(8 + image.png.length, 4);
		return Buffer.concat([head, image.png]);
	});
	const head = Buffer.alloc(8);
	head.write('icns', 0, 'ascii');
	head.writeUInt32BE(8 + chunks.reduce((sum, chunk) => sum + chunk.length, 0), 4);
	return Buffer.concat([head, ...chunks]);
}

/** 24-bit bottom-up BMP, as the Inno Setup wizard images require. */
function toBmp(image: Rendered): Buffer {
	const rowSize = Math.ceil(image.width * 3 / 4) * 4;
	const pixelBytes = rowSize * image.height;
	const bmp = Buffer.alloc(54 + pixelBytes);
	bmp.write('BM', 0, 'ascii');
	bmp.writeUInt32LE(bmp.length, 2);
	bmp.writeUInt32LE(54, 10);
	bmp.writeUInt32LE(40, 14);
	bmp.writeInt32LE(image.width, 18);
	bmp.writeInt32LE(image.height, 22);
	bmp.writeUInt16LE(1, 26);
	bmp.writeUInt16LE(24, 28);
	bmp.writeUInt32LE(pixelBytes, 34);
	bmp.writeInt32LE(2835, 38);
	bmp.writeInt32LE(2835, 42);
	for (let y = 0; y < image.height; y++) {
		const row = 54 + (image.height - 1 - y) * rowSize;
		for (let x = 0; x < image.width; x++) {
			const src = (y * image.width + x) * 4;
			bmp[row + x * 3] = image.rgba[src + 2];
			bmp[row + x * 3 + 1] = image.rgba[src + 1];
			bmp[row + x * 3 + 2] = image.rgba[src];
		}
	}
	return bmp;
}

async function applyIcons(): Promise<void> {
	const svg = fs.readFileSync(path.join(brandingDir, 'icon.svg'), 'utf8');
	fs.writeFileSync(path.join(root, 'src', 'vs', 'workbench', 'browser', 'media', 'code-icon.svg'), svg);

	const renderer = await createRenderer(svg);
	try {
		const cache = new Map<number, Rendered>();
		const square = async (size: number) => {
			if (!cache.has(size)) {
				cache.set(size, await renderer.render({ width: size, height: size, iconSize: size }));
			}
			return cache.get(size)!;
		};
		const write = (relativePath: string, data: Buffer) => fs.writeFileSync(path.join(root, 'resources', ...relativePath.split('/')), data);

		write('linux/code.png', (await square(1024)).png);
		write('server/code-192.png', (await square(192)).png);
		write('server/code-512.png', (await square(512)).png);
		write('server/favicon.ico', toIco(await Promise.all([16, 24, 32, 48, 64].map(square))));
		write('win32/code.ico', toIco(await Promise.all([16, 24, 32, 48, 64, 128, 256].map(square))));
		write('win32/code_150x150.png', (await renderer.render({ width: 150, height: 150, iconSize: 100 })).png);
		write('win32/code_70x70.png', (await renderer.render({ width: 70, height: 70, iconSize: 48 })).png);
		write('darwin/code.icns', toIcns([
			['icp4', await square(16)],
			['icp5', await square(32)],
			['icp6', await square(64)],
			['ic07', await square(128)],
			['ic08', await square(256)],
			['ic09', await square(512)],
			['ic10', await square(1024)],
			['ic11', await square(32)],
			['ic12', await square(64)],
			['ic13', await square(256)],
			['ic14', await square(512)],
		]));

		// Inno Setup wizard images keep the sizes of the originals for each DPI scale
		const innoSizes: Record<string, [number, number][]> = {
			big: [[164, 314], [192, 386], [246, 459], [273, 556], [328, 604], [355, 700], [410, 797]],
			small: [[55, 55], [64, 68], [83, 80], [92, 97], [110, 106], [119, 123], [138, 140]],
		};
		const scales = [100, 125, 150, 175, 200, 225, 250];
		for (const [kind, sizes] of Object.entries(innoSizes)) {
			for (let i = 0; i < sizes.length; i++) {
				const [width, height] = sizes[i];
				const iconSize = Math.round(kind === 'big' ? width * 0.75 : Math.min(width, height) * 0.85);
				write(`win32/inno-${kind}-${scales[i]}.bmp`, toBmp(await renderer.render({ width, height, iconSize, background: '#FFFFFF' })));
			}
		}
	} finally {
		await renderer.dispose();
	}
}

async function main(): Promise<void> {
	const brand = readBrand();
	applyProduct(brand);
	applyLetterpress();
	if (!process.argv.includes('--no-icons')) {
		await applyIcons();
	}
	console.log(`Applied branding for ${brand.name}`);
}

main().catch(err => {
	console.error(err);
	process.exit(1);
});
