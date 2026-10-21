/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise } from '../../../../base/common/async.js';
import { bufferToStream, VSBuffer } from '../../../../base/common/buffer.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Event } from '../../../../base/common/event.js';
import { IProductConfiguration } from '../../../../base/common/product.js';
import { IRequestContext, IRequestOptions } from '../../../../base/parts/request/common/request.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { TestConfigurationService } from '../../../configuration/test/common/testConfigurationService.js';
import { IEnvironmentMainService } from '../../../environment/electron-main/environmentMainService.js';
import { ILifecycleMainService } from '../../../lifecycle/electron-main/lifecycleMainService.js';
import { NullLogService } from '../../../log/common/log.js';
import { IMeteredConnectionService } from '../../../meteredConnection/common/meteredConnection.js';
import { IProductService } from '../../../product/common/productService.js';
import { IRequestService } from '../../../request/common/request.js';
import { IApplicationStorageMainService } from '../../../storage/electron-main/storageMainService.js';
import { NullTelemetryService } from '../../../telemetry/common/telemetryUtils.js';
import { DisablementReason, IUpdate, StateType, UpdateType } from '../../common/update.js';
import { AbstractUpdateService, IUpdateURLOptions } from '../../electron-main/abstractUpdateService.js';

const releasesUrl = 'https://api.github.com/repos/o/r/releases';

class TestReleaseUpdateService extends AbstractUpdateService {

	private readonly _initialized = new DeferredPromise<void>();
	get whenInitialized(): Promise<void> { return this._initialized.p; }

	updateType = UpdateType.Setup;

	protected override async initialize(): Promise<void> {
		try {
			await super.initialize();
		} finally {
			this._initialized.complete();
		}
	}

	protected override getUpdatePlatform(): string {
		return 'test-x64';
	}

	protected override getUpdateType(): UpdateType {
		return this.updateType;
	}

	protected buildUpdateFeedUrl(quality: string, commit: string, options?: IUpdateURLOptions): string | undefined {
		return this.createFeedUrl(quality, commit, options);
	}

	protected doCheckForUpdates(): void { }

	feedUrl(): string | undefined {
		return this.buildUpdateFeedUrl('stable', 'abc');
	}

	fetchUpdate(): Promise<IUpdate | null> {
		return this.requestUpdate(this.feedUrl()!, undefined, 'test', CancellationToken.None);
	}

	isLatest(commit: string): Promise<boolean | undefined> {
		return this.doIsLatestVersion(commit);
	}
}

function release(build: number) {
	const tag = `v1.143.0-build.${build}`;
	return {
		tag_name: tag,
		target_commitish: String(build).padStart(40, '0'),
		html_url: `https://github.com/o/r/releases/tag/${tag}`,
		assets: [{ name: 'Setup.exe', browser_download_url: `https://github.com/o/r/releases/download/${tag}/Setup.exe` }],
	};
}

suite('AbstractUpdateService (release updates)', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	let requests: IRequestOptions[];
	let response: { statusCode: number; body: unknown };

	function createService(product: Partial<IProductConfiguration>): TestReleaseUpdateService {
		requests = [];
		response = { statusCode: 200, body: [release(50), release(52), release(51)] };

		const configurationService = new TestConfigurationService();
		configurationService.setUserConfiguration('update.mode', 'manual');

		const requestService = {
			request: async (options: IRequestOptions): Promise<IRequestContext> => {
				requests.push(options);
				return { res: { statusCode: response.statusCode, headers: {} }, stream: bufferToStream(VSBuffer.fromString(JSON.stringify(response.body))) };
			}
		} as unknown as IRequestService;

		const productService = {
			commit: 'abc123',
			version: '1.143.0',
			releaseUpdates: { url: releasesUrl, assets: { 'test-x64': 'Setup.exe' } },
			buildNumber: 50,
			...product,
		} as unknown as IProductService;

		return store.add(new TestReleaseUpdateService(
			{ when: () => Promise.resolve(), quit: () => Promise.resolve(false), onWillShutdown: Event.None } as unknown as ILifecycleMainService,
			configurationService,
			{ isBuilt: true, disableUpdates: false } as unknown as IEnvironmentMainService,
			requestService,
			store.add(new NullLogService()),
			productService,
			NullTelemetryService,
			{ whenReady: Promise.resolve(), get: () => undefined, store: () => { } } as unknown as IApplicationStorageMainService,
			{ isConnectionMetered: false, whenConnectionStateInitialized: Promise.resolve(), onDidChangeIsConnectionMetered: Event.None } as unknown as IMeteredConnectionService,
			false
		));
	}

	test('enables updates without an update server or quality', async () => {
		const service = createService({});
		await service.whenInitialized;

		assert.strictEqual(service.state.type, StateType.Idle);
		assert.strictEqual(service.feedUrl(), `${releasesUrl}?per_page=20`);
	});

	test('stays disabled for builds without a build number', async () => {
		const service = createService({ buildNumber: undefined });
		await service.whenInitialized;

		assert.deepStrictEqual(service.state, { type: StateType.Disabled, reason: DisablementReason.MissingConfiguration });
	});

	test('accepts plain http only for a local test server', async () => {
		const local = createService({ releaseUpdates: { url: 'http://127.0.0.1:8123/releases', assets: {} } });
		await local.whenInitialized;

		assert.strictEqual(local.feedUrl(), 'http://127.0.0.1:8123/releases?per_page=20');
	});

	test('rejects a releases URL that is not https', async () => {
		const service = createService({ releaseUpdates: { url: 'http://api.github.com/repos/o/r/releases', assets: {} } });
		await service.whenInitialized;

		assert.deepStrictEqual(service.state, { type: StateType.Disabled, reason: DisablementReason.InvalidConfiguration });
	});

	test('downloads the newest installer', async () => {
		const service = createService({});
		const update = await service.fetchUpdate();

		assert.strictEqual(update?.url, 'https://github.com/o/r/releases/download/v1.143.0-build.52/Setup.exe');
		assert.strictEqual(update?.version, release(52).target_commitish);
		assert.strictEqual(requests[0].headers?.Accept, 'application/vnd.github+json');
	});

	test('links archives to the release page', async () => {
		const service = createService({});
		service.updateType = UpdateType.Archive;
		const update = await service.fetchUpdate();

		assert.strictEqual(update?.url, 'https://github.com/o/r/releases/tag/v1.143.0-build.52');
	});

	test('reports no update on the newest build or for platforms without an asset', async () => {
		assert.strictEqual(await createService({ buildNumber: 52 }).fetchUpdate(), null);
		assert.strictEqual(await createService({ releaseUpdates: { url: releasesUrl, assets: { 'other-x64': 'Setup.exe' } } }).fetchUpdate(), null);
	});

	test('explains rate limiting', async () => {
		const service = createService({});
		response = { statusCode: 403, body: { message: 'API rate limit exceeded' } };

		await assert.rejects(service.fetchUpdate(), /GitHub is limiting requests/);
	});

	test('a downloaded update is the latest while no newer release exists', async () => {
		const service = createService({});
		await service.whenInitialized;

		assert.strictEqual(await service.isLatest(release(52).target_commitish), true);
		assert.strictEqual(await service.isLatest(release(51).target_commitish), false);
	});
});
