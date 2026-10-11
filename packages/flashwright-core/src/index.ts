import { installFailureContextSnapshotResolver } from './failure-context-snapshot.js';
import { prepareAriaSnapshot, prepareAriaSnapshotArguments, type AriaSnapshotOptions } from './aria-snapshot.js';
export type { AriaSnapshotOptions } from './aria-snapshot.js';
import { Tracing } from './tracing.js';
import { instrumentTraceMethods, instrumentTraceCallbacks, installTracePageResolver, tracePageOwner, traceRecordingActive, type TraceMethod } from './trace-hooks.js';
export { Tracing, type TracingStartOptions, type TracingChunkOptions, type TracingStopOptions } from './tracing.js';
import { NavigationWaiter } from './navigation-waiter.js';
import { EventEmitter } from 'node:events';
import { prepareInitScript, InitScriptRegistration, type InitScript, type Disposable } from './init-scripts.js';
import { ConsoleMessage, consoleMessage } from './console.js';
import { Dialog, receivedDialog, handleUnobservedDialog } from './dialog.js';
export { Dialog, type DialogType } from './dialog.js';
import { SubscribedEventEmitter } from './subscribed-events.js';
export { ConsoleMessage } from './console.js';
export type { ConsoleMessageType } from './console.js';
import { FileChooser, fileChooser } from './file-chooser.js';
export { FileChooser } from './file-chooser.js';
import { Download, receivedDownload } from './download.js';
export { Download } from './download.js';
import { JSHandle, ElementHandle, receivedHandles, encodeEvaluationArgument, type Unboxed, type SmartHandle } from './handles.js';
import { pageError } from './page-errors.js';
import { prepareScreenshot, type PageScreenshotOptions } from './screenshots.js';
import { writeAtomicFile } from './files.js';
import { Keyboard, type KeyboardPressOptions } from './keyboard.js';
import { EngineClient, retainEngine, type ObjectEvent } from './client.js';
import { failure, FlashwrightError } from './errors.js';
import type { AssertionOptions, AssertionResult } from './assertions.js';
import { Frame, type FrameSnapshot } from './frame.js';
import { Request, Response, type RequestMetadata, type RequestReference, type ResponseMetadata } from './network.js';
import { Route, RouteRegistry, type RouteHandler, type RouteOptions, type UnrouteAllOptions } from './routing.js';
export { Route, type RouteHandler, type RouteOptions, type RouteContinueOptions, type RouteFulfillOptions, type UnrouteAllOptions } from './routing.js';
import { waitForEvent, matchesURL, validateURLMatcher, validateTimeout, type URLMatcher, type EventWaitOptions } from './waits.js';
import { performance } from 'node:perf_hooks';
import { createValueCodec } from './serialization.cjs';
import type { LocatorTimeoutOptions } from './locator.js';
import { selectorActionTraceMethods } from './selector-actions.js';
export type { SelectorStrictOptions, SelectorOptions } from './selector-actions.js';
import { validateOptions as options } from './validation.js';
import { prepareDeviceOptions, type DeviceOptions } from './devices.js';
import { prepareContextSettings, type ContextSettings } from './context-settings.js';
import { prepareElementResolution, type WaitForSelectorOptions, type WaitForSelectorOptionsNotHidden } from './element-resolution.js';
import { prepareFunctionWait, prepareFunctionWaitArguments, type PageWaitForFunctionOptions } from './function-wait.js';
export type { PageWaitForFunctionOptions } from './function-wait.js';
import { currentRunnerContextDefaults } from './runner-context-defaults.js';
import { prepareInputFiles, fileInputSelector, type InputFiles, type FrameSetInputFilesOptions, type SetInputFilesOptions } from './file-inputs.js';
export type { FilePayload, InputFiles, SetInputFilesOptions, FrameSetInputFilesOptions } from './file-inputs.js';
import { beginRunnerContextCreation, completeRunnerContextCreation, didCreateRunnerContext, willCloseRunnerContext, assertRunnerContextCloseAllowed, runnerContextLifecycleActive } from './runner-lifecycle.js';
import { registerPublicBrowser } from './public-browsers.js';
import { prepareCookies, filterCookies, cookieFilter, prepareStorageState, decodeStorageState, writeStorageState, type Cookie, type SetCookie, type CookieFilter, type StorageState, type StorageStateOptions, type WireStorageState } from './storage.js';

export * from './errors.js';
export type { InitScript, Disposable };
export { devices, type DeviceDescriptor } from './device-descriptors.js';
export { Keyboard, JSHandle, ElementHandle };
export type { Unboxed, SmartHandle };
export type { WaitForSelectorOptions, WaitForSelectorOptionsNotHidden } from './element-resolution.js';
export type { PageScreenshotOptions };
export type { KeyboardPressOptions };
export type { AriaSnapshotTemplate, AssertionOptions, AssertionResult, ExpectedText } from './assertions.js';
export { Frame, Request, Response };
export { Locator, FrameLocator } from './locator.js';
export type { LocatorOptions, TextOptions, RoleOptions, LocatorTimeoutOptions, FillOptions, SelectTextOptions, SelectOption, ClickOptions, HoverOptions, CheckOptions, PressOptions, KeyboardModifier } from './locator.js';
export type { URLMatcher };
export type { Cookie, SetCookie, CookieFilter, StorageState, StorageStateOptions };
const codec = createValueCodec();
const eventWaitTrace: TraceMethod = {
  parameters: ['event', 'options'],
  completion: 'independent',
  // Modal recovery and download artifacts must not wait for renderer diagnostics.
  capture: arguments_ => arguments_[0] === 'dialog' || arguments_[0] === 'download' ? 'metadata-only' : 'default',
};

export interface LaunchOptions { executablePath?: string; headless?: boolean; timeout?: number; slowMo?: number }
export interface PageCloseOptions { runBeforeUnload?: boolean }
export interface ViewportSize { width: number; height: number }
export interface BrowserContextOptions extends DeviceOptions, ContextSettings { viewport?: ViewportSize | null; baseURL?: string; storageState?: StorageState | string }
export interface NavigationWaitOptions { timeout?: number; waitUntil?: 'load' | 'domcontentloaded' | 'networkidle' | 'commit' }
export interface WaitForNavigationOptions extends NavigationWaitOptions { url?: URLMatcher }
export interface NavigationOptions extends NavigationWaitOptions { referer?: string }
interface PageInitialization { identifier: string; frames: FrameSnapshot[]; mainFrame: string; initialEvents?: ObjectEvent[]; navigationSequence: number }
interface ContextEvents { page: Page; close: BrowserContext; console: ConsoleMessage; dialog: Dialog }
interface PageEvents { dialog: Dialog; download: Download; filechooser: FileChooser; console: ConsoleMessage; response: Response; request: Request; requestfinished: Request; requestfailed: Request; framenavigated: Frame; frameattached: Frame; framedetached: Frame; close: Page; crash: Page; load: Page; domcontentloaded: Page; pageerror: Error }
// Validate original ownership without exposing engine context identities in the public API.
const contextOwners = new WeakMap<BrowserContext, { identifier: string; isClosed: () => boolean }>();
const ownerRegistrations = new WeakMap<BrowserContext | Page, () => void>();

/** Public listener removal or interruption cannot prevent removal from an owner's registry. */
function retireOwnerRegistration(object: BrowserContext | Page): void {
  const retire = ownerRegistrations.get(object);
  ownerRegistrations.delete(object);
  retire?.();
}


/** Finish independent owner cleanup steps, then rethrow the first value, even undefined. */
class OwnerCloseFailures {
  private firstFailure: { value: unknown } | undefined;
  run(operation: () => unknown): void {
    try { operation(); }
    catch (value) { this.firstFailure ??= { value }; }
  }
  async wait(operation: () => unknown): Promise<void> {
    try { await operation(); }
    catch (value) { this.firstFailure ??= { value }; }
  }
  rethrow(): void { if (this.firstFailure) throw this.firstFailure.value; }
}

function identifier(value: unknown): string {
  if (!value || typeof value !== 'object' || !('identifier' in value) || typeof value.identifier !== 'string') throw failure('ProtocolError', 'protocol', 'driver omitted object identity');
  return value.identifier;
}

function navigationSequence(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw failure('ProtocolError', 'navigation', 'driver omitted navigation sequence');
  return value;
}

export class BrowserType {
  constructor(private readonly browserName: string) {}
  name(): string { return this.browserName; }
  async launch(launchOptions: LaunchOptions = {}): Promise<Browser> {
    if (this.browserName !== 'chromium') throw failure('UnsupportedFeatureError', `${this.browserName}.launch`, 'only Chromium is implemented');
    options('chromium.launch', launchOptions, ['executablePath', 'headless', 'timeout', 'slowMo']);
    if (launchOptions.slowMo !== undefined) {
      if (typeof launchOptions.slowMo !== 'number' || !Number.isFinite(launchOptions.slowMo) || launchOptions.slowMo < 0) throw failure('InvalidArgumentError', 'chromium.launch.slowMo', 'expected a finite nonnegative number');
      if (launchOptions.slowMo !== 0) throw failure('UnsupportedFeatureError', 'chromium.launch.slowMo', 'only zero is implemented; nonzero slow motion is not available');
    }
    const executablePath = launchOptions.executablePath ?? process.env.FLASHWRIGHT_BROWSER_PATH;
    if (typeof executablePath !== 'string' || !executablePath) throw failure('InvalidArgumentError', 'chromium.launch', 'provide executablePath or FLASHWRIGHT_BROWSER_PATH for Chromium 148.0.7778.96');
    if (launchOptions.headless !== undefined && typeof launchOptions.headless !== 'boolean') throw failure('InvalidArgumentError', 'chromium.launch.headless', 'expected a boolean');
    const timeout = launchOptions.timeout ?? 30000;
    if (!Number.isFinite(timeout) || timeout < 0) throw failure('InvalidArgumentError', 'chromium.launch.timeout', 'expected a finite nonnegative number');
    const deadline = timeout === 0 ? Infinity : performance.now() + timeout;
    const client = retainEngine(deadline);
    try {
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw failure('TimeoutError', 'chromium.launch', 'deadline exceeded before browser allocation');
      const result = await client.request('browser.launch', { executablePath, headless: launchOptions.headless ?? true }, timeout === 0 ? 0 : remaining);
      const browserIdentifier = identifier(result);
      if (!result || typeof result !== 'object' || !('version' in result) || typeof result.version !== 'string') throw failure('ProtocolError', 'chromium.launch', 'driver omitted browser version');
      return new Browser(client, browserIdentifier, result.version);
    } catch (error) { await client.release(); throw error; }
  }
  async launchPersistentContext(): Promise<never> { throw failure('UnsupportedFeatureError', `${this.browserName}.launchPersistentContext`, 'persistent contexts are not implemented'); }
  async connect(): Promise<never> { throw failure('UnsupportedFeatureError', `${this.browserName}.connect`, 'remote connections are not implemented'); }
  async connectOverCDP(): Promise<never> { throw failure('UnsupportedFeatureError', `${this.browserName}.connectOverCDP`, 'remote connections are not implemented'); }
}

export class Browser extends EventEmitter {
  private readonly ownedContexts = new Set<BrowserContext>();
  private closing: Promise<void> | undefined;
  private disconnected = false;
  private released: Promise<void> | undefined;
  private unregisterPublicBrowser: (() => void) | undefined;
  private readonly unsubscribe: () => void;
  constructor(private readonly client: EngineClient, private readonly identifier: string, private readonly browserVersion: string) {
    super();
    this.unsubscribe = client.subscribeObject(identifier, event => {
      if (event.event === 'disconnected' || event.event === 'transportclosed') {
        const failures = new OwnerCloseFailures();
        failures.run(() => this.didDisconnect());
        if (!this.closing) failures.run(() => { void this.releaseDriver(); });
        failures.rethrow();
      }
    });
    if (!this.disconnected) this.unregisterPublicBrowser = registerPublicBrowser(this);
  }
  private releaseDriver(): Promise<void> { return this.released ??= this.client.release(); }
  private didDisconnect(): void {
    if (this.disconnected) return;
    this.disconnected = true;
    const failures = new OwnerCloseFailures();
    failures.run(() => this.unregisterPublicBrowser?.());
    this.unregisterPublicBrowser = undefined;
    for (const context of this.ownedContexts) failures.run(() => context.didClose());
    this.ownedContexts.clear();
    failures.run(() => this.unsubscribe());
    failures.run(() => this.emit('disconnected', this));
    failures.rethrow();
  }
  version(): string { return this.browserVersion; }
  contexts(): BrowserContext[] { return [...this.ownedContexts]; }
  isConnected(): boolean { return !this.disconnected && !this.closing && !this.client.isClosed(); }
  async newContext(contextOptions: BrowserContextOptions = {}): Promise<BrowserContext> {
    const runnerCreation = beginRunnerContextCreation();
    try {
      const runnerDefaults = currentRunnerContextDefaults();
      if (runnerDefaults && contextOptions && typeof contextOptions === 'object' && !Array.isArray(contextOptions)) {
        contextOptions = { ...runnerDefaults.contextOptions, ...contextOptions };
      }
      options('browser.newContext', contextOptions, ['viewport', 'baseURL', 'storageState', 'screen', 'userAgent', 'deviceScaleFactor', 'isMobile', 'hasTouch', 'defaultBrowserType', 'ignoreHTTPSErrors', 'javaScriptEnabled', 'acceptDownloads']);
      const deviceOptions = prepareDeviceOptions(contextOptions);
      const contextSettings = prepareContextSettings(contextOptions);
      if (contextOptions.baseURL !== undefined && typeof contextOptions.baseURL !== 'string') throw failure('InvalidArgumentError', 'browser.newContext.baseURL', 'expected a string');
      if (contextOptions.viewport !== undefined && contextOptions.viewport !== null) {
        options('browser.newContext.viewport', contextOptions.viewport, ['width', 'height']);
        if (![contextOptions.viewport.width, contextOptions.viewport.height].every(value => Number.isInteger(value) && value > 0 && value <= 0xffffffff)) throw failure('InvalidArgumentError', 'browser.newContext.viewport', 'width and height must be positive 32-bit integers');
      }
      if (!this.isConnected()) throw failure('TargetClosedError', 'browser.newContext', 'browser has been closed');
      const storageState = contextOptions.storageState === undefined ? undefined : await prepareStorageState(contextOptions.storageState);
      const result = await this.client.request('browser.newContext', {
        browser: this.identifier, ...deviceOptions, ...contextSettings,
        ...(contextOptions.viewport !== undefined ? { viewport: contextOptions.viewport } : {}),
        ...(storageState === undefined ? {} : { storageState }),
      });
      if (!this.isConnected()) {
        if (!this.client.isClosed()) await this.client.request('context.close', { context: identifier(result) });
        throw failure('TargetClosedError', 'browser.newContext', 'browser closed while the context was being created');
      }
      const context = new BrowserContext(this.client, identifier(result), this, contextOptions.viewport === undefined ? { width: 1280, height: 720 } : contextOptions.viewport, contextOptions.baseURL);
      if (runnerDefaults) {
        context.setDefaultTimeout(runnerDefaults.actionTimeout);
        context.setDefaultNavigationTimeout(runnerDefaults.navigationTimeout);
      }
      this.ownedContexts.add(context);
      ownerRegistrations.set(context, () => { this.ownedContexts.delete(context); });
      context.once('close', () => retireOwnerRegistration(context));
      try {
        const enrollment = didCreateRunnerContext(context, runnerCreation);
        if (enrollment) await enrollment;
      }
      catch (error) { await context.close().catch(() => {}); throw error; }
      return context;
    } finally { completeRunnerContextCreation(runnerCreation); }
  }
  async newPage(contextOptions: BrowserContextOptions = {}): Promise<Page> {
    const context = await this.newContext(contextOptions);
    try { return await context.newOwnedPage(); } catch (error) { await context.close(); throw error; }
  }
  close(): Promise<void> {
    assertRunnerContextCloseAllowed();
    this.closing ??= (async () => {
      const failures = new OwnerCloseFailures();
      if (!this.disconnected) {
        if (traceRecordingActive() || runnerContextLifecycleActive()) {
          await failures.wait(async () => {
            const results = await Promise.allSettled([...this.ownedContexts].map(context => context.prepareOwnerClose('browser')));
            const rejected = results.find(result => result.status === 'rejected');
            if (rejected?.status === 'rejected') throw rejected.reason;
          });
        }
        await failures.wait(() => this.client.request('browser.close', { browser: this.identifier }));
      }
      failures.run(() => this.didDisconnect());
      await failures.wait(() => this.releaseDriver());
      failures.rethrow();
    })();
    return this.closing;
  }
}

export class BrowserContext extends SubscribedEventEmitter<{ [Event in keyof ContextEvents]: [ContextEvents[Event]] }> {
  private tracingValue: Tracing | undefined;
  private closingPreparation: Promise<void> | undefined;
  get tracing(): Tracing {
    if (!this.tracingValue) {
      this.tracingValue = new Tracing(this.client, this.identifier, this.viewport);
      if (this.closed) this.tracingValue.ownerClosed();
    }
    return this.tracingValue;
  }
  prepareTraceClose(): Promise<void> | undefined { return this.tracingValue?.beforeOwnerClose(); }
  /** Context and browser closure share the same artifact handoff before native shutdown. */
  prepareOwnerClose(source: 'context' | 'browser' = 'context'): Promise<void> | undefined {
    if (this.closed) return undefined;
    if (this.closingPreparation) return this.closingPreparation;
    try {
      const beforeClose = willCloseRunnerContext(this, source);
      this.closingPreparation = beforeClose ? beforeClose.finally(() => this.prepareTraceClose()) : this.prepareTraceClose();
    } catch (error) { this.closingPreparation = Promise.reject(error); }
    return this.closingPreparation;
  }
  recordTracePageClosed(pageId: string): void { this.tracingValue?.pageEvent(pageId, false); }
  static {
    instrumentTraceMethods(this.prototype, 'BrowserContext', context => ({ tracing: context.tracing }), {
      addInitScript: { parameters: ['script', 'arg'] }, cookies: { parameters: ['urls'] }, addCookies: { parameters: ['cookies'] }, clearCookies: { parameters: ['options'] }, storageState: { parameters: ['options'] }, newPage: {}, close: {}, waitForEvent: eventWaitTrace,
    });
  }

  readonly routeRegistry: RouteRegistry;
  private readonly ownedPages = new Set<Page>();
  private closed = false;
  private closing: Promise<void> | undefined;
  private readonly unsubscribe: () => void;
  private defaultTimeout = 30000;
  private defaultNavigationTimeout: number | undefined;
  constructor(private readonly client: EngineClient, private readonly identifier: string, private readonly owner: Browser, readonly viewport: ViewportSize | null, readonly baseURL: string | undefined) {
    super({ console: enabled => client.setConsoleSubscription('context', identifier, enabled), dialog: enabled => client.setDialogSubscription('context', identifier, enabled) });
    contextOwners.set(this, { identifier, isClosed: () => this.closed });
    this.routeRegistry = new RouteRegistry(client, 'context', identifier, baseURL);
    this.unsubscribe = client.subscribeObject(identifier, event => {
      if (event.event === 'close' || event.event === 'transportclosed') this.didClose();
      else if (event.event === 'dialog') {
        let dialog: Dialog;
        try { dialog = receivedDialog(null, client, event.parameters, () => this.tracing); }
        catch (error) { client.rejectProtocol(error); return; }
        if (!this.emit('dialog', dialog)) handleUnobservedDialog(dialog, client);
      }
    });
  }
  async waitForEvent<Event extends keyof ContextEvents>(event: Event, waitOptions: EventWaitOptions<ContextEvents[Event]> | ((value: ContextEvents[Event]) => boolean | Promise<boolean>) = {}): Promise<ContextEvents[Event]> {
    if (!['console', 'dialog', 'page', 'close'].includes(event)) throw failure('UnsupportedFeatureError', 'context.waitForEvent', 'event is not implemented');
    if (this.closed) throw failure('TargetClosedError', 'context.waitForEvent', 'context is closed');
    const configured = typeof waitOptions === 'function' ? { predicate: waitOptions } : waitOptions;
    options('context.waitForEvent', configured, ['predicate', 'timeout']);
    return waitForEvent(this, event, configured, this.timeout(), 'context.waitForEvent');
  }
  setDefaultTimeout(timeout: number): void { this.defaultTimeout = validateTimeout(timeout, 'context.setDefaultTimeout'); }
  setDefaultNavigationTimeout(timeout: number): void { this.defaultNavigationTimeout = validateTimeout(timeout, 'context.setDefaultNavigationTimeout'); }
  timeout(): number { return this.defaultTimeout; }
  navigationTimeout(): number { return this.defaultNavigationTimeout ?? this.defaultTimeout; }
  async addInitScript<Argument = void>(script: InitScript<Argument>, argument?: Argument): Promise<Disposable> {
    const sourceJson = await prepareInitScript('context.addInitScript', script, argument);
    if (this.closed) throw failure('TargetClosedError', 'context.addInitScript', 'context has been closed');
    const result = await this.client.request('context.addInitScript', { context: this.identifier, sourceJson });
    return new InitScriptRegistration(this.client, identifier(result), () => ({ tracing: this.tracing }));
  }
  browser(): Browser { return this.owner; }
  pages(): Page[] { return [...this.ownedPages]; }
  async cookies(urls?: string | ReadonlyArray<string>): Promise<Cookie[]> {
    filterCookies([], urls);
    return filterCookies(await this.client.request('context.cookies', { context: this.identifier }) as Cookie[], urls);
  }
  async addCookies(cookies: ReadonlyArray<SetCookie>): Promise<void> {
    await this.client.request('context.addCookies', { context: this.identifier, cookies: prepareCookies(cookies, 'context.addCookies') });
  }
  async clearCookies(filter: CookieFilter = {}): Promise<void> {
    const matches = cookieFilter(filter);
    if (!Object.keys(filter).some(key => filter[key as keyof CookieFilter] !== undefined)) {
      await this.client.request('context.clearCookies', { context: this.identifier });
    } else {
      const cookies = (await this.cookies()).filter(matches).map(cookie => ({ ...cookie, expires: 0 }));
      if (cookies.length) await this.addCookies(cookies);
    }
  }
  async storageState(storageOptions: StorageStateOptions = {}): Promise<StorageState> {
    options('context.storageState', storageOptions, ['path', 'indexedDB']);
    if (storageOptions.path !== undefined && typeof storageOptions.path !== 'string') throw failure('InvalidArgumentError', 'context.storageState.path', 'expected a string');
    if (storageOptions.indexedDB !== undefined && typeof storageOptions.indexedDB !== 'boolean') throw failure('InvalidArgumentError', 'context.storageState.indexedDB', 'expected a boolean');
    if (storageOptions.indexedDB) throw failure('UnsupportedFeatureError', 'context.storageState.indexedDB', 'IndexedDB snapshots are not implemented');
    const state = decodeStorageState(await this.client.request('context.storageState', { context: this.identifier }) as WireStorageState);
    if (storageOptions.path) await writeStorageState(storageOptions.path, state);
    return state;
  }
  async setStorageState(_state: StorageState | string): Promise<never> {
    throw failure('UnsupportedFeatureError', 'context.setStorageState', 'replacing state in an existing context is not implemented; create a new context with storageState');
  }
  route(matcher: URLMatcher, handler: RouteHandler, options?: RouteOptions): Promise<Disposable> { return this.routeRegistry.route(matcher, handler, options); }
  unroute(matcher: URLMatcher, handler?: RouteHandler): Promise<void> { return this.routeRegistry.unroute(matcher, handler); }
  unrouteAll(options?: UnrouteAllOptions): Promise<void> { return this.routeRegistry.unrouteAll(options); }
  async newPage(): Promise<Page> { return this.createPage(false); }
  async newOwnedPage(): Promise<Page> { return this.createPage(true); }
  private async createPage(ownsContext: boolean): Promise<Page> {
    if (this.closed) throw failure('TargetClosedError', 'context.newPage', 'context has been closed');
    const result = await this.client.request('context.newPage', { context: this.identifier });
    if (this.closed) throw failure('TargetClosedError', 'context.newPage', 'context closed while the page was being created');
    const page = new Page(this.client, identifier(result), this, ownsContext, result as PageInitialization);
    this.ownedPages.add(page);
    this.tracingValue?.pageEvent(identifier(result), true);
    ownerRegistrations.set(page, () => { this.ownedPages.delete(page); });
    page.once('close', () => retireOwnerRegistration(page));
    this.emit('page', page);
    return page;
  }
  close(): Promise<void> {
    assertRunnerContextCloseAllowed();
    if (this.closed) return this.closing ?? Promise.resolve();
    this.closing ??= (async () => {
      const failures = new OwnerCloseFailures();
      let beforeClose: Promise<void> | undefined;
      failures.run(() => { beforeClose = this.prepareOwnerClose(); });
      if (beforeClose) await failures.wait(() => beforeClose);
      await failures.wait(() => this.client.request('context.close', { context: this.identifier }));
      failures.run(() => this.didClose());
      failures.rethrow();
    })();
    return this.closing;
  }
  didClose(): void {
    if (this.closed) return;
    this.closed = true;
    const failures = new OwnerCloseFailures();
    failures.run(() => this.routeRegistry.close());
    failures.run(() => this.tracingValue?.ownerClosed());
    failures.run(() => this.unsubscribe());
    for (const page of this.ownedPages) failures.run(() => page.didClose());
    this.ownedPages.clear();
    failures.run(() => this.emit('close', this));
    failures.run(() => retireOwnerRegistration(this));
    failures.rethrow();
  }
}

export class Page extends SubscribedEventEmitter<{ [Event in keyof PageEvents]: [PageEvents[Event]] }> {
  static {
    installTracePageResolver(page => page instanceof Page ? { tracing: page.owner.tracing, pageId: page.identifier } : undefined);
    installFailureContextSnapshotResolver((page, timeoutMilliseconds) => {
      if (!(page instanceof Page)) return undefined;
      page.checkOpen('diagnostics.pageSnapshot');
      return page.client.request('diagnostics.pageSnapshot', { page: page.identifier, frame: page.mainFrameIdentifier }, timeoutMilliseconds).then(result => codec.decode(result) as string);
    });
    instrumentTraceMethods(this.prototype, 'Page', tracePageOwner, {
      ariaSnapshot: { className: 'Frame', parameters: ['options'], prepareArguments: prepareAriaSnapshotArguments, capture: 'filmstrip' },
      ...selectorActionTraceMethods,
      waitForSelector: { className: 'Frame', parameters: ['selector', 'options'] },
      waitForFunction: { className: 'Frame', parameters: ['expression', 'arg', 'options'], prepareArguments: prepareFunctionWaitArguments },
      setInputFiles: { className: 'Frame', parameters: ['selector', 'files', 'options'] },
      addInitScript: { parameters: ['script', 'arg'] }, evaluate: { className: 'Frame', method: 'evaluateExpression', parameters: ['expression', 'arg'] }, evaluateHandle: { className: 'Frame', method: 'evaluateExpressionHandle', parameters: ['expression', 'arg'] }, title: { className: 'Frame' }, screenshot: { parameters: ['options'] }, goto: { className: 'Frame', parameters: ['url', 'options'] }, reload: { parameters: ['options'] }, goBack: { parameters: ['options'] }, goForward: { parameters: ['options'] }, waitForLoadState: { parameters: ['state', 'options'], completion: 'independent' }, waitForNavigation: { parameters: ['options'], completion: 'independent' }, waitForURL: { parameters: ['url', 'options'], completion: 'independent' }, waitForResponse: { parameters: ['urlOrPredicate', 'options'], completion: 'independent' }, waitForEvent: eventWaitTrace, close: {},
    });
  }

  readonly keyboard = new Keyboard(this);
  private readonly routeRegistry: RouteRegistry;
  private readonly routes = new Set<Route>();
  private closed = false;
  private closing: Promise<void> | undefined;
  private crashed = false;
  private navigationSequence: number;
  private readonly unsubscribe: () => void;
  private readonly ownedFrames = new Map<string, Frame>();
  private readonly requests = new Map<string, Request>();
  private readonly responses = new Map<string, Response>();
  private readonly completedRequests = new Set<string>();
  private readonly completedRequestSizes = new Map<string, number>();
  private readonly pendingRedirects = new Set<string>();
  private completedRequestBytes = 0;
  private readonly navigationOccurrences = new Map<string, string>();
  private readonly frameLoaders = new Map<string, { loader: string; sequence: number }>();
  private liveLoaders = new Set<string>();
  private readonly mainFrameIdentifier: string;
  private defaultTimeout: number | undefined;
  private defaultNavigationTimeout: number | undefined;
  constructor(private readonly client: EngineClient, private readonly identifier: string, private readonly owner: BrowserContext, private readonly ownsContext: boolean, initialization: PageInitialization) {
    super({ console: enabled => client.setConsoleSubscription('page', identifier, enabled), dialog: enabled => client.setDialogSubscription('page', identifier, enabled), filechooser: enabled => client.setFileChooserSubscription(identifier, enabled) });
    this.routeRegistry = new RouteRegistry(client, 'page', identifier, owner.baseURL);
    this.mainFrameIdentifier = initialization.mainFrame;
    try { this.navigationSequence = navigationSequence(initialization.navigationSequence); }
    catch (error) { client.rejectProtocol(error); throw error; }
    for (const snapshot of initialization.frames) this.updateFrame(snapshot);
    this.unsubscribe = client.subscribeObject(identifier, ({ event, parameters }) => {
      if (event === 'close' || event === 'transportclosed') this.didClose();
      else if (event === 'crash') { if (!this.crashed) { this.crashed = true; this.emit('crash', this); } }
      else if (event === 'navigation') {
        try { this.navigationSequence = Math.max(this.navigationSequence, navigationSequence((parameters as { sequence?: unknown } | null)?.sequence)); }
        catch (error) { this.client.rejectProtocol(error); }
      }
      else if (event === 'frameattached' || event === 'framenavigated') this.emit(event, this.updateFrame(parameters as FrameSnapshot));
      else if (event === 'framedetached') {
        const snapshot = parameters as FrameSnapshot;
        const frame = this.ownedFrames.get(snapshot.identifier);
        if (frame) {
          frame.didDetach(); this.ownedFrames.delete(snapshot.identifier);
          this.frameLoaders.delete(snapshot.identifier); this.updateLiveLoaders();
          this.emit(event, frame);
        }
      } else if (event === 'request' || event === 'requestfinished') {
        let request: Request;
        try { request = event === 'request' ? this.requestFor(parameters as RequestMetadata) : this.existingRequest(parameters as RequestReference); }
        catch (error) { this.client.rejectProtocol(error); return; }
        if (event === 'requestfinished') {
          try { if ((parameters as RequestReference & { redirecting?: boolean }).redirecting) this.pendingRedirects.add(request.metadata.identity); request.didFinish(); this.completeRequest(request); }
          catch (error) { this.client.rejectProtocol(error); return; }
        }
        this.emit(event, request);
      }
      else if (event === 'route') {
        if (this.closed) return;
        let request: Request;
        try { request = this.existingRequest(parameters as RequestReference); } catch (error) { this.client.rejectProtocol(error); return; }
        const route = new Route(this.client, this.identifier, this, request, () => { this.routes.delete(route); this.routeRegistry.finished(route); this.owner.routeRegistry.finished(route); });
        this.routes.add(route);
        void route.dispatch([this.routeRegistry, this.owner.routeRegistry]);
      }
      else if (event === 'response') {
        let response: Response;
        try { response = this.responseFor(parameters as ResponseMetadata); }
        catch (error) { this.client.rejectProtocol(error); return; }
        this.emit('response', response);
      }
      else if (event === 'requestfailed') {
        const details = parameters as { request: RequestReference; errorText: string };
        let request: Request;
        try { request = this.existingRequest(details.request); }
        catch (error) { this.client.rejectProtocol(error); return; }
        request.didFail(details.errorText);
        try { this.completeRequest(request); } catch (error) { this.client.rejectProtocol(error); return; }
        for (const route of this.routes) if (route.request() === request) route.requestEnded();
        this.emit(event, request);
      } else if (event === 'load' || event === 'domcontentloaded') this.emit(event, this);
      else if (event === 'pageerror') this.emit('pageerror', pageError(parameters));
      else if (event === 'dialog') {
        let dialog: Dialog;
        try { dialog = receivedDialog(this, this.client, parameters, () => this.owner.tracing); }
        catch (error) { this.client.rejectProtocol(error); return; }
        const contextObserved = this.owner.emit('dialog', dialog);
        const pageObserved = this.emit('dialog', dialog);
        if (!contextObserved && !pageObserved) handleUnobservedDialog(dialog, this.client);
      }
      else if (event === 'download') {
        let download: Download;
        try {
          const context = contextOwners.get(this.owner)!;
          download = receivedDownload(this, this.client, this.identifier, context.identifier, parameters, () => this.owner.tracing, context.isClosed);
        }
        catch (error) { this.client.rejectProtocol(error); return; }
        this.emit('download', download);
      }
      else if (event === 'filechooser') {
        if (!this.listenerCount('filechooser') || this.closed) {
          const group = (parameters as { group?: unknown })?.group;
          if (typeof group === 'string') this.client.discardEventHandles(this.identifier, group);
          return;
        }
        let chooser: FileChooser;
        try { chooser = fileChooser(this, this.client, this.identifier, parameters); }
        catch (error) { this.client.rejectProtocol(error); return; }
        this.emit('filechooser', chooser);
      } else if (event === 'console') {
        if (!this.listenerCount('console') && !this.owner.listenerCount('console')) {
          const group = (parameters as { group?: unknown })?.group;
          if (typeof group === 'string') this.client.discardEventHandles(this.identifier, group);
          return;
        }
        let message: ConsoleMessage;
        try { message = consoleMessage(this, this.client, this.identifier, parameters); }
        catch (error) { this.client.rejectProtocol(error); return; }
        this.emit('console', message);
        this.owner.emit('console', message);
      }
    }, initialization.initialEvents);
  }
  private updateFrame(snapshot: FrameSnapshot): Frame {
    let frame = this.ownedFrames.get(snapshot.identifier);
    if (!frame) { frame = new Frame(this, snapshot); this.ownedFrames.set(snapshot.identifier, frame); }
    else frame.didNavigate(snapshot);
    if (snapshot.navigationSequence >= (this.frameLoaders.get(snapshot.identifier)?.sequence ?? -1)) {
      this.frameLoaders.set(snapshot.identifier, { loader: snapshot.loader, sequence: snapshot.navigationSequence });
      this.updateLiveLoaders();
    }
    return frame;
  }
  private updateLiveLoaders(): void {
    this.liveLoaders = new Set([...this.frameLoaders.values()].map(frame => frame.loader).filter(Boolean));
    this.pruneCompletedRequests();
  }
  frameByIdentifier(identifier: string): Frame | null { return this.ownedFrames.get(identifier) ?? null; }
  mainFrame(): Frame { return this.ownedFrames.get(this.mainFrameIdentifier)!; }
  frames(): Frame[] { return [...this.ownedFrames.values()]; }
  frame(nameOrOptions: string | { name?: string; url?: URLMatcher }): Frame | null {
    const match = typeof nameOrOptions === 'string' ? { name: nameOrOptions } : nameOrOptions;
    return this.frames().find(frame => (match.name === undefined || frame.name() === match.name) && (match.url === undefined || matchesURL(frame.url(), match.url, this.owner.baseURL))) ?? null;
  }
  click(...arguments_: Parameters<Frame['click']>): ReturnType<Frame['click']> { return this.mainFrame().click(...arguments_); }
  dblclick(...arguments_: Parameters<Frame['dblclick']>): ReturnType<Frame['dblclick']> { return this.mainFrame().dblclick(...arguments_); }
  hover(...arguments_: Parameters<Frame['hover']>): ReturnType<Frame['hover']> { return this.mainFrame().hover(...arguments_); }
  check(...arguments_: Parameters<Frame['check']>): ReturnType<Frame['check']> { return this.mainFrame().check(...arguments_); }
  uncheck(...arguments_: Parameters<Frame['uncheck']>): ReturnType<Frame['uncheck']> { return this.mainFrame().uncheck(...arguments_); }
  setChecked(...arguments_: Parameters<Frame['setChecked']>): ReturnType<Frame['setChecked']> { return this.mainFrame().setChecked(...arguments_); }
  fill(...arguments_: Parameters<Frame['fill']>): ReturnType<Frame['fill']> { return this.mainFrame().fill(...arguments_); }
  focus(...arguments_: Parameters<Frame['focus']>): ReturnType<Frame['focus']> { return this.mainFrame().focus(...arguments_); }
  selectOption(...arguments_: Parameters<Frame['selectOption']>): ReturnType<Frame['selectOption']> { return this.mainFrame().selectOption(...arguments_); }
  press(...arguments_: Parameters<Frame['press']>): ReturnType<Frame['press']> { return this.mainFrame().press(...arguments_); }
  type(...arguments_: Parameters<Frame['type']>): ReturnType<Frame['type']> { return this.mainFrame().type(...arguments_); }
  locator: Frame['locator'] = (...arguments_) => this.mainFrame().locator(...arguments_);
  frameLocator: Frame['frameLocator'] = (...arguments_) => this.mainFrame().frameLocator(...arguments_);
  getByText: Frame['getByText'] = (...arguments_) => this.mainFrame().getByText(...arguments_);
  getByLabel: Frame['getByLabel'] = (...arguments_) => this.mainFrame().getByLabel(...arguments_);
  getByTestId: Frame['getByTestId'] = (...arguments_) => this.mainFrame().getByTestId(...arguments_);
  getByRole: Frame['getByRole'] = (...arguments_) => this.mainFrame().getByRole(...arguments_);
  getByPlaceholder: Frame['getByPlaceholder'] = (...arguments_) => this.mainFrame().getByPlaceholder(...arguments_);
  getByAltText: Frame['getByAltText'] = (...arguments_) => this.mainFrame().getByAltText(...arguments_);
  getByTitle: Frame['getByTitle'] = (...arguments_) => this.mainFrame().getByTitle(...arguments_);
  async waitForSelector<Tag extends keyof HTMLElementTagNameMap>(selector: Tag, options?: WaitForSelectorOptionsNotHidden): Promise<ElementHandle<HTMLElementTagNameMap[Tag]>>;
  async waitForSelector(selector: string, options?: WaitForSelectorOptionsNotHidden): Promise<ElementHandle<SVGElement | HTMLElement>>;
  async waitForSelector<Tag extends keyof HTMLElementTagNameMap>(selector: Tag, options: WaitForSelectorOptions): Promise<ElementHandle<HTMLElementTagNameMap[Tag]> | null>;
  async waitForSelector(selector: string, options: WaitForSelectorOptions): Promise<ElementHandle<SVGElement | HTMLElement> | null>;
  async waitForSelector(selector: string, options: WaitForSelectorOptions = {}): Promise<ElementHandle<SVGElement | HTMLElement> | null> {
    return this.mainFrame().waitForSelector(selector, options);
  }
  /** Decode only the handle allocation owned by this wait; hidden/detached success has no handle. */
  async runSelectorWait(frame: string, selector: string, waitOptions: WaitForSelectorOptions): Promise<ElementHandle<SVGElement | HTMLElement> | null> {
    const method = 'frame.waitForSelector';
    this.checkOpen(method);
    const parameters = prepareElementResolution(selector, waitOptions);
    const result = await this.client.request(method, { page: this.identifier, frame, ...parameters }, validateTimeout(waitOptions.timeout ?? this.timeout(), method));
    const handles = receivedHandles(this, this.client, this.identifier, result);
    if (handles.length === 0) return null;
    const handle = handles[0]!.handle;
    if (handles.length !== 1 || !(handle instanceof ElementHandle)) throw failure('ProtocolError', method, 'driver omitted a unique element handle');
    return handle;
  }
  async setInputFiles(selector: string, files: InputFiles, options: FrameSetInputFilesOptions = {}): Promise<void> {
    return this.mainFrame().setInputFiles(selector, files, options);
  }
  /** Filesystem preparation precedes the action budget; transport and browser work share that budget. */
  async runFileInput(target: { frame: string; selector: string } | { handle: string }, files: InputFiles, options: FrameSetInputFilesOptions | SetInputFilesOptions): Promise<void> {
    const frame = 'frame' in target;
    const method = frame ? 'frame.setInputFiles' : 'elementHandle.setInputFiles';
    this.checkOpen(method);
    const destination = frame ? { frame: target.frame, selector: fileInputSelector(target.selector, method), strict: (options as FrameSetInputFilesOptions).strict ?? false } : target;
    const prepared = await prepareInputFiles(files, options, method, frame);
    this.checkOpen(method);
    const parameters = { page: this.identifier, ...destination, files: prepared.files };
    const timeout = validateTimeout(options.timeout ?? this.timeout(), method);
    if (prepared.buffers) await this.client.requestWithInput(method, parameters, prepared.buffers, timeout);
    else await this.client.request(method, parameters, timeout);
  }
  async pressKey(key: string, options: KeyboardPressOptions): Promise<void> {
    this.checkOpen('keyboard.press');
    await this.client.request('keyboard.press', { page: this.identifier, keyUnits: Array.from({ length: key.length }, (_, index) => key.charCodeAt(index)), ...options });
  }
  async typeText(parameters: { textUnits: number[]; delay?: number }): Promise<void> {
    this.checkOpen('keyboard.type');
    await this.client.request('keyboard.type', { page: this.identifier, ...parameters });
  }
  async insertKeyboardText(textUnits: number[]): Promise<void> {
    this.checkOpen('keyboard.insertText');
    await this.client.request('keyboard.insertText', { page: this.identifier, textUnits });
  }
  async runLocator<Result>(frame: string, selector: string, action: string, parameters: object, timeoutOptions: LocatorTimeoutOptions, strict = true): Promise<Result> {
    const method = `locator.${action}`;
    this.checkOpen(method);
    options(method, timeoutOptions, ['timeout']);
    const keyboard = ['press', 'pressSequentially'].includes(action);
    const element = ['selectText', 'scrollIntoViewIfNeeded'].includes(action);
    const request = JSON.stringify({ selector, action, strict, ...(keyboard || element ? {} : parameters) });
    if (request.length > 100000) throw failure('ResourceLimitError', method, 'locator request exceeds 100000 UTF-16 units');
    const input = ['click', 'dblclick', 'hover', 'check', 'uncheck', 'setChecked'].includes(action) ? { pointer: parameters } : keyboard ? { keyboard: parameters } : element ? { element: parameters } : {};
    const result = await this.client.request('locator.run', { page: this.identifier, frame, action, request: Array.from({ length: request.length }, (_, index) => request.charCodeAt(index)), ...input }, validateTimeout(timeoutOptions.timeout ?? this.timeout(), method));
    return codec.decode(result) as Result;
  }
  async ariaSnapshot(options: AriaSnapshotOptions = {}): Promise<string> {
    return this.mainFrame().runAriaSnapshot(null, options);
  }
  async runAriaSnapshot(frame: string, selector: string | null, options: AriaSnapshotOptions): Promise<string> {
    const request = prepareAriaSnapshot(selector, options);
    this.checkOpen('aria.snapshot');
    const result = await this.client.request('aria.snapshot', { page: this.identifier, frame, request }, validateTimeout(options.timeout ?? this.timeout(), 'aria.snapshot'));
    return codec.decode(result) as string;
  }
  async runAssertion(frame: string, selector: string | null, assertion: AssertionOptions, timeout: number): Promise<AssertionResult> {
    this.checkOpen('assertion.run');
    const request = JSON.stringify({ selector, ...assertion });
    if (request.length > 100000) throw failure('ResourceLimitError', 'assertion.run', 'assertion request exceeds 100000 UTF-16 units');
    let timedOut = false;
    let result: unknown;
    try {
      result = await this.client.request('assertion.run', { page: this.identifier, frame, expression: assertion.expression, isNot: assertion.isNot, request: Array.from({ length: request.length }, (_, index) => request.charCodeAt(index)) }, validateTimeout(timeout, 'assertion.run'));
    } catch (error) {
      if (!(error instanceof FlashwrightError) || error.name !== 'TimeoutError') throw error;
      timedOut = true;
      result = error.details.diagnostics;
    }
    const observation = result && typeof result === 'object' ? result as Record<string, unknown> : {};
    return {
      observed: observation.status === 'observation',
      matches: timedOut ? assertion.isNot : observation.matches === true,
      received: observation.received === undefined ? undefined : codec.decode(observation.received),
      ...(observation.ariaSnapshot === undefined ? {} : { ariaSnapshot: codec.decode(observation.ariaSnapshot) as string }),
      missingReceived: observation.missingReceived === true,
      timedOut, diagnosticTruncated: observation.diagnosticTruncated === true,
    };
  }
  url(): string { return this.mainFrame().url(); }
  async title(): Promise<string> { return this.evaluate(() => document.title); }
  async screenshot(screenshotOptions: PageScreenshotOptions = {}): Promise<Buffer> {
    this.checkOpen('page.screenshot');
    const prepared = prepareScreenshot(screenshotOptions);
    const timeout = validateTimeout(screenshotOptions.timeout ?? this.timeout(), 'page.screenshot');
    const bytes = await this.client.requestBinary('page.screenshot', { page: this.identifier, ...prepared.parameters }, timeout);
    if (prepared.path) await writeAtomicFile(prepared.path, bytes);
    return bytes;
  }
  private requestFor(metadata: RequestMetadata): Request {
    let request = this.requests.get(metadata.identity);
    if (!request) {
      const predecessor = metadata.redirectedFrom ? this.requests.get(metadata.redirectedFrom) : undefined;
      if (metadata.redirectedFrom && !predecessor) throw failure('ProtocolError', 'request', 'redirect predecessor is outside retained occurrence history');
      request = new Request(this.client, this.identifier, metadata, this, predecessor ?? null, () => this.updateRequestSize(metadata.identity)); this.requests.set(metadata.identity, request);
      if (metadata.navigation) this.navigationOccurrences.set(metadata.loader, metadata.identity);
      if (metadata.redirectedFrom) { this.pendingRedirects.delete(metadata.redirectedFrom); this.pruneCompletedRequests(); }
    }
    return request;
  }
  private responseFor(metadata: ResponseMetadata): Response {
    const request = this.existingRequest(metadata.request);
    if (metadata.identifier !== metadata.request.identifier) throw failure('ProtocolError', 'response', 'response identifier differs from its request occurrence');
    let response = this.responses.get(metadata.request.identity);
    if (!response) {
      response = new Response(this.client, this.identifier, metadata, request, this);
      this.responses.set(metadata.request.identity, response);
      request.didRespond(response);
    }
    return response;
  }
  /** A response or terminal event can only refer to the request occurrence published before it. */
  private existingRequest(reference: RequestReference): Request {
    const request = reference && this.requests.get(reference.identity);
    if (!request || request.metadata.identifier !== reference.identifier) throw failure('ProtocolError', 'request', 'network event refers to an unknown request occurrence');
    return request;
  }
  private completeRequest(request: Request): void {
    this.completedRequests.add(request.metadata.identity);
    this.updateRequestSize(request.metadata.identity);
  }
  private updateRequestSize(identity: string): void {
    if (!this.completedRequests.has(identity)) return;
    const size = this.requests.get(identity)?.retainedBytes() ?? 0;
    this.completedRequestBytes += size - (this.completedRequestSizes.get(identity) ?? 0);
    this.completedRequestSizes.set(identity, size); this.pruneCompletedRequests();
  }
  private pruneCompletedRequests(): void {
    const visited = new Set<string>();
    for (const identity of this.completedRequests) {
      if (this.completedRequests.size <= 1024 && this.completedRequestBytes <= 64 * 1024 * 1024) break;
      if (visited.has(identity)) continue;
      const chain = this.retainedRequestChain(this.requests.get(identity)!);
      for (const request of chain) visited.add(request.metadata.identity);
      // Public redirect links retain both directions, so a partially evicted chain would still own its data.
      if (chain.some(request => !this.completedRequests.has(request.metadata.identity) || this.pendingRedirects.has(request.metadata.identity) || request.metadata.navigation && this.liveLoaders.has(request.metadata.loader) && this.navigationOccurrences.get(request.metadata.loader) === request.metadata.identity)) continue;
      for (const request of chain) {
        const identity = request.metadata.identity;
        this.completedRequestBytes -= this.completedRequestSizes.get(identity) ?? 0; this.completedRequestSizes.delete(identity);
        this.completedRequests.delete(identity); this.requests.delete(identity); this.responses.delete(identity);
        if (request.metadata.navigation && this.navigationOccurrences.get(request.metadata.loader) === identity) this.navigationOccurrences.delete(request.metadata.loader);
      }
    }
    if (this.completedRequests.size > 1024 || this.completedRequestBytes > 64 * 1024 * 1024) {
      const error = failure('ResourceLimitError', 'network.history', 'live navigation and redirect owners exceed the retained request allowance');
      this.client.rejectProtocol(error); throw error;
    }
  }
  private retainedRequestChain(request: Request): Request[] {
    while (request.redirectedFrom()) request = request.redirectedFrom()!;
    const chain: Request[] = [];
    for (let current: Request | null = request; current; current = current.redirectedTo()) chain.push(current);
    return chain;
  }
  private checkOpen(method: string): void {
    if (this.closed) throw failure('TargetClosedError', method, 'page has been closed');
    if (this.crashed) throw failure('PageCrashedError', method, 'page has crashed');
  }
  setDefaultTimeout(timeout: number): void { this.defaultTimeout = validateTimeout(timeout, 'page.setDefaultTimeout'); }
  setDefaultNavigationTimeout(timeout: number): void { this.defaultNavigationTimeout = validateTimeout(timeout, 'page.setDefaultNavigationTimeout'); }
  private timeout(): number { return this.defaultTimeout ?? this.owner.timeout(); }
  private navigationTimeout(): number { return this.defaultNavigationTimeout ?? this.defaultTimeout ?? this.owner.navigationTimeout(); }

  async goto(url: string, navigationOptions: NavigationOptions = {}): Promise<Response | null> {
    this.checkOpen('page.goto');
    options('page.goto', navigationOptions, ['timeout', 'waitUntil', 'referer']);
    if (typeof url !== 'string') throw failure('InvalidArgumentError', 'page.goto', 'url must be a string');
    const timeout = validateTimeout(navigationOptions.timeout ?? this.navigationTimeout(), 'page.goto');
    if (navigationOptions.waitUntil !== undefined && !['load', 'domcontentloaded', 'networkidle', 'commit'].includes(navigationOptions.waitUntil)) throw failure('InvalidArgumentError', 'page.goto.waitUntil', 'invalid navigation lifecycle state');
    if (navigationOptions.referer !== undefined && typeof navigationOptions.referer !== 'string') throw failure('InvalidArgumentError', 'page.goto.referer', 'expected a string');
    let resolved = url;
    try { resolved = new URL(url, this.owner.baseURL).href; } catch {}
    if (resolved.startsWith('localhost') || resolved.startsWith('127.0.0.1')) resolved = 'http://' + resolved;
    const result = await this.client.request('page.goto', { page: this.identifier, url: resolved, waitUntil: navigationOptions.waitUntil ?? 'load', ...(navigationOptions.referer !== undefined ? { referer: navigationOptions.referer } : {}) }, timeout) as { response: ResponseMetadata | null; frames: FrameSnapshot[] };
    for (const snapshot of result.frames) this.updateFrame(snapshot);
    return result.response ? this.responseFor(result.response) : null;
  }
  reload(navigationOptions: NavigationWaitOptions = {}): Promise<Response | null> {
    return this.navigateHistory('page.reload', navigationOptions);
  }
  goBack(navigationOptions: NavigationWaitOptions = {}): Promise<Response | null> {
    return this.navigateHistory('page.goBack', navigationOptions);
  }
  goForward(navigationOptions: NavigationWaitOptions = {}): Promise<Response | null> {
    return this.navigateHistory('page.goForward', navigationOptions);
  }
  private async navigateHistory(method: 'page.reload' | 'page.goBack' | 'page.goForward', navigationOptions: NavigationWaitOptions): Promise<Response | null> {
    this.checkOpen(method);
    options(method, navigationOptions, ['timeout', 'waitUntil']);
    const timeout = validateTimeout(navigationOptions.timeout ?? this.navigationTimeout(), method);
    const waitUntil = navigationOptions.waitUntil ?? 'load';
    if (!['load', 'domcontentloaded', 'networkidle', 'commit'].includes(waitUntil)) throw failure('InvalidArgumentError', `${method}.waitUntil`, 'invalid navigation lifecycle state');
    const result = await this.client.request(method, { page: this.identifier, waitUntil }, timeout) as { response: ResponseMetadata | null; frames: FrameSnapshot[] };
    for (const snapshot of result.frames) this.updateFrame(snapshot);
    return result.response ? this.responseFor(result.response) : null;
  }
  async waitForLoadState(state: 'load' | 'domcontentloaded' | 'networkidle' = 'load', waitOptions: { timeout?: number } = {}): Promise<void> {
    this.checkOpen('page.waitForLoadState');
    options('page.waitForLoadState', waitOptions, ['timeout']);
    await this.client.request('page.waitForLoadState', { page: this.identifier, state }, validateTimeout(waitOptions.timeout ?? this.navigationTimeout(), 'page.waitForLoadState'));
  }
  async waitForEvent<Event extends keyof PageEvents>(event: Event, waitOptions: EventWaitOptions<PageEvents[Event]> | ((value: PageEvents[Event]) => boolean | Promise<boolean>) = {}): Promise<PageEvents[Event]> {
    if (!['response', 'request', 'requestfinished', 'requestfailed', 'framenavigated', 'frameattached', 'framedetached', 'close', 'crash', 'load', 'domcontentloaded', 'pageerror', 'console', 'filechooser', 'dialog', 'download'].includes(event)) throw failure('UnsupportedFeatureError', 'page.waitForEvent', 'event is not implemented');
    this.checkOpen('page.waitForEvent');
    const configured = typeof waitOptions === 'function' ? { predicate: waitOptions } : waitOptions;
    options('page.waitForEvent', configured, ['predicate', 'timeout']);
    return waitForEvent(this, event, configured, this.timeout(), 'page.waitForEvent');
  }
  async waitForResponse(matcher: string | RegExp | ((response: Response) => boolean | Promise<boolean>), waitOptions: { timeout?: number } = {}): Promise<Response> {
    options('page.waitForResponse', waitOptions, ['timeout']);
    if (typeof matcher !== 'string' && typeof matcher !== 'function' && !(matcher instanceof RegExp)) throw failure('InvalidArgumentError', 'page.waitForResponse', 'expected a string, regular expression or response predicate');
    return this.waitForEvent('response', { ...waitOptions, predicate: response => typeof matcher === 'function' ? matcher(response) : matchesURL(response.url(), matcher, this.owner.baseURL) });
  }
  waitForNavigation(waitOptions: WaitForNavigationOptions = {}): Promise<Response | null> {
    return this.waitForNavigationState(waitOptions, 'page.waitForNavigation');
  }
  private async waitForNavigationState(waitOptions: WaitForNavigationOptions, method: 'page.waitForNavigation' | 'page.waitForURL'): Promise<Response | null> {
    this.checkOpen(method);
    options(method, waitOptions, ['timeout', 'waitUntil', 'url']);
    if (waitOptions.url !== undefined) validateURLMatcher(waitOptions.url);
    const timeout = validateTimeout(waitOptions.timeout ?? this.navigationTimeout(), method);
    const waitUntil = waitOptions.waitUntil ?? 'load';
    if (!['load', 'domcontentloaded', 'networkidle', 'commit'].includes(waitUntil)) throw failure('InvalidArgumentError', `${method}.waitUntil`, 'invalid navigation lifecycle state');
    const waiter = new NavigationWaiter(this, this.client, method, timeout);
    type NavigationCursor = { frame: string; sequence: number };
    try {
      let cursor = await waiter.request<NavigationCursor>('page.navigation.capture', { page: this.identifier, sequence: this.navigationSequence });
      while (true) {
        const event = await waiter.request<NavigationCursor & { url: string }>('page.navigation.next', { page: this.identifier, ...cursor });
        cursor = { frame: event.frame, sequence: event.sequence };
        if (waitOptions.url !== undefined && !await waiter.predicate(() => matchesURL(event.url, waitOptions.url!, this.owner.baseURL))) continue;
        const result = await waiter.request<{ response: ResponseMetadata | null; frames: FrameSnapshot[] }>('page.navigation.complete', { page: this.identifier, ...cursor, waitUntil });
        for (const snapshot of result.frames) this.updateFrame(snapshot);
        return result.response ? this.responseFor(result.response) : null;
      }
    } finally { waiter.dispose(); }
  }
  async waitForURL(matcher: URLMatcher, waitOptions: NavigationWaitOptions = {}): Promise<void> {
    this.checkOpen('page.waitForURL');
    options('page.waitForURL', waitOptions, ['timeout', 'waitUntil']);
    validateURLMatcher(matcher);
    const timeout = validateTimeout(waitOptions.timeout ?? this.navigationTimeout(), 'page.waitForURL');
    const waitUntil = waitOptions.waitUntil ?? 'load';
    if (!['load', 'domcontentloaded', 'networkidle', 'commit'].includes(waitUntil)) throw failure('InvalidArgumentError', 'page.waitForURL.waitUntil', 'invalid navigation lifecycle state');
    if (matchesURL(this.url(), matcher, this.owner.baseURL)) {
      if (waitUntil !== 'commit') {
        const waiter = new NavigationWaiter(this, this.client, 'page.waitForURL', timeout);
        try { await waiter.request('page.waitForLoadState', { page: this.identifier, state: waitUntil }); }
        finally { waiter.dispose(); }
      }
      return;
    }
    await this.waitForNavigationState({ ...waitOptions, url: matcher }, 'page.waitForURL');
  }
  async addInitScript<Argument = void>(script: InitScript<Argument>, argument?: Argument): Promise<Disposable> {
    const sourceJson = await prepareInitScript('page.addInitScript', script, argument);
    this.checkOpen('page.addInitScript');
    const result = await this.client.request('page.addInitScript', { page: this.identifier, sourceJson });
    return new InitScriptRegistration(this.client, identifier(result), () => tracePageOwner(this));
  }
  context(): BrowserContext { return this.owner; }
  route(matcher: URLMatcher, handler: RouteHandler, options?: RouteOptions): Promise<Disposable> { return this.routeRegistry.route(matcher, handler, options); }
  unroute(matcher: URLMatcher, handler?: RouteHandler): Promise<void> { return this.routeRegistry.unroute(matcher, handler); }
  unrouteAll(options?: UnrouteAllOptions): Promise<void> { return this.routeRegistry.unrouteAll(options); }
  isClosed(): boolean { return this.closed; }
  viewportSize(): ViewportSize | null { return this.owner.viewport ? { ...this.owner.viewport } : null; }
  async evaluate<Result, Argument>(pageFunction: string | ((argument: Unboxed<Argument>) => Result | Promise<Result>), argument: Argument): Promise<Result>;
  async evaluate<Result>(pageFunction: string | (() => Result | Promise<Result>)): Promise<Result>;
  async evaluate(pageFunction: string | Function, argument?: unknown): Promise<unknown> {
    return this.runEvaluation('page.evaluate', pageFunction, argument);
  }
  async evaluateHandle<Result, Argument>(pageFunction: string | ((argument: Unboxed<Argument>) => Result | Promise<Result>), argument: Argument): Promise<SmartHandle<Result>>;
  async evaluateHandle<Result>(pageFunction: string | (() => Result | Promise<Result>)): Promise<SmartHandle<Result>>;
  async evaluateHandle(pageFunction: string | Function, argument?: unknown): Promise<JSHandle> {
    return this.runEvaluation('page.evaluateHandle', pageFunction, argument) as Promise<JSHandle>;
  }
  async waitForFunction<Result, Argument>(pageFunction: string | ((argument: Unboxed<Argument>) => Result | Promise<Result>), argument: Argument, options?: PageWaitForFunctionOptions): Promise<SmartHandle<Result>>;
  async waitForFunction<Result>(pageFunction: string | (() => Result | Promise<Result>), argument?: unknown, options?: PageWaitForFunctionOptions): Promise<SmartHandle<Result>>;
  async waitForFunction(pageFunction: string | Function, argument?: unknown, options: PageWaitForFunctionOptions = {}): Promise<JSHandle> {
    return this.mainFrame().waitForFunction(pageFunction as string | ((argument: unknown) => unknown), argument, options);
  }
  /** A polling result enters the same original-world handle publication boundary as evaluation. */
  async runFunctionWait(frame: string, pageFunction: string | Function, argument: unknown, options: PageWaitForFunctionOptions): Promise<JSHandle> {
    const method = 'frame.waitForFunction';
    this.checkOpen(method);
    const prepared = prepareFunctionWait(method, pageFunction, options);
    const timeout = validateTimeout(options.timeout ?? this.timeout(), method);
    const encoded = encodeEvaluationArgument(argument, this.client, method);
    const result = await this.client.request(method, { page: this.identifier, frame, ...prepared, ...encoded }, timeout);
    const handles = receivedHandles(this, this.client, this.identifier, result);
    if (handles.length !== 1) throw failure('ProtocolError', method, 'driver omitted a unique predicate result handle');
    return handles[0]!.handle;
  }
  async runEvaluation(method: string, pageFunction: string | Function, argument?: unknown, target: { frame?: string; handle?: string } = {}): Promise<unknown> {
    this.checkOpen(method);
    if (typeof pageFunction !== 'string' && typeof pageFunction !== 'function') throw failure('InvalidArgumentError', method, 'expected a function or JavaScript expression string');
    const source = typeof pageFunction === 'function' ? `(${pageFunction.toString()})` : pageFunction;
    if (source.length > 100000) throw failure('ResourceLimitError', method, 'evaluation source exceeds 100000 UTF-16 units');
    const encoded = encodeEvaluationArgument(argument, this.client, method);
    const result = await this.client.request(method, { page: this.identifier, ...target, source: Array.from({ length: source.length }, (_, index) => source.charCodeAt(index)), isFunction: typeof pageFunction === 'function', ...encoded });
    if (method.endsWith('Handle')) return receivedHandles(this, this.client, this.identifier, result)[0]!.handle;
    return codec.decode(result);
  }
  async runHandle(method: string, handle: string, parameters: object = {}): Promise<unknown> {
    this.checkOpen(method);
    return this.client.request(method, { page: this.identifier, handle, ...parameters });
  }
  /** Element actions use the inherited action timeout while ordinary handle evaluation remains unbounded. */
  async runElementAction(method: string, handle: string, parameters: object, timeout: number | undefined): Promise<void> {
    this.checkOpen(method);
    await this.client.request(method, { page: this.identifier, handle, ...parameters }, validateTimeout(timeout ?? this.timeout(), method));
  }
  close(closeOptions: PageCloseOptions = {}): Promise<void> {
    options('page.close', closeOptions, ['runBeforeUnload']);
    if (closeOptions.runBeforeUnload !== undefined && typeof closeOptions.runBeforeUnload !== 'boolean') throw failure('InvalidArgumentError', 'page.close.runBeforeUnload', 'expected a boolean');
    if (closeOptions.runBeforeUnload) throw failure('UnsupportedFeatureError', 'page.close.runBeforeUnload', 'dismissible page closure is not implemented; beforeunload navigation dialogs are supported');
    if (this.closed) return this.closing ?? Promise.resolve();
    this.closing ??= (async () => {
      const failures = new OwnerCloseFailures();
      await failures.wait(() => this.ownsContext ? this.owner.close() : this.client.request('page.close', { page: this.identifier }));
      failures.run(() => this.didClose());
      failures.rethrow();
    })();
    return this.closing;
  }
  didClose(): void {
    if (this.closed) return;
    this.closed = true;
    const failures = new OwnerCloseFailures();
    failures.run(() => this.routeRegistry.close());
    failures.run(() => this.unsubscribe());
    for (const frame of this.ownedFrames.values()) failures.run(() => frame.didDetach());
    for (const request of this.requests.values()) failures.run(() => request.didFail('Target closed'));
    this.completedRequestSizes.clear(); this.completedRequestBytes = 0; this.pendingRedirects.clear();
    this.requests.clear(); this.responses.clear(); this.completedRequests.clear(); this.navigationOccurrences.clear(); this.frameLoaders.clear(); this.liveLoaders.clear();
    failures.run(() => this.owner.recordTracePageClosed(this.identifier));
    failures.run(() => this.emit('close', this));
    failures.run(() => retireOwnerRegistration(this));
    failures.rethrow();
  }
}

export const chromium = new BrowserType('chromium');
export const firefox = new BrowserType('firefox');
export const webkit = new BrowserType('webkit');
export { request } from './api-request.js';
export type { APIRequest, APIRequestContext, APIResponse, APIRequestContextOptions, APIRequestOptions, APIRequestFilePayload, APIRequestHeader } from './api-request.js';

instrumentTraceCallbacks(Browser.prototype, 'emit');
