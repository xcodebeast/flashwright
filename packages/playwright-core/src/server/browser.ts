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

export interface BrowserProcess {
  onclose?: ((exitCode: number | null, signal: string | null) => void);
  process?: ChildProcess;
  kill(): Promise<void>;
  close(): Promise<void>;
  // Flashwright: kills the browser and removes its temporary directories without waiting for it
  // to exit.
  killAndCleanup?(): void;
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
  private _contextForReuse: { context: BrowserContext, hash: string } | undefined;
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
    if (this._contextForReuse && hash === this._contextForReuse.hash && this._contextForReuse.context.canResetForReuse()) {
      if (await this._contextForReuse.context.resetForReuse(progress, params))
        return this._contextForReuse.context;
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
    this._contextForReuse = { context, hash };
    return context;
  }

  contextForReuse() {
    return this._contextForReuse?.context;
  }

  // Flashwright: a browser started before the test runner knows what its tests need creates the
  // recycled context the same tests asked for last time and starts preparing the tab for the first
  // test. Clients do not see the context until a test asks for it (newContextForReuse); a test
  // asking for a different one gets a new context and this one closes.
  async prepareRecycledContext(params: channels.BrowserNewContextForRecycleParams) {
    if (this._contextForReuse)
      return;
    const context = await this.newContext(nullProgress, params, true /* recycle */, false /* announce */);
    this._contextForReuse = { context, hash: BrowserContext.reusableContextHash(params) + ':recycle' };
    context.startRecycle();
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
