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

import type * as types from './types';
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
  // Flashwright: the recycled context of a browser handed over by another process.
  adoptContext?: BrowserHandoffMetadata['context'];
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
  private _contextForReuse: { context: BrowserContext, hash: string, prepared?: boolean } | undefined;
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

  async newContextForReuse(progress: Progress, params: channels.BrowserNewContextForReuseParams, recycle = false): Promise<BrowserContext> {
    // Flashwright: recycled contexts (see BrowserContext.setRecycleMode) never stand in for reused ones.
    const hash = BrowserContext.reusableContextHash(params) + (recycle ? ':recycle' : '');
    const reuse = this._contextForReuse;
    // Flashwright: a context prepared ahead of time has no storage; it takes this test's storage state.
    const takesStorageState = !!reuse?.prepared && !!params.storageState && reuse.hash === BrowserContext.reusableContextHash({ ...params, storageState: undefined }) + ':recycle';
    if (reuse && (hash === reuse.hash || takesStorageState) && reuse.context.canResetForReuse()) {
      if (await reuse.context.resetForReuse(progress, params)) {
        if (takesStorageState)
          await reuse.context.applyPreparedStorageState(progress, params.storageState!);
        else
          await progress.race(reuse.context.discardPreparedStorageStatePage());
        this._contextForReuse = { context: reuse.context, hash };
        return reuse.context;
      }
    }
    if (this._contextForReuse) {
      // Flashwright: a recycled context that does not fit this test (prepared ahead of time for other
      // options, or the previous test's) records nothing, so it closes in the background.
      if (this._contextForReuse.hash.endsWith(':recycle'))
        this._contextForReuse.context.close(nullProgress, { reason: 'Context reused' }).catch(() => {});
      else
        await this._contextForReuse.context.close(progress, { reason: 'Context reused' });
    }
    const context = await this.newContext(progress, params, recycle);
    context.reuseParams = params;
    this._contextForReuse = { context, hash };
    return context;
  }

  contextForReuse() {
    return this._contextForReuse?.context;
  }

  // Flashwright: a browser started before the test runner knows what its tests need creates the
  // recycled context the same tests asked for last time, without storage state, and starts preparing
  // the tab for the first test. Clients do not see the context until a test asks for it
  // (newContextForReuse), which also applies the test's storage state; a test asking for a different
  // context gets a new one and this one closes.
  async prepareRecycledContext(params: channels.BrowserNewContextForRecycleParams, options: { storageState?: boolean } = {}) {
    const reuse = this._contextForReuse;
    if (reuse) {
      // A context handed over by another process (see adoptHandedOverContext) still needs the tab
      // that restores the tests' storage state.
      if (reuse.prepared && options.storageState && reuse.hash === BrowserContext.reusableContextHash(params) + ':recycle')
        reuse.context.prepareStorageStatePage();
      return;
    }
    const context = await this.newContext(nullProgress, params, true /* recycle */, false /* announce */);
    context.reuseParams = params;
    this._contextForReuse = { context, hash: BrowserContext.reusableContextHash(params) + ':recycle', prepared: true };
    context.startRecycle();
    // The tests used a storage state last time: also open the page that will restore it.
    if (options.storageState)
      context.prepareStorageStatePage();
  }

  // Flashwright: a browser handed over by another process brings the context its tests used, with
  // the tab that keeps the renderer warm. It becomes the prepared recycled context, like
  // prepareRecycledContext's, and is reset once more before a test takes it.
  async adoptHandedOverContext(handedOver: BrowserHandoffMetadata['context']) {
    const params = { ...handedOver.params };
    const options = { ...params } as types.BrowserContextOptions;
    validateBrowserContextOptions(options, this.options);
    const context = await this.doAdoptContext(handedOver.id, options);
    context.reuseParams = params;
    context.setRecycleMode(true);
    context.addVisitedOrigins(handedOver.origins);
    this._contextForReuse = { context, hash: BrowserContext.reusableContextHash(params) + ':recycle', prepared: true };
  }

  // Called once the handed-over context's existing tab is attached.
  startAdoptedContextRecycle() {
    if (this._contextForReuse?.prepared)
      this._contextForReuse.context.startRecycle();
  }

  // Flashwright: in a warm test session, the worker that launched this browser hands it to the
  // next run instead of closing it (see browserHandoff.ts). Only a browser whose one open context
  // is the recycled one, reset and healthy, is handed over; anything else returns undefined and
  // the caller closes the browser as usual. Afterwards this object is disconnected from it.
  // A headed browser is not handed over: its window would stay open between runs.
  async handoffForSession(): Promise<BrowserHandoff | undefined> {
    const reuse = this._contextForReuse;
    const release = this.options.browserProcess.release;
    if (!release || !this.options.launchKey || this.options.persistent || this.options.headful || this._startedClosing || !this.isConnected())
      return;
    if (!reuse || !reuse.hash.endsWith(':recycle') || this.contexts().some(context => context !== reuse.context))
      return;
    const handedOverContext = await reuse.context.prepareForHandoff();
    if (!handedOverContext)
      return;
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
        context: handedOverContext,
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
