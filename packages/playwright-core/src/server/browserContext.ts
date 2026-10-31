/**
 * Copyright 2017 Google Inc. All rights reserved.
 * Modifications copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { AsyncResource } from 'async_hooks';
import fs from 'fs';

import { rewriteErrorMessage } from '@utils/stackTrace';
import { monotonicTime } from '@isomorphic/time';
import { debugMode, isUnderTest } from '@utils/debug';
import { Clock } from './clock';
import { Credentials } from './credentials';
import { Debugger } from './debugger';
import { DialogManager } from './dialog';
import { BrowserContextAPIRequestContext } from './fetch';
import { helper } from './helper';
import { idleTrackerSource } from './idleDetector';
import { EventMap, SdkObject } from './instrumentation';
import * as network from './network';
import { InitScript } from './page';
import { Page, PageBinding } from './page';
import { RecorderApp } from './recorder/recorderApp';
import { Selectors } from './selectors';
import { Tracing } from './trace/recorder/tracing';
import * as rawStorageSource from '../generated/storageScriptSource';
import { nullProgress } from './progress';
import { PagePreload, unwatchFirstNavigation } from './pagePreload';

import type { Browser, BrowserOptions } from './browser';
import type { ConsoleMessage } from './console';
import type { Download } from './download';
import type * as frames from './frames';
import type { PageError } from './page';
import type { Progress } from './progress';
import type { ClientCertificatesProxy } from './socksClientCertificatesInterceptor';
import type { SerializedStorage } from '@injected/storageScript';
import type * as types from './types';
import type * as channels from './channels';
import type { HttpCredentials } from '@protocol/structs';
import type { BrowserHandoffMetadata } from './browserHandoff';

const BrowserContextEvent = {
  Console: 'console',
  Close: 'close',
  Page: 'page',
  // Can't use just 'error' due to node.js special treatment of error events.
  // @see https://nodejs.org/api/events.html#events_error_events
  PageError: 'pageerror',
  Request: 'request',
  Response: 'response',
  RequestFailed: 'requestfailed',
  RequestFinished: 'requestfinished',
  RequestAborted: 'requestaborted',
  RequestFulfilled: 'requestfulfilled',
  RequestContinued: 'requestcontinued',
  BeforeClose: 'beforeclose',
  PageClosed: 'pageclosed',
  InternalFrameNavigatedToNewDocument: 'internalframenavigatedtonewdocument',
  FrameAttached: 'frameattached',
  WebSocket: 'websocket',
} as const;

export type BrowserContextEventMap = {
  [BrowserContextEvent.Console]: [message: ConsoleMessage];
  [BrowserContextEvent.Close]: [];
  [BrowserContextEvent.Page]: [page: Page];
  [BrowserContextEvent.PageError]: [pageError: PageError, page: Page];
  [BrowserContextEvent.Request]: [request: network.Request];
  [BrowserContextEvent.Response]: [response: network.Response];
  [BrowserContextEvent.RequestFailed]: [request: network.Request];
  [BrowserContextEvent.RequestFinished]: [requestAndResponse: { request: network.Request, response: network.Response | null }];
  [BrowserContextEvent.RequestAborted]: [request: network.Request];
  [BrowserContextEvent.RequestFulfilled]: [request: network.Request];
  [BrowserContextEvent.RequestContinued]: [request: network.Request];
  [BrowserContextEvent.BeforeClose]: [];
  [BrowserContextEvent.PageClosed]: [page: Page];
  [BrowserContextEvent.InternalFrameNavigatedToNewDocument]: [frame: frames.Frame];
  [BrowserContextEvent.FrameAttached]: [frame: frames.Frame];
  [BrowserContextEvent.WebSocket]: [webSocket: network.WebSocket, page: Page];
};

export abstract class BrowserContext<EM extends EventMap = EventMap> extends SdkObject<BrowserContextEventMap | EM> {
  static Events = BrowserContextEvent;

  readonly _pageBindings = new Map<string, PageBinding>();
  readonly _options: types.BrowserContextOptions;
  readonly requestInterceptors: network.RouteHandler[] = [];
  private _isPersistentContext: boolean;
  private _closedStatus: 'open' | 'closing' | 'closed' = 'open';
  readonly _closePromise: Promise<Error>;
  private _closePromiseFulfill: ((error: Error) => void) | undefined;
  readonly _permissions = new Map<string, string[]>();
  readonly _downloads = new Set<Download>();
  readonly _browser: Browser;
  readonly _browserContextId: string | undefined;
  private _selectors: Selectors;
  private _origins = new Set<string>();
  readonly tracing: Tracing;
  readonly fetchRequest: BrowserContextAPIRequestContext;
  private _customCloseHandler?: () => Promise<any>;
  readonly _tempDirs: string[] = [];
  private _creatingStorageStatePage = false;
  bindingsInitScript?: InitScript;
  initScripts: InitScript[] = [];
  private _routesInFlight = new Set<network.Route>();
  private _debugger!: Debugger;
  _closeReason: string | undefined;
  readonly clock: Clock;
  readonly credentials: Credentials;
  _clientCertificatesProxy: ClientCertificatesProxy | undefined;
  private _playwrightBindingExposed?: Promise<void>;
  readonly dialogManager: DialogManager;
  private _consoleApiExposed = false;
  // Options that context methods can change after creation, restored when the context is recycled.
  private _recycleBaseline: Pick<types.BrowserContextOptions, 'geolocation' | 'extraHTTPHeaders' | 'offline' | 'httpCredentials'>;
  private _recyclingPrevented = false;
  private _preparingRecycledPage = false;
  // The next test's tab, opened during recycling and handed out by the first newPage() call.
  private _heldPage: Page | undefined;
  private _heldPageInitScripts: InitScript[] = [];
  private _heldPageEmulation = '';
  private _idleTrackerInstalled = false;
  private _preparedStorageStatePage: Promise<Page> | undefined;
  private _recycleMode = false;
  private _pendingRecycle: Promise<boolean> | undefined;
  private _recycling = false;
  // Flashwright: preloadPages (see pagePreload.ts). What the next test is expected to open first,
  // while this context waits for it as the browser's second recycled context.
  private _preloadHint: PreloadHint | undefined;
  private _preloadTimer: NodeJS.Timeout | undefined;
  // How the test using this context first navigated, and whether that was its first call.
  private _firstNavigation: { url: string, first: boolean } | undefined;
  private _calledBeforeFirstNavigation = false;
  // Flashwright: the options a recycled or reused context was created with (see Browser.newContextForReuse).
  reuseParams: channels.BrowserNewContextForReuseParams | undefined;
  // Flashwright: the slot whose recycled context this is (see Browser.newContextForReuse).
  reuseSlot = '';
  // Flashwright: the async context that created the context, or took it for reuse, where clients
  // get its events (see DispatcherConnection.sendEvent): the test runner's worker can run several
  // workers at once, each in an async context of its own, with one browser.
  asyncResource = new AsyncResource('BrowserContext');

  constructor(browser: Browser, options: types.BrowserContextOptions, browserContextId: string | undefined) {
    super(browser, 'browser-context');
    this.attribution.context = this;
    this._browser = browser;
    this._options = options;
    this._recycleBaseline = structuredClone({
      geolocation: options.geolocation,
      extraHTTPHeaders: options.extraHTTPHeaders,
      offline: options.offline,
      httpCredentials: options.httpCredentials,
    });
    this._browserContextId = browserContextId;
    this._isPersistentContext = !browserContextId;
    this._closePromise = new Promise(fulfill => this._closePromiseFulfill = fulfill);
    this._selectors = new Selectors(options.selectorEngines || [], options.testIdAttributeName);

    this.fetchRequest = new BrowserContextAPIRequestContext(this);
    this.tracing = new Tracing(this, browser.options.tracesDir);
    this.clock = new Clock(this);
    this.credentials = new Credentials(this);
    this.dialogManager = new DialogManager(this.instrumentation);
  }

  isPersistentContext(): boolean {
    return this._isPersistentContext;
  }

  selectors(): Selectors {
    return this._selectors;
  }

  async initialize() {
    if (this.attribution.playwright.options.isInternalPlaywright)
      return;
    // Debugger will pause execution upon page.pause in headed mode.
    this._debugger = new Debugger(this);

    // When paused, show inspector.
    const shouldEnableDebugger = !this.attribution.playwright.options.isServer && (isUnderTest() || !!this._browser.options.headful);
    // Flashwright: a context that was paused for debugging is closed at the end of its test.
    this._debugger.on(Debugger.Events.PausedStateChanged, () => this.preventRecycling());

    if (shouldEnableDebugger) {
      this._debugger.setPauseAt();
      this._debugger.on(Debugger.Events.PausedStateChanged, () => {
        if (this._debugger.isPaused())
          RecorderApp.show(this, {}).catch(() => {});
      });
    }

    // When PWDEBUG=1, show inspector for each context.
    if (debugMode() === 'inspector') {
      this._debugger.setPauseAt({ next: true });
      await RecorderApp.show(this, { pauseOnNextStatement: true });
    }

    if (debugMode() === 'console')
      await this._exposeConsoleApi();

    if (this._options.serviceWorkers === 'block')
      await this.addInitScript(nullProgress, `\nif (self.ServiceWorkerContainer) ServiceWorkerContainer.prototype.register = async () => { console.warn('Service Worker registration blocked by Playwright'); };\n`);

    await this._installIdleTrackerIfNeeded();

    if (this._options.permissions)
      await this.grantPermissions(this._options.permissions);
  }

  debugger(): Debugger {
    return this._debugger;
  }

  async exposeConsoleApi(progress: Progress) {
    await progress.race(this._exposeConsoleApi());
  }

  private async _exposeConsoleApi() {
    if (this._consoleApiExposed)
      return;
    this._consoleApiExposed = true;
    await this.extendInjectedScript(`
      function installConsoleApi(injectedScript) { injectedScript.consoleApi.install(); }
      module.exports = { default: () => installConsoleApi };
    `);
  }

  canResetForReuse(): boolean {
    if (this._closedStatus !== 'open')
      return false;
    return !this._recycleMode || !this._recyclingPrevented;
  }

  // Called when a test leaves state that a recycle cannot reliably clear, e.g. file: origins.
  preventRecycling() {
    this._recyclingPrevented = true;
  }

  // Flashwright: recycled contexts (the test runner's) hand out a new tab per test; contexts
  // reused through Playwright's own reuse API (VS Code, debug controller) keep their page.
  setRecycleMode(recycle: boolean) {
    this._recycleMode = recycle;
  }

  isRecycleMode(): boolean {
    return this._recycleMode;
  }

  // Called when the test using a recycled context ends: its pages close and the context is reset
  // right away, while the runner moves on to the next test, which then only waits for the rest.
  // Service workers the test started are stopped before it ends, like closing a context would:
  // then the returned promise settles once the reset is done.
  startRecycle(): Promise<unknown> | undefined {
    const hadServiceWorkers = this.hasServiceWorkers();
    this._clearPreloadTimer();
    unwatchFirstNavigation(this);
    this._recycling = true;
    this._pendingRecycle = this._recycle(nullProgress);
    this._pendingRecycle.then(recycled => {
      this._recycling = false;
      if (recycled)
        this.schedulePreload();
    }, () => {});
    return hadServiceWorkers ? this._pendingRecycle.catch(() => {}) : undefined;
  }

  // Flashwright: a context created to wait for a later test (see Browser.preloadNextPage) is as
  // good as one that was just recycled.
  markRecycled() {
    this._pendingRecycle = Promise.resolve(true);
  }

  // Flashwright: preloadPages. Called on the browser's second recycled context while the other one
  // runs a test: what the test after it will probably open first.
  setPreloadHint(hint: PreloadHint) {
    this._preloadHint = hint;
    this.schedulePreload();
  }

  // Starts loading the next test's page once this context is reset and the URL is known, timed to
  // finish shortly before the running test is expected to end.
  schedulePreload() {
    const hint = this._preloadHint;
    const page = this._heldPage;
    // Only the context waiting for the next test preloads, not one a test has taken.
    if (!hint || this._recycling || !page || page.preload || this._closedStatus !== 'open' || this._browser.isContextForReuse(this))
      return;
    const url = this._browser.preloadUrl(this, hint.path);
    if (!url)
      return;
    this._preloadHint = undefined;
    const delay = hint.expectedEnd === undefined ? 0 : Math.max(0, hint.expectedEnd - kPreloadHeadStart - (this._browser.expectedLoadDuration(url) ?? 0) - monotonicTime());
    this._clearPreloadTimer();
    this._preloadTimer = setTimeout(() => {
      this._preloadTimer = undefined;
      if (page === this._heldPage && !page.isClosedOrClosingOrCrashed() && !this._recycling && !this._browser.isContextForReuse(this))
        this._startPreload(page, url);
    }, delay);
  }

  private _clearPreloadTimer() {
    this._preloadHint = undefined;
    if (this._preloadTimer)
      clearTimeout(this._preloadTimer);
    this._preloadTimer = undefined;
  }

  private _startPreload(page: Page, url: string) {
    const preload = new PagePreload(page, url);
    page.preload = preload;
    preload.loaded().then(() => {
      if (page.preload !== preload)
        return;
      const duration = preload.loadDuration();
      if (duration !== undefined)
        this._browser.recordLoadDuration(url, duration);
      // What a goto could not report afterwards rules the document out.
      const others = this.possiblyUninitializedPages().filter(p => p !== page && !p.isStorageStatePage);
      if (others.length || this._downloads.size || this.hasServiceWorkers())
        preload.markUnusable();
      if (!this._browser.isContextForReuse(this))
        preload.discardIfUnusable();
    }, () => {});
  }

  // A preloaded document did something its goto could not report. A context that no test has
  // taken yet is reset right away; otherwise the goto or the next call does it.
  preloadBecameUnusable(preload: PagePreload) {
    if (!this._browser.isContextForReuse(this))
      preload.discard().catch(() => {});
  }

  // Called when one of this context's documents starts a service worker.
  markPreloadsUnusable() {
    for (const page of this.possiblyUninitializedPages())
      page.preload?.markUnusable();
  }

  // Flashwright: called when a client call is made before the test's first navigation, other than
  // the calls pagePreload.ts allows. A preloaded document has not seen it: put the page back.
  async callBeforeFirstNavigation() {
    this._calledBeforeFirstNavigation = true;
    // Made along with the first goto: not a test to preload either.
    if (this._firstNavigation)
      this._firstNavigation.first = false;
    await Promise.all(this.possiblyUninitializedPages().map(page => page.preload?.discard()));
  }

  // Called by the first goto of a page in a context waiting for it (see pagePreload.ts). Only that
  // frame's page may still show a preloaded document, if the frame is its main frame: the others
  // are put back before the navigation starts. Calls keep being checked until the goto is done
  // with the preload (see firstNavigationDone).
  async recordFirstNavigation(url: string, frame: frames.Frame) {
    this._firstNavigation = { url, first: !this._calledBeforeFirstNavigation };
    this._browser.onFirstNavigation(this, url);
    await Promise.all(this.possiblyUninitializedPages().map(page => page.preload && frame !== page.mainFrame() ? page.preload.discard() : undefined));
  }

  hasFirstNavigation(): boolean {
    return !!this._firstNavigation;
  }

  firstNavigationDone() {
    unwatchFirstNavigation(this);
  }

  // How the test that used this context navigated first; asked when it closes.
  takeFirstNavigation(): { url: string, first: boolean } | undefined {
    const firstNavigation = this._firstNavigation;
    this._firstNavigation = undefined;
    this._calledBeforeFirstNavigation = false;
    return firstNavigation;
  }

  // Flashwright: undoes a preload (see PagePreload.discard): the page becomes a blank tab with no
  // history, and what its document stored in this context is cleared like on recycling.
  async resetPreloadedPage(page: Page) {
    // A popup knows its opener once it is initialized.
    const others = this.possiblyUninitializedPages().filter(p => p !== page);
    await Promise.all(others.map(p => p.waitForInitializedOrError()));
    const popups = others.filter(p => openedBy(p, page));
    await Promise.all(popups.map(popup => popup.close(nullProgress, { reason: 'Preloaded page reset' }).catch(() => {})));
    await this.doResetPreloadedPage(page);
    page.clearPreloadedDocument();
    const downloads = [...this._downloads];
    this._downloads.clear();
    const origins = [...this._origins];
    this._origins = new Set();
    await Promise.all([
      ...downloads.map(download => download.artifact.deleteOnContextClose()),
      this.doClearCookies(),
      this.doClearSiteData(page, origins),
      this.doClearCacheThrough(page),
    ]);
    if (this._options.storageState)
      await this.setStorageState(nullProgress, this._options.storageState, 'initial');
  }

  // Flashwright: the context of a browser handed over by another process (see browserHandoff.ts)
  // clears the storage of the origins the previous process's tests used on its next reset.
  addVisitedOrigins(origins: string[]) {
    for (const origin of origins)
      this._origins.add(origin);
  }

  bindToCurrentAsyncContext() {
    this.asyncResource = new AsyncResource('BrowserContext');
  }

  // Flashwright: called before the browser is handed over to another process. Waits for the reset
  // that started when the last test ended and describes the context for the process that adopts it,
  // or returns undefined when it cannot move: it holds state that lives in this process (a client
  // certificate proxy, a HAR recording, a video) or that a reset cannot clear.
  async prepareForHandoff(): Promise<Omit<BrowserHandoffMetadata['contexts'][number], 'slot'> | undefined> {
    const params = this.reuseParams;
    if (!this._recycleMode || !this.supportsRecycling() || !params || !this._browserContextId || this._closedStatus !== 'open' || this._recyclingPrevented)
      return;
    if (this._clientCertificatesProxy || this.tracing.harRecorders.size || params.recordVideo)
      return;
    const pending = this._pendingRecycle;
    this._pendingRecycle = undefined;
    if (!await (pending ?? this._recycle(nullProgress)))
      return;
    const rest = { ...params };
    delete rest.storageState;
    if (!isPlainJSON(rest))
      return;
    return { id: this._browserContextId, params: rest, origins: [...this._origins] };
  }

  static reusableContextHash(params: channels.BrowserNewContextForReuseParams): string {
    const paramsCopy = { ...params };

    if (paramsCopy.selectorEngines?.length === 0)
      delete paramsCopy.selectorEngines;

    for (const k of Object.keys(paramsCopy)) {
      const key = k as keyof channels.BrowserNewContextForReuseParams;
      if (paramsCopy[key] === defaultNewContextParamValues[key])
        delete paramsCopy[key];
    }

    for (const key of paramsThatAllowContextReuse)
      delete paramsCopy[key];
    return JSON.stringify(paramsCopy);
  }

  // Returns false when the context could not be recycled and should be replaced by a new one.
  // Flashwright: lets assertions tell when nothing can change the page any more (see IdleDetector).
  // A reused context may turn the option on later; once installed, the tracker stays.
  private async _installIdleTrackerIfNeeded() {
    if (!this._options.failFastWhenIdle || this._idleTrackerInstalled)
      return;
    this._idleTrackerInstalled = true;
    await this.addInitScript(nullProgress, idleTrackerSource);
  }

  async resetForReuse(progress: Progress, params: channels.BrowserNewContextForReuseParams | null): Promise<boolean> {
    // A recycle started when the previous test ended must finish before this test's options apply.
    const recycling = this._recycleMode && this.supportsRecycling();
    const pendingRecycle = recycling ? this._pendingRecycle : undefined;
    this._pendingRecycle = undefined;
    this._clearPreloadTimer();
    this._firstNavigation = undefined;
    this._calledBeforeFirstNavigation = false;
    if (pendingRecycle && !await progress.race(pendingRecycle))
      return false;
    // A preload being undone may still have a popup or service worker to remove.
    const discarding = this._heldPage?.preload?.pendingDiscard();
    if (discarding)
      await progress.race(discarding);

    await this.tracing.resetForReuse(progress);
    await this.fetchRequest.tracing().resetForReuse(progress);

    if (params) {
      for (const key of paramsThatAllowContextReuse)
        (this._options as any)[key] = params[key];
      if (params.testIdAttributeName)
        this.selectors().setTestIdAttributeName(params.testIdAttributeName);
      await progress.race(this._installIdleTrackerIfNeeded());
    }

    if (recycling)
      return pendingRecycle ? true : await this._recycle(progress);

    // Close extra pages early.
    let page: Page | undefined = this.pages()[0];
    const otherPages = this.possiblyUninitializedPages().filter(p => p !== page);
    for (const p of otherPages)
      await p.close(progress);
    if (page && page.isClosedOrClosingOrCrashed()) {
      await page.close(progress);
      page = undefined;
    }

    // Navigate to about:blank first to ensure no page scripts are running after this point.
    // Flashwright: a page left in an endless script cannot navigate; the context is replaced instead.
    if (page) {
      const navigated = page.mainFrame().gotoImpl(progress, 'about:blank', {}).then(() => true, () => false);
      if (!await progress.race(raceWithTimeout(navigated, kReusedPageNavigationTimeout, false)))
        return false;
    }

    // Note: we only need to reset properties from the "paramsThatAllowContextReuse" list.
    // All other properties force a new context.
    await this.clock.uninstall(progress);
    // Flashwright: and what the previous test changed with context methods (see _recycleBaseline).
    await this._restoreRecycleBaseline(progress);
    await progress.race(this.setUserAgent(this._options.userAgent));
    await progress.race(this.doUpdateDefaultEmulatedMedia());
    await progress.race(this.doUpdateDefaultViewport());
    await this.setStorageState(progress, this._options.storageState, 'resetForReuse');

    await page?.resetForReuse(progress);
    return true;
  }

  // Flashwright: hand a used context to the next test as if it were new. The next test gets a
  // brand-new tab, opened before the previous pages close so the renderer process (and the
  // application code it already compiled) stays warm. Everything the previous test could have
  // changed is put back: options, permissions, cookies, per-origin storage and caches.
  private async _recycle(progress: Progress): Promise<boolean> {
    // In a healthy browser this takes a few milliseconds. If the previous test left something that
    // keeps it from finishing (a hung renderer, a stuck dialog or request), replace the context
    // instead of waiting on it.
    let storageStatePage: Promise<Page | undefined> | undefined;
    const reset = this._resetForRecycle(progress, page => storageStatePage = page.catch(() => undefined));
    reset.catch(() => {});
    if (!await progress.race(raceWithTimeout(reset, kRecycleTimeout, false)))
      return false;

    const state = this._options.storageState;
    if (state?.credentials?.length)
      this.credentials.clear();
    else
      await this.credentials.dispose(progress);
    if (state)
      await this.setStorageState(progress, state, 'initial', await storageStatePage);
    return true;
  }

  // A reused context keeps its page, which needs the options that context methods changed put back.
  private async _restoreRecycleBaseline(progress: Progress) {
    const baseline = structuredClone(this._recycleBaseline);
    const changed = (key: keyof typeof baseline) => JSON.stringify(this._options[key]) !== JSON.stringify(baseline[key]);
    if (changed('extraHTTPHeaders')) {
      this._options.extraHTTPHeaders = baseline.extraHTTPHeaders;
      await progress.race(this.doUpdateExtraHTTPHeaders());
    }
    if (changed('offline')) {
      this._options.offline = baseline.offline;
      await progress.race(this.doUpdateOffline());
    }
    if (changed('geolocation'))
      await progress.race(this.setGeolocation(baseline.geolocation));
    if (changed('httpCredentials'))
      await this.setHTTPCredentials(progress, baseline.httpCredentials);
    if (this._permissions.size) {
      this._permissions.clear();
      await progress.race(this.doClearPermissions());
      if (this._options.permissions)
        await progress.race(this.grantPermissions(this._options.permissions));
    }
  }

  private async _resetForRecycle(progress: Progress, onStorageStatePage: (page: Promise<Page>) => void): Promise<boolean> {
    Object.assign(this._options, structuredClone(this._recycleBaseline));
    await this.clock.uninstall(progress);
    await progress.race(this.dialogManager.dismissAllDialogs());

    // The new tab shares its renderer with the previous test's pages. If that renderer was left
    // busy (an endless script, a stuck dialog), the tab cannot come up; replace the whole context
    // instead, which kills the renderer just like closing the context would.
    const previousPages = this.possiblyUninitializedPages();
    // Closing a page is acknowledged by the browser before the renderer tears it down, so its
    // scripts could still write storage after the clearing below; stop them first.
    let scriptsStopped!: () => void;
    const scriptsStoppedPromise = new Promise<void>(f => scriptsStopped = f);
    const stopped = this.doStopPages(previousPages.filter(p => !p.isClosedOrClosingOrCrashed()), scriptsStopped);
    stopped.catch(() => {});
    // Opening a tab keeps the browser busy for a while, also from relaying the answers that tell
    // the previous pages run no scripts anymore: it waits for them.
    const newPage = scriptsStoppedPromise.then(() => this._openHeldPage(progress));
    newPage.catch(() => {});
    // Stopped pages run no scripts: they close while everything they could have changed is put
    // back. What needs no page starts right away, the rest once the new tab is up.
    const reset = stopped.then(() => {
      const downloads = [...this._downloads];
      this._downloads.clear();
      this._permissions.clear();
      const origins = [...this._origins];
      this._origins = new Set();
      const closed = Promise.all(previousPages.map(p => p.close(progress, { reason: 'Context recycled' }).catch(() => {})));
      const done = Promise.all([
        closed.then(() => Promise.all(downloads.map(download => download.artifact.deleteOnContextClose()))),
        this.doClearPermissions().then(() => this._options.permissions ? this.grantPermissions(this._options.permissions) : undefined),
        this.doClearCookies(),
      ]);
      done.catch(() => {});
      return { origins, closed, done };
    });
    reset.catch(() => {});
    const page = await progress.race(raceWithTimeout(newPage, kRecycledPageTimeout, undefined));
    if (!page)
      return false;
    // The page that restores storageState's per-origin storage opens while the previous pages stop
    // and storage is cleared. Pages are created one at a time: creation marks which kind it is.
    if (this._options.storageState?.origins?.length)
      onStorageStatePage(this.newPage(progress, true /* forStorageState */));
    const { origins, closed, done } = await progress.race(reset);
    await progress.race(Promise.all([
      done,
      // A service worker survives the clearing of its origin's data while a page it controls is open.
      closed.then(() => this.doClearSiteData(page, origins)),
      this.doClearCacheThrough(page),
    ]));
    return true;
  }

  // Called when a recycled context is created: the first test's tab opens before storageState is
  // restored, so the page restoring it and the test's page share one renderer process.
  async openFirstHeldPage(progress: Progress) {
    if (this._recycleMode && this.supportsRecycling())
      await this._openHeldPage(progress);
  }

  // Opens the tab the next test gets. Nothing announces it until that test asks for a page.
  private async _openHeldPage(progress: Progress): Promise<Page> {
    this._heldPage = undefined;
    this._preparingRecycledPage = true;
    let page: Page;
    try {
      page = await this.newPage(progress);
    } finally {
      this._preparingRecycledPage = false;
    }
    this._heldPage = page;
    this._heldPageInitScripts = [...this.initScripts];
    this._heldPageEmulation = this._pageEmulationKey();
    return page;
  }

  // Flashwright: a browser launched before the test runner knew its output folders gets them when
  // the runner adopts it (see Browser.setOutputDirs); a context it prepared for the first test
  // then writes its traces and downloads there too.
  async outputDirsChanged() {
    this.tracing.setTracesDir(this._browser.options.tracesDir);
    this.fetchRequest.tracing().setTracesDir(this._browser.options.tracesDir);
  }

  // Recycling needs a backend that can clear all per-origin storage without navigating.
  supportsRecycling(): boolean {
    return false;
  }

  // Turns a page back into a blank tab without history, scripts enabled as configured.
  protected async doResetPreloadedPage(page: Page): Promise<void> {
    throw new Error('Not supported');
  }

  protected hasServiceWorkers(): boolean {
    return false;
  }

  protected async doClearSiteData(page: Page, origins: string[]): Promise<void> {
  }

  // Stops the pages' scripts and replaces their documents, calling onScriptsStopped in between.
  protected async doStopPages(pages: Page[], onScriptsStopped: () => void): Promise<void> {
    onScriptsStopped();
  }

  // Clears the caches as clearCache() does, through one page while the others may be closing.
  protected async doClearCacheThrough(page: Page): Promise<void> {
    await this.clearCache();
  }

  browserClosed() {
    for (const page of this.pages())
      page._didClose();
    this._didCloseInternal();
  }

  private _didCloseInternal() {
    if (this._closedStatus === 'closed') {
      // We can come here twice if we close browser context and browser
      // at the same time.
      return;
    }
    this._closedStatus = 'closed';
    this._clearPreloadTimer();
    unwatchFirstNavigation(this);
    this._clientCertificatesProxy?.close().catch(() => {});
    this.tracing.abort();
    this.fetchRequest.tracing().abort();
    this._closePromiseFulfill!(new Error('Context closed'));
    this.emit(BrowserContext.Events.Close);
  }

  pages(): Page[] {
    return this.possiblyUninitializedPages().filter(page => page.initializedOrUndefined());
  }

  // Flashwright: pages the context has announced. The tab a recycled context prepares for the next
  // test receives context state like any page, but observers that also listen for new pages only
  // see it once that test asks for a page.
  announcedPages(): Page[] {
    return this.pages().filter(page => !page.isHeldForRecycle());
  }

  // BrowserContext methods.
  abstract possiblyUninitializedPages(): Page[];
  abstract doCreateNewPage(): Promise<Page>;
  abstract addCookies(cookies: channels.SetNetworkCookie[]): Promise<void>;
  abstract setGeolocation(geolocation?: types.Geolocation): Promise<void>;
  abstract setUserAgent(userAgent: string | undefined): Promise<void>;
  abstract cancelDownload(uuid: string): Promise<void>;
  abstract clearCache(): Promise<void>;
  protected abstract doGetCookies(urls: string[]): Promise<channels.NetworkCookie[]>;
  protected abstract doClearCookies(): Promise<void>;
  protected abstract doGrantPermissions(origin: string, permissions: string[]): Promise<void>;
  protected abstract doClearPermissions(): Promise<void>;
  protected abstract doSetHTTPCredentials(httpCredentials?: HttpCredentials[]): Promise<void>;
  protected abstract doAddInitScript(initScript: InitScript): Promise<void>;
  protected abstract doRemoveInitScripts(initScripts: InitScript[]): Promise<void>;
  protected abstract doUpdateExtraHTTPHeaders(): Promise<void>;
  protected abstract doUpdateOffline(): Promise<void>;
  protected abstract doUpdateRequestInterception(): Promise<void>;
  protected abstract doUpdateDefaultViewport(): Promise<void>;
  protected abstract doUpdateDefaultEmulatedMedia(): Promise<void>;
  protected abstract doExposePlaywrightBinding(): Promise<void>;
  protected abstract doClose(reason: string | undefined): Promise<void | 'close-browser'>;

  async cookies(progress: Progress, urls: string | string[] | undefined = []): Promise<channels.NetworkCookie[]> {
    return await progress.race(this._cookies(urls));
  }

  private async _cookies(urls: string | string[] | undefined = []): Promise<channels.NetworkCookie[]> {
    if (urls && !Array.isArray(urls))
      urls = [urls];
    return await this.doGetCookies(urls as string[]);
  }

  async clearCookies(options: network.ClearCookiesOptions): Promise<void> {
    if (!network.hasClearCookiesFilter(options)) {
      await this.doClearCookies();
      return;
    }

    const currentCookies = await this._cookies();
    const cookiesToExpire = currentCookies.filter(cookie => network.cookieMatchesClearFilter(cookie, options));

    if (!cookiesToExpire.length)
      return;

    // Keep the original value: browsers reject or ignore cookies with both empty name and value.
    await this.addCookies(cookiesToExpire.map(cookie => ({
      ...cookie,
      expires: 0,
    })));
  }

  setHTTPCredentials(progress: Progress, httpCredentials?: HttpCredentials[]): Promise<void> {
    return progress.race(this.innerSetHTTPCredentials(httpCredentials));
  }

  innerSetHTTPCredentials(httpCredentials?: HttpCredentials[]): Promise<void> {
    return this.doSetHTTPCredentials(httpCredentials);
  }

  getBindingClient(name: string): unknown | undefined {
    return this._pageBindings.get(name)?.forClient;
  }

  async exposePlaywrightBindingIfNeeded() {
    this._playwrightBindingExposed ??= (async () => {
      await this.doExposePlaywrightBinding();

      this.bindingsInitScript = PageBinding.createInitScript(this);
      this.initScripts.push(this.bindingsInitScript);
      await this.doAddInitScript(this.bindingsInitScript);
      await this.safeNonStallingEvaluateInAllFrames(this.bindingsInitScript.source, 'main');
    })();
    return await this._playwrightBindingExposed;
  }

  needsPlaywrightBinding(): boolean {
    return this._playwrightBindingExposed !== undefined;
  }

  async exposeBinding(progress: Progress, name: string, playwrightBinding: frames.FunctionWithSource, forClient?: unknown, noGlobal?: boolean): Promise<PageBinding> {
    if (this._pageBindings.has(name))
      throw new Error(`Function "${name}" has been already registered`);
    for (const page of this.pages()) {
      if (page.getBinding(name))
        throw new Error(`Function "${name}" has been already registered in one of the pages`);
    }
    await progress.race(this.exposePlaywrightBindingIfNeeded());
    const binding = new PageBinding(this, name, playwrightBinding, noGlobal);
    binding.forClient = forClient;
    this._pageBindings.set(name, binding);
    try {
      await progress.race(this.doAddInitScript(binding.initScript));
      await progress.race(this.safeNonStallingEvaluateInAllFrames(binding.initScript.source, 'main'));
      return binding;
    } catch (error) {
      this._pageBindings.delete(name);
      throw error;
    }
  }

  async removeExposedBinding(binding: PageBinding) {
    if (this._pageBindings.get(binding.name) !== binding)
      return;
    this._pageBindings.delete(binding.name);
    await this.doRemoveInitScripts([binding.initScript]);
    const cleanup = `{ ${binding.cleanupScript} };`;
    await this.safeNonStallingEvaluateInAllFrames(cleanup, 'main');
  }

  async grantPermissions(permissions: string[], origin?: string) {
    let resolvedOrigin = '*';
    if (origin) {
      const url = new URL(origin);
      resolvedOrigin = url.origin;
    }
    const existing = new Set(this._permissions.get(resolvedOrigin) || []);
    permissions.forEach(p => existing.add(p));
    const list = [...existing.values()];
    this._permissions.set(resolvedOrigin, list);
    await this.doGrantPermissions(resolvedOrigin, list);
  }

  async clearPermissions() {
    this._permissions.clear();
    await this.doClearPermissions();
  }

  async setExtraHTTPHeaders(progress: Progress, headers: types.HeadersArray) {
    const oldHeaders = this._options.extraHTTPHeaders;
    this._options.extraHTTPHeaders = headers;
    try {
      await progress.race(this.doUpdateExtraHTTPHeaders());
    } catch (error) {
      this._options.extraHTTPHeaders = oldHeaders;
      // Note: no await, headers will be reset in the background as soon as possible.
      this.doUpdateExtraHTTPHeaders().catch(() => {});
      throw error;
    }
  }

  async setOffline(progress: Progress, offline: boolean) {
    const oldOffline = this._options.offline;
    this._options.offline = offline;
    try {
      await progress.race(this.doUpdateOffline());
    } catch (error) {
      this._options.offline = oldOffline;
      // Note: no await, offline will be reset in the background as soon as possible.
      this.doUpdateOffline().catch(() => {});
      throw error;
    }
  }

  async loadDefaultContextAsIs(progress: Progress): Promise<Page | undefined> {
    if (!this.possiblyUninitializedPages().length) {
      const waitForEvent = helper.waitForEvent(progress, this, BrowserContext.Events.Page);
      // Race against BrowserContext.close
      await progress.race(Promise.race([waitForEvent.promise, this._closePromise]));
    }
    const page = this.possiblyUninitializedPages()[0];
    if (!page)
      return;
    const pageOrError = await progress.race(page.waitForInitializedOrError());
    if (pageOrError instanceof Error)
      throw pageOrError;
    await page.mainFrame().waitForLoadState(progress, 'load');
    return page;
  }

  async loadDefaultContext(progress: Progress) {
    const defaultPage = await this.loadDefaultContextAsIs(progress);
    if (!defaultPage)
      return;
    const browserName = this._browser.options.name;
    if ((this._options.isMobile && browserName === 'chromium') || (this._options.locale && browserName === 'webkit')) {
      // Workaround for:
      // - chromium fails to change isMobile for existing page;
      // - webkit fails to change locale for existing page.
      await this.newPage(progress);
      await defaultPage.close(progress);
    }
  }

  protected authenticateProxyViaHeader() {
    const proxy = this._options.proxy || this._browser.options.proxy || { username: undefined, password: undefined };
    const { username, password } = proxy;
    if (username) {
      this._options.httpCredentials = [{ username, password: password! }];
      const token = Buffer.from(`${username}:${password}`).toString('base64');
      this._options.extraHTTPHeaders = network.mergeHeaders([
        this._options.extraHTTPHeaders,
        network.singleHeader('Proxy-Authorization', `Basic ${token}`),
      ]);
    }
  }

  protected authenticateProxyViaCredentials() {
    const proxy = this._options.proxy || this._browser.options.proxy;
    if (!proxy)
      return;
    const { username, password } = proxy;
    if (username)
      this._options.httpCredentials = [{ username, password: password || '' }];
  }

  async addInitScript(progress: Progress, source: string): Promise<InitScript> {
    return await progress.race(this._internalAddInitScript(source));
  }

  private async _internalAddInitScript(source: string) {
    const initScript = new InitScript(this, source);
    this.initScripts.push(initScript);
    try {
      await this.doAddInitScript(initScript);
      return initScript;
    } catch (error) {
      // Note: no await, init script will be removed in the background as soon as possible.
      initScript.dispose().catch(() => {});
      throw error;
    }
  }

  async removeInitScript(initScript: InitScript) {
    this.initScripts = this.initScripts.filter(script => initScript !== script);
    await this.doRemoveInitScripts([initScript]);
  }

  async addRequestInterceptor(progress: Progress, handler: network.RouteHandler): Promise<void> {
    // Note: progress is intentionally ignored, because this operation is not cancellable and should not block in the browser anyway.
    this.requestInterceptors.push(handler);
    await progress.race(this.doUpdateRequestInterception());
  }

  async removeRequestInterceptor(handler: network.RouteHandler): Promise<void> {
    const index = this.requestInterceptors.indexOf(handler);
    if (index === -1)
      return;
    this.requestInterceptors.splice(index, 1);
    await this.notifyRoutesInFlightAboutRemovedHandler(handler);
    await this.doUpdateRequestInterception();
  }

  isClosingOrClosed() {
    return this._closedStatus !== 'open';
  }

  private async _deleteAllDownloads(): Promise<void> {
    await Promise.all(Array.from(this._downloads).map(download => download.artifact.deleteOnContextClose()));
  }

  private async _deleteAllTempDirs(): Promise<void> {
    await Promise.all(this._tempDirs.map(async dir => await fs.promises.rm(dir, { recursive: true, force: true }).catch(e => {})));
  }

  setCustomCloseHandler(handler: (() => Promise<any>) | undefined) {
    this._customCloseHandler = handler;
  }

  async close(progress: Progress, options: { reason?: string }) {
    let flushError: Error | undefined;
    if (this._closedStatus === 'open') {
      if (options.reason)
        this._closeReason = options.reason;
      this.emit(BrowserContext.Events.BeforeClose);
      this._closedStatus = 'closing';

      await progress.race(Promise.all([
        this.tracing.flush().catch(e => flushError = flushError ?? e),
        this.fetchRequest.tracing().flush().catch(e => flushError = flushError ?? e),
      ]));
      await progress.race(Promise.all(this.pages().map(page => page.screencast.handlePageOrContextClose())));

      if (this._customCloseHandler) {
        await progress.race(this._customCloseHandler());
      } else {
        // Close the context.
        const disposition = await progress.race(this.doClose(options.reason));
        if (disposition === 'close-browser')
          await this._browser.close(progress, { reason: options.reason });
      }

      // We delete downloads after context closure
      // so that browser does not write to the download file anymore.
      const promises: Promise<void>[] = [];
      promises.push(this._deleteAllDownloads());
      promises.push(this._deleteAllTempDirs());
      await progress.race(Promise.all(promises));

      // Custom handler should trigger didCloseInternal itself.
      if (!this._customCloseHandler)
        this._didCloseInternal();
    }
    await this._closePromise;
    if (flushError)
      throw flushError;
  }

  async newPage(progress: Progress, forStorageState?: boolean): Promise<Page> {
    // Pages created to restore storage state must leave the recycled page for the test.
    const heldPage = forStorageState ? undefined : this._heldPage;
    let staleHeldPage: Page | undefined;
    if (heldPage) {
      this._heldPage = undefined;
      const sameInitScripts = this._heldPageInitScripts.length === this.initScripts.length && this._heldPageInitScripts.every((script, i) => script === this.initScripts[i]);
      if (!heldPage.isClosedOrClosingOrCrashed() && sameInitScripts && this._heldPageEmulation === this._pageEmulationKey()) {
        heldPage.revealHeldPage();
        return heldPage;
      }
      // Init scripts added since the page was prepared did not run in its first document, and
      // options the next test may change (viewport, media, user agent) were applied as they were.
      // Replace it, opening the new tab first to keep the renderer warm.
      staleHeldPage = heldPage;
    }
    try {
      return await this._createNewPage(progress, forStorageState);
    } finally {
      if (staleHeldPage)
        await staleHeldPage.close(progress, { reason: 'Replaced by a new page' }).catch(() => {});
    }
  }

  private _pageEmulationKey(): string {
    const { colorScheme, forcedColors, reducedMotion, contrast, screen, userAgent, viewport } = this._options;
    return JSON.stringify([colorScheme, forcedColors, reducedMotion, contrast, screen, userAgent, viewport]);
  }

  private async _createNewPage(progress: Progress, forStorageState?: boolean): Promise<Page> {
    let page: Page | undefined;
    try {
      this._creatingStorageStatePage = !!forStorageState;
      page = await progress.race(this.doCreateNewPage());
      const pageOrError = await progress.race(page.waitForInitializedOrError());
      if (pageOrError instanceof Page) {
        if (pageOrError.isClosed())
          throw new Error('Page has been closed.');
        return pageOrError;
      }
      throw pageOrError;
    } catch (error) {
      await page?.close(progress, { reason: 'Failed to create page' }).catch(() => {});
      throw error;
    } finally {
      this._creatingStorageStatePage = false;
    }
  }

  addVisitedOrigin(origin: string) {
    this._origins.add(origin);
  }

  visitedOrigins(): ReadonlySet<string> {
    return this._origins;
  }

  async storageState(progress: Progress, { indexedDB = false, opfs = false, credentials = false }: { indexedDB?: boolean, opfs?: boolean, credentials?: boolean } = {}): Promise<channels.BrowserContextStorageStateResult> {
    const result: channels.BrowserContextStorageStateResult = {
      cookies: await this.cookies(progress),
      origins: []
    };
    if (credentials)
      result.credentials = await progress.race(this.credentials.get());
    const originsToSave = new Set(this._origins);
    const hasStorage = (storage: SerializedStorage) => !!(storage.localStorage.length || storage.indexedDB?.length || storage.opfs?.length);

    const collectScript = `(() => {
      const module = {};
      ${rawStorageSource.source}
      const script = new (module.exports.StorageScript())(${JSON.stringify(this._browser.options.name)});
      return script.collect({ indexedDB: ${indexedDB}, opfs: ${opfs} });
    })()`;

    // First try collecting storage stage from existing pages.
    for (const page of this.pages()) {
      const origin = page.mainFrame().origin();
      if (!origin || !originsToSave.has(origin))
        continue;
      try {
        const storage: SerializedStorage = await progress.race(page.mainFrame().nonStallingEvaluateInExistingContext(collectScript, 'utility'));
        if (hasStorage(storage))
          result.origins.push({ origin, ...storage });
        originsToSave.delete(origin);
      } catch {
        // When failed on the live page, we'll retry on the blank page below.
      }
    }

    // If there are still origins to save, create a blank page to iterate over origins.
    if (originsToSave.size)  {
      await this.visitOrigins(progress, originsToSave, async (frame, origin) => {
        const storage: SerializedStorage = await frame.evaluateExpression(progress, collectScript, { world: 'utility' });
        if (hasStorage(storage))
          result.origins.push({ origin, ...storage });
      });
    }
    return result;
  }

  async visitOrigins(progress: Progress, origins: Set<string>, callback: (frame: frames.Frame, origin: string) => Promise<void>) {
    const page = await this.newPage(progress, true /* forStorageState */);
    try {
      await page.addRequestInterceptor(progress, route => {
        route.fulfill({ body: '<html></html>' }).catch(() => {});
      }, 'prepend');
      for (const origin of origins) {
        const frame = page.mainFrame();
        await frame.gotoImpl(progress, origin, {});
        await progress.race(callback(frame, origin));
      }
    } finally {
      await page.close(progress);
    }
  }

  isCreatingStorageStatePage(): boolean {
    return this._creatingStorageStatePage;
  }

  isPreparingRecycledPage(): boolean {
    return this._preparingRecycledPage;
  }

  // Flashwright: whether pointer actions wait for animations that move their target. Electron
  // windows, whose context takes no test options, keep Playwright's behavior.
  waitsForAnimations(): boolean {
    return this._options.waitForAnimations ?? this._browser.options.name === 'electron';
  }

  // Flashwright: see Browser.prepareRecycledContext.
  prepareStorageStatePage() {
    this._preparedStorageStatePage = (this._pendingRecycle ?? Promise.resolve()).then(() => this.newPage(nullProgress, true /* forStorageState */));
    this._preparedStorageStatePage.catch(() => {});
  }

  async applyPreparedStorageState(progress: Progress, state: NonNullable<channels.BrowserNewContextParams['storageState']>) {
    this._options.storageState = state;
    const page = await this._preparedStorageStatePage?.catch(() => undefined);
    this._preparedStorageStatePage = undefined;
    await this.setStorageState(progress, state, 'initial', page);
  }

  async discardPreparedStorageStatePage() {
    const page = await this._preparedStorageStatePage?.catch(() => undefined);
    this._preparedStorageStatePage = undefined;
    await page?.close(nullProgress).catch(() => {});
  }

  async setStorageState(progress: Progress, state: channels.BrowserNewContextParams['storageState'], mode: 'initial' | 'resetForReuse' | 'api', preparedPage?: Page) {
    let page: Page | undefined = preparedPage;
    let interceptor: network.RouteHandler | undefined;
    try {
      if (mode !== 'initial') {
        await progress.race(this.clearCache());
        await progress.race(this.doClearCookies());
        if (state?.credentials?.length)
          this.credentials.clear();
        else
          await this.credentials.dispose(progress);
      }

      if (state?.cookies)
        await progress.race(this.addCookies(state.cookies));

      if (state?.credentials?.length) {
        for (const credential of state.credentials)
          await progress.race(this.credentials.create(credential));
        await this.credentials.install(progress);
      }

      const newOrigins = new Map(state?.origins?.map(p => [p.origin, p]) || []);
      const allOrigins = new Set([...this._origins, ...newOrigins.keys()]);
      if (allOrigins.size) {
        if (mode === 'resetForReuse')
          page ??= this.pages()[0];
        if (!page)
          page = await this.newPage(progress, mode !== 'resetForReuse' /* forStorageState */);

        interceptor = (route: network.Route) => {
          route.fulfill({ body: '<html></html>' }).catch(() => {});
        };
        await page.addRequestInterceptor(progress, interceptor, 'prepend');

        for (const origin of allOrigins) {
          const frame = page.mainFrame();
          await frame.gotoImpl(progress, origin, {});
          const restoreScript = `(() => {
            const module = {};
            ${rawStorageSource.source}
            const script = new (module.exports.StorageScript())(${JSON.stringify(this._browser.options.name)});
            return script.restore(${JSON.stringify(newOrigins.get(origin))});
          })()`;
          await frame.evaluateExpression(progress, restoreScript, { world: 'utility' });
          // Flashwright: a reused context also starts without the origin's Cache Storage, as a new one would.
          if (mode === 'resetForReuse')
            await frame.evaluateExpression(progress, `self.caches && caches.keys().then(keys => Promise.all(keys.map(key => caches.delete(key))))`, { world: 'utility' });
        }
      }
      this._origins = new Set([...newOrigins.keys()]);
    } catch (error) {
      rewriteErrorMessage(error, `Error setting storage state:\n` + error.message);
      throw error;
    } finally {
      if (mode !== 'resetForReuse')
        await page?.close(progress);
      else if (interceptor)
        await page?.removeRequestInterceptor(interceptor);
    }
  }

  async extendInjectedScript(source: string, arg?: any) {
    const installInFrame = (frame: frames.Frame) => frame.extendInjectedScript(source, arg).catch(() => {});
    const installInPage = (page: Page) => {
      page.on(Page.Events.InternalFrameNavigatedToNewDocument, installInFrame);
      return Promise.all(page.frames().map(installInFrame));
    };
    this.on(BrowserContext.Events.Page, installInPage);
    return Promise.all(this.announcedPages().map(installInPage));
  }

  async safeNonStallingEvaluateInAllFrames(expression: string, world: types.World, options: { throwOnJSErrors?: boolean } = {}) {
    await Promise.all(this.pages().map(page => page.safeNonStallingEvaluateInAllFrames(expression, world, options)));
  }

  addRouteInFlight(route: network.Route) {
    this._routesInFlight.add(route);
  }

  removeRouteInFlight(route: network.Route) {
    this._routesInFlight.delete(route);
  }

  async notifyRoutesInFlightAboutRemovedHandler(handler: network.RouteHandler): Promise<void> {
    await Promise.all([...this._routesInFlight].map(route => route.removeHandler(handler)));
  }
}

export function validateBrowserContextOptions(options: types.BrowserContextOptions, browserOptions: BrowserOptions) {
  if (options.noDefaultViewport && options.deviceScaleFactor !== undefined)
    throw new Error(`"deviceScaleFactor" option is not supported with null "viewport"`);
  if (options.noDefaultViewport && !!options.isMobile)
    throw new Error(`"isMobile" option is not supported with null "viewport"`);
  if (options.acceptDownloads === undefined && browserOptions.name !== 'electron')
    options.acceptDownloads = 'accept';
  // Electron requires explicit acceptDownloads: true since we wait for
  // https://github.com/electron/electron/pull/41718 to be widely shipped.
  // In 6-12 months, we can remove this check.
  else if (options.acceptDownloads === undefined && browserOptions.name === 'electron')
    options.acceptDownloads = 'internal-browser-default';
  if (!options.viewport && !options.noDefaultViewport)
    options.viewport = { width: 1280, height: 720 };
  if (options.proxy)
    options.proxy = normalizeProxySettings(options.proxy);
  if (options.recordVideo?.fps !== undefined && options.recordVideo.fps <= 0)
    throw new Error(`"recordVideo.fps" must be a positive number, got ${options.recordVideo.fps}`);
  verifyGeolocation(options.geolocation);
}

export function findMatchingHttpCredentials(credentials: HttpCredentials[] | undefined, url: string): HttpCredentials | undefined {
  const origin = new URL(url).origin.toLowerCase();
  return credentials?.find(c => !c.origin || c.origin.toLowerCase() === origin);
}

export function verifyGeolocation(geolocation?: types.Geolocation): asserts geolocation is types.Geolocation {
  if (!geolocation)
    return;
  geolocation.accuracy = geolocation.accuracy || 0;
  const { longitude, latitude, accuracy } = geolocation;
  if (longitude < -180 || longitude > 180)
    throw new Error(`geolocation.longitude: precondition -180 <= LONGITUDE <= 180 failed.`);
  if (latitude < -90 || latitude > 90)
    throw new Error(`geolocation.latitude: precondition -90 <= LATITUDE <= 90 failed.`);
  if (accuracy < 0)
    throw new Error(`geolocation.accuracy: precondition 0 <= ACCURACY failed.`);
}

export function verifyClientCertificates(clientCertificates?: types.BrowserContextOptions['clientCertificates']) {
  if (!clientCertificates)
    return;
  for (const cert of clientCertificates) {
    if (!cert.origin)
      throw new Error(`clientCertificates.origin is required`);
    if (!cert.cert && !cert.key && !cert.passphrase && !cert.pfx)
      throw new Error('None of cert, key, passphrase or pfx is specified');
    if (cert.cert && !cert.key)
      throw new Error('cert is specified without key');
    if (!cert.cert && cert.key)
      throw new Error('key is specified without cert');
    if (cert.pfx && (cert.cert || cert.key))
      throw new Error('pfx is specified together with cert, key or passphrase');
  }
}

export function normalizeProxySettings(proxy: types.ProxySettings): types.ProxySettings {
  let { server, bypass } = proxy;
  let url;
  try {
    // new URL('127.0.0.1:8080') throws
    // new URL('localhost:8080') fails to parse host or protocol
    // In both of these cases, we need to try re-parse URL with `http://` prefix.
    url = new URL(server);
    if (!url.host || !url.protocol)
      url = new URL('http://' + server);
  } catch (e) {
    url = new URL('http://' + server);
  }
  if (url.protocol === 'socks4:' && (proxy.username || proxy.password))
    throw new Error(`Socks4 proxy protocol does not support authentication`);
  if (url.protocol === 'socks5:' && (proxy.username || proxy.password))
    throw new Error(`Browser does not support socks5 proxy authentication`);
  server = url.protocol + '//' + url.host;
  if (bypass)
    bypass = bypass.split(',').map(t => t.trim()).join(',');
  return { ...proxy, server, bypass };
}

// A new tab in a healthy renderer is ready within a few milliseconds, and the whole reset within
// tens of milliseconds.
const kRecycledPageTimeout = 500;
// Flashwright: how long a reused context's page may take to navigate away from the previous test.
const kReusedPageNavigationTimeout = 2000;
const kRecycleTimeout = 1500;

function openedBy(page: Page, opener: Page): boolean {
  for (let p = page.opener(); p; p = p.opener()) {
    if (p === opener)
      return true;
  }
  return false;
}

// Flashwright: see BrowserContext.setPreloadHint. The path (with query and hash) is taken relative to
// the test's last first navigation, which also has the current server's origin and port; without
// a path, the URL the running test navigates to first.
export type PreloadHint = { path?: string, expectedEnd?: number };

// A preload is timed to finish this long before the running test is expected to end, leaving time
// for what the document fetches after it loads.
const kPreloadHeadStart = 100;

// Resolves with `timeoutValue` if `promise` takes longer than `timeout`. The timer is cleared as
// soon as the promise settles, so it does not keep the recycled context's old pages reachable.
export function raceWithTimeout<T, V>(promise: Promise<T>, timeout: number, timeoutValue: V): Promise<T | V> {
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<V>(f => timer = setTimeout(() => f(timeoutValue), timeout));
  return Promise.race([promise, timedOut]).finally(() => clearTimeout(timer));
}

const paramsThatAllowContextReuse: (keyof channels.BrowserNewContextForReuseParams)[] = [
  'colorScheme',
  'forcedColors',
  'reducedMotion',
  'contrast',
  'screen',
  'userAgent',
  'viewport',
  'testIdAttributeName',
  'waitForAnimations',
  // Flashwright: read on every navigation and API request, so it can change between tests.
  'baseURL',
  'failFastWhenIdle',
  // Flashwright: read whenever a selector is resolved.
  'locatorPolicy',
];

const defaultNewContextParamValues: channels.BrowserNewContextForReuseParams = {
  noDefaultViewport: false,
  ignoreHTTPSErrors: false,
  javaScriptEnabled: true,
  waitForAnimations: false,
  instantAnimations: false,
  failFastWhenIdle: false,
  bypassCSP: false,
  offline: false,
  isMobile: false,
  hasTouch: false,
  acceptDownloads: 'accept',
  strictSelectors: false,
  serviceWorkers: 'allow',
  locale: 'en-US',
};

function isPlainJSON(value: unknown): boolean {
  if (value === null || ['string', 'number', 'boolean', 'undefined'].includes(typeof value))
    return true;
  if (Array.isArray(value))
    return value.every(isPlainJSON);
  return typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype && Object.values(value as object).every(isPlainJSON);
}
