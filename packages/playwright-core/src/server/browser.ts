/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import fs from 'fs';

import { makeSocketPath } from '@utils/fileUtils';
import { createGuid } from '@utils/crypto';
import { monotonicTime } from '@isomorphic/time';
import { BrowserContext, validateBrowserContextOptions } from './browserContext';
import { Download } from './download';
import { SdkObject } from './instrumentation';
import { Page } from './page';
import { ClientCertificatesProxy } from './socksClientCertificatesInterceptor';
import { PlaywrightPipeServer } from '../remote/playwrightPipeServer';
import { PlaywrightWebSocketServer } from '../remote/playwrightWebSocketServer';
import { BrowserInfo, serverRegistry } from '../serverRegistry';
import { nullProgress } from './progress';
import { TargetClosedError } from './errors';
import { watchFirstNavigation } from './pagePreload';

import type * as types from './types';
import type { PreloadHint } from './browserContext';
import type { ProxySettings } from './types';
import type { RecentLogsCollector } from '@utils/debugLogger';
import type * as channels from './channels';
import type { ChildProcess } from 'child_process';
import type { Language } from '@isomorphic/locatorGenerators';
import type { Progress } from './progress';
import type * as playwright from '../..';
import type { BrowserHandoff, BrowserHandoffMetadata } from './browserHandoff';

export interface BrowserProcess {
  onclose?: ((exitCode: number | null, signal: string | null) => void);
  process?: ChildProcess;
  kill(): Promise<void>;
  close(): Promise<void>;
  // Flashwright: kills the browser and removes its temporary directories without waiting for it
  // to exit.
  killAndCleanup?(): void;
  // Flashwright: stops tracking the process, which another Node process takes over (see
  // browserHandoff.ts).
  release?(): { pid: number, tempDirectories: string[] };
}

export type BrowserOptions = {
  name: string,
  browserType: 'chromium' | 'firefox' | 'webkit',
  channel?: string,
  artifactsDir: string;
  downloadsPath: string,
  tracesDir: string,
  headful?: boolean,
  persistent?: types.BrowserContextOptions,  // Undefined means no persistent context.
  browserProcess: BrowserProcess,
  customExecutablePath?: string;
  proxy?: ProxySettings,
  protocolLogger: types.ProtocolLogger,
  browserLogsCollector: RecentLogsCollector,
  slowMo?: number;
  wsEndpoint?: string;
  sdkLanguage?: Language;
  originalLaunchOptions: types.LaunchOptions;
  userDataDir?: string;
  noDefaults?: boolean;
  isWebView?: boolean;
  // Do not send Inspector.enable to detect pages without a renderer while connecting.
  noInspectorEnableOnConnect?: boolean;
  // Flashwright: what a browser handed over to another process must match (see browserHandoff.ts).
  launchKey?: string;
  // Flashwright: the recycled contexts of a browser handed over by another process.
  adoptContexts?: BrowserHandoffMetadata['contexts'];
};

// Flashwright: what a browser keeps for one user of recycled contexts. The test runner's workers that
// share a process also share its browser (see its workersPerProcess option): each one has a slot of
// its own, the default slot '' otherwise.
type ReuseSlot = {
  contextForReuse?: { context: BrowserContext, hash: string, prepared?: boolean };
  // preloadPages (see pagePreload.ts): the second recycled context, whose tab loads the next test's
  // page while the current test uses the other one.
  standby?: { context: BrowserContext, hash: string };
  creatingStandby: boolean;
  // The latest hint, while the second context is being created.
  standbyHint?: PreloadHint;
  preloading: boolean;
  lastRecycleParams?: channels.BrowserNewContextForReuseParams;
  takenAt: number;
  firstNavigationUrl?: string;
  lastFirstNavigationUrl?: string;
};

export abstract class Browser extends SdkObject {

  static Events = {
    Context: 'context',
    Disconnected: 'disconnected',
  };

  readonly options: BrowserOptions;
  private _downloads = new Map<string, Download>();
  _defaultContext: BrowserContext | null = null;
  private _startedClosing = false;
  private _slots = new Map<string, ReuseSlot>();
  private _loadDurations = new Map<string, number>();
  _closeReason: string | undefined;
  _isBrowserCollocatedWithServer: boolean = true;
  private _server: BrowserServer;

  constructor(parent: SdkObject, options: BrowserOptions) {
    super(parent, 'browser');
    this.attribution.browser = this;
    this.options = options;
    this.instrumentation.onBrowserOpen(this);
    this._server = new BrowserServer(this);
  }

  abstract doCreateNewContext(options: types.BrowserContextOptions): Promise<BrowserContext>;
  // Flashwright: see handoffForSession and adoptHandedOverContext.
  doAdoptContext(contextId: string, options: types.BrowserContextOptions): Promise<BrowserContext> {
    throw new Error('Not supported');
  }
  async doDetachForHandoff(): Promise<{ write: NodeJS.WritableStream, read: NodeJS.ReadableStream } | undefined> {
    return undefined;
  }
  abstract contexts(): BrowserContext[];
  abstract isConnected(): boolean;
  abstract version(): string;
  abstract userAgent(): string;

  sdkLanguage() {
    return this.options.sdkLanguage || this.attribution.playwright.options.sdkLanguage;
  }

  async newContext(progress: Progress, options: types.BrowserContextOptions, recycle = false, announce = true): Promise<BrowserContext> {
    validateBrowserContextOptions(options, this.options);
    let clientCertificatesProxy: ClientCertificatesProxy | undefined;
    let context: BrowserContext | undefined;
    try {
      if (options.clientCertificates?.length) {
        clientCertificatesProxy = await ClientCertificatesProxy.create(progress, { ...options, proxy: options.proxy || this.options.proxy });
        options = { ...options, proxyOverride: clientCertificatesProxy.proxySettings(), internalIgnoreHTTPSErrors: true };
      }
      context = await progress.race(this.doCreateNewContext(options));
      context._clientCertificatesProxy = clientCertificatesProxy;
      if (recycle) {
        context.setRecycleMode(true);
        await context.openFirstHeldPage(progress);
      }
      if ((options as any).__testHookBeforeSetStorageState)
        await progress.race((options as any).__testHookBeforeSetStorageState());
      await context.setStorageState(progress, options.storageState, 'initial');
      if (announce)
        this.emit(Browser.Events.Context, context);
      return context;
    } catch (error) {
      await context?.close(progress, { reason: 'Failed to create context' }).catch(() => {});
      await clientCertificatesProxy?.close().catch(() => {});
      throw error;
    }
  }

  private _slot(key: string): ReuseSlot {
    let slot = this._slots.get(key);
    if (!slot) {
      slot = { creatingStandby: false, preloading: false, takenAt: 0 };
      this._slots.set(key, slot);
    }
    return slot;
  }

  async newContextForReuse(progress: Progress, params: channels.BrowserNewContextForReuseParams, recycle = false, slotKey = ''): Promise<BrowserContext> {
    const slot = this._slot(slotKey);
    if (recycle)
      slot.lastRecycleParams = params;
    if (recycle && slot.standby)
      this._swapStandby(slot, BrowserContext.reusableContextHash(params) + ':recycle');
    const context = await this._newContextForReuse(progress, params, recycle, slotKey);
    if (recycle && slot.preloading)
      this._contextTaken(slot, context);
    return context;
  }

  // Flashwright: a browser that preloads alternates between its two recycled contexts. The one the
  // previous test used is being reset; the other one has the tab this test gets, maybe preloaded.
  private _swapStandby(slot: ReuseSlot, hash: string) {
    const standby = slot.standby!;
    const current = slot.contextForReuse;
    if (standby.hash !== hash || !standby.context.canResetForReuse()) {
      // A test with other options: what the second context prepared is of no use.
      slot.standby = undefined;
      standby.context.close(nullProgress, { reason: 'Context reused' }).catch(() => {});
      return;
    }
    if (!current || current.hash !== hash || current.prepared)
      return;
    slot.standby = { context: current.context, hash: current.hash };
    slot.contextForReuse = standby;
  }

  private _contextTaken(slot: ReuseSlot, context: BrowserContext) {
    slot.takenAt = monotonicTime();
    slot.firstNavigationUrl = undefined;
    watchFirstNavigation(context);
  }

  // Flashwright: preloadPages. Called by the test runner when a test takes its recycled context:
  // the tab the next test gets loads `path` (or, without one, the URL this test navigates to first)
  // in the second recycled context, created on the first call.
  async preloadNextPage(params: channels.BrowserPreloadNextPageParams) {
    const slotKey = params.slot ?? '';
    const slot = this._slot(slotKey);
    const current = slot.contextForReuse;
    const reuseParams = slot.lastRecycleParams;
    if (!current || !current.hash.endsWith(':recycle') || !current.context.isRecycleMode() || !reuseParams)
      return;
    if (!slot.preloading) {
      slot.preloading = true;
      this._contextTaken(slot, current.context);
    }
    const hint = { path: params.path, expectedEnd: params.expectedDuration === undefined ? undefined : slot.takenAt + params.expectedDuration };
    if (slot.standby) {
      slot.standby.context.setPreloadHint(hint);
      return;
    }
    slot.standbyHint = hint;
    if (slot.creatingStandby)
      return;
    slot.creatingStandby = true;
    try {
      const context = await this.newContext(nullProgress, reuseParams, true /* recycle */, false /* announce */);
      context.reuseParams = reuseParams;
      context.reuseSlot = slotKey;
      context.markRecycled();
      slot.standby = { context, hash: current.hash };
      context.setPreloadHint(slot.standbyHint!);
    } catch {
    } finally {
      slot.creatingStandby = false;
      slot.standbyHint = undefined;
    }
  }

  // Called by the first navigation of the test that uses a recycled context.
  onFirstNavigation(context: BrowserContext, url: string) {
    const slot = this._slots.get(context.reuseSlot);
    if (!slot || context !== slot.contextForReuse?.context)
      return;
    slot.firstNavigationUrl = url;
    if (/^https?:/.test(url))
      slot.lastFirstNavigationUrl = url;
    slot.standby?.context.schedulePreload();
  }

  // The URL a preload hint of `context` stands for (see BrowserContext.setPreloadHint).
  preloadUrl(context: BrowserContext, path: string | undefined): string | undefined {
    const slot = this._slots.get(context.reuseSlot);
    if (path === undefined)
      return slot?.firstNavigationUrl;
    if (!slot?.lastFirstNavigationUrl)
      return undefined;
    try {
      return new URL(path, slot.lastFirstNavigationUrl).href;
    } catch {
      return undefined;
    }
  }

  expectedLoadDuration(url: string): number | undefined {
    return this._loadDurations.get(normalizeURL(url));
  }

  recordLoadDuration(url: string, duration: number) {
    url = normalizeURL(url);
    const previous = this._loadDurations.get(url);
    this._loadDurations.delete(url);
    this._loadDurations.set(url, previous === undefined ? duration : (previous + duration) / 2);
    if (this._loadDurations.size > 200)
      this._loadDurations.delete(this._loadDurations.keys().next().value!);
  }

  private async _newContextForReuse(progress: Progress, params: channels.BrowserNewContextForReuseParams, recycle: boolean, slotKey: string): Promise<BrowserContext> {
    const slot = this._slot(slotKey);
    // Flashwright: recycled contexts (see BrowserContext.setRecycleMode) never stand in for reused ones.
    const hash = BrowserContext.reusableContextHash(params) + (recycle ? ':recycle' : '');
    const reuse = slot.contextForReuse;
    // Flashwright: a context prepared ahead of time has no storage; it takes this test's storage state.
    const takesStorageState = !!reuse?.prepared && !!params.storageState && reuse.hash === BrowserContext.reusableContextHash({ ...params, storageState: undefined }) + ':recycle';
    if (reuse && (hash === reuse.hash || takesStorageState) && reuse.context.canResetForReuse()) {
      if (await reuse.context.resetForReuse(progress, params)) {
        if (takesStorageState)
          await reuse.context.applyPreparedStorageState(progress, params.storageState!);
        else
          await progress.race(reuse.context.discardPreparedStorageStatePage());
        slot.contextForReuse = { context: reuse.context, hash };
        // Its events go to whoever took it, like for a context created for them.
        reuse.context.bindToCurrentAsyncContext();
        return reuse.context;
      }
    }
    if (slot.contextForReuse) {
      // Flashwright: a recycled context that does not fit this test (prepared ahead of time for other
      // options, or the previous test's) records nothing, so it closes in the background.
      if (slot.contextForReuse.hash.endsWith(':recycle'))
        slot.contextForReuse.context.close(nullProgress, { reason: 'Context reused' }).catch(() => {});
      else
        await slot.contextForReuse.context.close(progress, { reason: 'Context reused' });
    }
    const context = await this.newContext(progress, params, recycle);
    context.reuseParams = params;
    context.reuseSlot = slotKey;
    slot.contextForReuse = { context, hash };
    return context;
  }

  contextForReuse(slotKey = '') {
    return this._slots.get(slotKey)?.contextForReuse?.context;
  }

  // Whether `context` is the one its slot hands to the next test that asks.
  isContextForReuse(context: BrowserContext) {
    return this.contextForReuse(context.reuseSlot) === context;
  }

  // Flashwright: a browser started before the test runner knows what its tests need creates the
  // recycled context the same tests asked for last time, without storage state, and starts preparing
  // the tab for the first test. Clients do not see the context until a test asks for it
  // (newContextForReuse), which also applies the test's storage state; a test asking for a different
  // context gets a new one and this one closes.
  async prepareRecycledContext(params: channels.BrowserNewContextForRecycleParams, options: { storageState?: boolean } = {}) {
    const slot = this._slot('');
    const reuse = slot.contextForReuse;
    if (reuse) {
      // A context handed over by another process (see adoptHandedOverContext) still needs the tab
      // that restores the tests' storage state.
      if (reuse.prepared && options.storageState && reuse.hash === BrowserContext.reusableContextHash(params) + ':recycle')
        reuse.context.prepareStorageStatePage();
      return;
    }
    const context = await this.newContext(nullProgress, params, true /* recycle */, false /* announce */);
    context.reuseParams = params;
    slot.contextForReuse = { context, hash: BrowserContext.reusableContextHash(params) + ':recycle', prepared: true };
    context.startRecycle();
    // The tests used a storage state last time: also open the page that will restore it.
    if (options.storageState)
      context.prepareStorageStatePage();
  }

  // Flashwright: a browser handed over by another process brings the contexts its tests used, one
  // per slot, each with the tab that keeps its renderer warm. Each becomes the prepared recycled
  // context of its slot, like prepareRecycledContext's, and is reset once more before a test takes it.
  async adoptHandedOverContext(handedOver: BrowserHandoffMetadata['contexts'][number]) {
    const params = { ...handedOver.params };
    const options = { ...params } as types.BrowserContextOptions;
    validateBrowserContextOptions(options, this.options);
    const context = await this.doAdoptContext(handedOver.id, options);
    context.reuseParams = params;
    context.reuseSlot = handedOver.slot;
    context.setRecycleMode(true);
    context.addVisitedOrigins(handedOver.origins);
    this._slot(handedOver.slot).contextForReuse = { context, hash: BrowserContext.reusableContextHash(params) + ':recycle', prepared: true };
  }

  // Called once the handed-over contexts' existing tabs are attached.
  startAdoptedContextRecycle() {
    for (const slot of this._slots.values()) {
      if (slot.contextForReuse?.prepared)
        slot.contextForReuse.context.startRecycle();
    }
  }

  // Flashwright: in a warm test session, the worker that launched this browser hands it to the
  // next run instead of closing it (see browserHandoff.ts). Only a browser whose one open context
  // is the recycled one, reset and healthy, is handed over; anything else returns undefined and
  // the caller closes the browser as usual. Afterwards this object is disconnected from it.
  // A headed browser is not handed over: its window would stay open between runs.
  async handoffForSession(): Promise<BrowserHandoff | undefined> {
    // The second recycled context of a browser that preloads stays behind.
    const standbys: BrowserContext[] = [];
    for (const slot of this._slots.values()) {
      if (slot.standby)
        standbys.push(slot.standby.context);
      slot.standby = undefined;
      slot.preloading = false;
    }
    await Promise.all(standbys.map(context => context.close(nullProgress, { reason: 'Browser handed over' }).catch(() => {})));
    const release = this.options.browserProcess.release;
    if (!release || !this.options.launchKey || this.options.persistent || this.options.headful || this._startedClosing || !this.isConnected())
      return;
    const reused = [...this._slots.entries()].filter(([, slot]) => slot.contextForReuse);
    if (!reused.length || reused.some(([, slot]) => !slot.contextForReuse!.hash.endsWith(':recycle')))
      return;
    if (this.contexts().some(context => !reused.some(([, slot]) => slot.contextForReuse!.context === context)))
      return;
    const handedOverContexts: BrowserHandoffMetadata['contexts'] = [];
    for (const [key, slot] of reused) {
      const handedOverContext = await slot.contextForReuse!.context.prepareForHandoff();
      if (!handedOverContext)
        return;
      handedOverContexts.push({ slot: key, ...handedOverContext });
    }
    const pipes = await this.doDetachForHandoff().catch(() => undefined);
    if (!pipes)
      return;
    const { pid, tempDirectories } = release();
    this._startedClosing = true;
    return {
      ...pipes,
      metadata: {
        browserName: this.options.name,
        launchKey: this.options.launchKey,
        pid,
        tempDirectories,
        contexts: handedOverContexts,
      },
    };
  }

  // Flashwright: see BrowserContext.outputDirsChanged.
  async setOutputDirs(artifactsDir: string, tracesDir: string) {
    this.options.artifactsDir = artifactsDir;
    this.options.downloadsPath = artifactsDir;
    this.options.tracesDir = tracesDir;
    await Promise.all(this.contexts().map(context => context.outputDirsChanged()));
  }

  downloadCreated(page: Page, uuid: string, url: string, suggestedFilename?: string, downloadFilename?: string) {
    const download = new Download(page, this.options.downloadsPath || '', uuid, url, suggestedFilename, downloadFilename);
    this._downloads.set(uuid, download);
  }

  downloadFilenameSuggested(uuid: string, suggestedFilename: string) {
    const download = this._downloads.get(uuid);
    if (!download)
      return;
    download.filenameSuggested(suggestedFilename);
  }

  downloadFinished(uuid: string, error?: string) {
    const download = this._downloads.get(uuid);
    if (!download)
      return;
    download.artifact.reportFinished(error ? new Error(error) : undefined);
    this._downloads.delete(uuid);
  }

  async startServer(progress: Progress, title: string, options: channels.BrowserStartServerOptions): Promise<{ endpoint: string }> {
    return await progress.race(this._server.start(title, options));
  }

  async stopServer(progress: Progress): Promise<void> {
    await progress.race(this._server.stop());
  }

  protected didClose() {
    for (const context of this.contexts())
      context.browserClosed();
    if (this._defaultContext)
      this._defaultContext.browserClosed();
    for (const download of this._downloads.values())
      download.artifact.reportFinished(new TargetClosedError(undefined));
    this.stopServer(nullProgress).catch(() => {});
    this.emit(Browser.Events.Disconnected);
    this.instrumentation.onBrowserClose(this);
  }

  async close(progress: Progress, options: { reason?: string }) {
    return await progress.race(this._close(options));
  }

  private async _close(options: { reason?: string }) {
    if (!this._startedClosing) {
      if (options.reason)
        this._closeReason = options.reason;
      this._startedClosing = true;
      await this.options.browserProcess.close();
    }
    if (this.isConnected())
      await new Promise(x => this.once(Browser.Events.Disconnected, x));
  }

  // Flashwright: for a browser whose launching process is about to exit. Once its contexts have
  // closed, nothing in it needs the graceful shutdown, and waiting for it to exit would only delay
  // the exit; its temporary profile is removed right away.
  killForExit() {
    this._startedClosing = true;
    if (this.options.browserProcess.killAndCleanup)
      this.options.browserProcess.killAndCleanup();
    else
      this.options.browserProcess.kill().catch(() => {});
  }

  async killForTests(progress: Progress) {
    await progress.race(this.options.browserProcess.kill());
    if (this.isConnected())
      await progress.race(new Promise(x => this.once(Browser.Events.Disconnected, x)));
  }
}

export class BrowserServer {
  private _browser: Browser;
  private _pipeServer?: PlaywrightPipeServer;
  private _wsServer?: PlaywrightWebSocketServer;
  private _pipeSocketPath?: string;
  private _isStarted = false;

  constructor(browser: Browser) {
    this._browser = browser;
  }

  async start(title: string, options: channels.BrowserStartServerOptions): Promise<{ endpoint: string }> {
    if (this._isStarted)
      throw new Error(`Server is already started.`);
    this._isStarted = true;

    let endpoint: string;
    if (options.host !== undefined || options.port !== undefined) {
      this._wsServer = new PlaywrightWebSocketServer(this._browser, '/' + createGuid());
      endpoint = await this._wsServer.listen(options.port ?? 0, options.host);
    } else {
      this._pipeServer = new PlaywrightPipeServer(this._browser);
      this._pipeSocketPath = await this._socketPath();
      await this._pipeServer.listen(this._pipeSocketPath);
      endpoint = this._pipeSocketPath;
    }

    const browserInfo: BrowserInfo = {
      guid: this._browser.guid,
      browserName: this._browser.options.browserType,
      launchOptions: asClientLaunchOptions(this._browser.options.originalLaunchOptions),
      userDataDir: this._browser.options.userDataDir,
    };
    await serverRegistry.create(browserInfo, {
      title,
      endpoint,
      workspaceDir: options.workspaceDir,
      metadata: options.metadata,
    });
    return { endpoint };
  }

  async stop() {
    if (!this._browser.options.userDataDir)
      await serverRegistry.delete(this._browser.guid);
    if (this._pipeSocketPath && process.platform !== 'win32')
      await fs.promises.unlink(this._pipeSocketPath).catch(() => {});
    await this._pipeServer?.close();
    await this._wsServer?.close();
    this._pipeServer = undefined;
    this._wsServer = undefined;
    this._isStarted = false;
  }

  private async _socketPath() {
    return makeSocketPath('browser', this._browser.guid.slice(0, 14));
  }
}

function asClientLaunchOptions(serverOptions: types.LaunchOptions): playwright.LaunchOptions {
  return {
    ...serverOptions,
    env: serverOptions.env ? Object.fromEntries(serverOptions.env.map(({ name, value }) => [name, value])) : undefined,
  };
}

function normalizeURL(url: string): string {
  try {
    return new URL(url).href;
  } catch {
    return url;
  }
}
