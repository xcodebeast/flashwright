import { EventEmitter } from 'node:events';
import { ConsoleEmitter, ConsoleMessage, consoleMessage } from './console.js';
export { ConsoleMessage } from './console.js';
export type { ConsoleMessageType } from './console.js';
import { JSHandle, ElementHandle, receivedHandles, encodeEvaluationArgument, type Unboxed, type SmartHandle } from './handles.js';
import { pageError } from './page-errors.js';
import { prepareScreenshot, type PageScreenshotOptions } from './screenshots.js';
import { writeAtomicFile } from './files.js';
import { Keyboard, type KeyboardPressOptions } from './keyboard.js';
import { EngineClient, retainEngine } from './client.js';
import { failure, FlashwrightError } from './errors.js';
import type { AssertionOptions, AssertionResult } from './assertions.js';
import { Frame, type FrameSnapshot } from './frame.js';
import { Request, Response, type RequestMetadata, type ResponseMetadata } from './network.js';
import { waitForEvent, matchesURL, validateTimeout, type URLMatcher, type EventWaitOptions } from './waits.js';
import { performance } from 'node:perf_hooks';
import { createValueCodec } from './serialization.cjs';
import type { LocatorTimeoutOptions } from './locator.js';
import { validateOptions as options } from './validation.js';
import { prepareCookies, filterCookies, cookieFilter, prepareStorageState, decodeStorageState, writeStorageState, type Cookie, type SetCookie, type CookieFilter, type StorageState, type StorageStateOptions, type WireStorageState } from './storage.js';

export * from './errors.js';
export { Keyboard, JSHandle, ElementHandle };
export type { Unboxed, SmartHandle };
export type { PageScreenshotOptions };
export type { KeyboardPressOptions };
export type { AssertionOptions, AssertionResult, ExpectedText } from './assertions.js';
export { Frame, Request, Response };
export { Locator } from './locator.js';
export type { LocatorOptions, TextOptions, RoleOptions, LocatorTimeoutOptions, FillOptions, SelectOption, ClickOptions, HoverOptions, CheckOptions, PressOptions, KeyboardModifier } from './locator.js';
export type { URLMatcher };
export type { Cookie, SetCookie, CookieFilter, StorageState, StorageStateOptions };
const codec = createValueCodec();

export interface LaunchOptions { executablePath?: string; headless?: boolean; timeout?: number }
export interface ViewportSize { width: number; height: number }
export interface BrowserContextOptions { viewport?: ViewportSize | null; baseURL?: string; storageState?: StorageState | string }
export interface NavigationOptions { timeout?: number; waitUntil?: 'load' | 'domcontentloaded' | 'networkidle' | 'commit'; referer?: string }
interface PageInitialization { identifier: string; frames: FrameSnapshot[]; mainFrame: string }
interface ContextEvents { page: Page; close: BrowserContext; console: ConsoleMessage }
interface PageEvents { console: ConsoleMessage; response: Response; request: Request; requestfinished: Request; requestfailed: Request; framenavigated: Frame; frameattached: Frame; framedetached: Frame; close: Page; crash: Page; load: Page; domcontentloaded: Page; pageerror: Error }


function identifier(value: unknown): string {
  if (!value || typeof value !== 'object' || !('identifier' in value) || typeof value.identifier !== 'string') throw failure('ProtocolError', 'protocol', 'driver omitted object identity');
  return value.identifier;
}

export class BrowserType {
  constructor(private readonly browserName: string) {}
  name(): string { return this.browserName; }
  async launch(launchOptions: LaunchOptions = {}): Promise<Browser> {
    if (this.browserName !== 'chromium') throw failure('UnsupportedFeatureError', `${this.browserName}.launch`, 'only Chromium is implemented');
    options('chromium.launch', launchOptions, ['executablePath', 'headless', 'timeout']);
    const executablePath = launchOptions.executablePath ?? process.env.FLASHWRIGHT_BROWSER_PATH;
    if (typeof executablePath !== 'string' || !executablePath) throw failure('InvalidArgumentError', 'chromium.launch', 'provide executablePath or FLASHWRIGHT_BROWSER_PATH for Chromium 148.0.7778.96');
    if (launchOptions.headless !== undefined && typeof launchOptions.headless !== 'boolean') throw failure('InvalidArgumentError', 'chromium.launch.headless', 'expected a boolean');
    const timeout = launchOptions.timeout ?? 30000;
    if (!Number.isFinite(timeout) || timeout < 0) throw failure('InvalidArgumentError', 'chromium.launch.timeout', 'expected a finite nonnegative number');
    const client = retainEngine();
    try {
      const result = await client.request('browser.launch', { executablePath, headless: launchOptions.headless ?? true }, timeout);
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
  private readonly unsubscribe: () => void;
  constructor(private readonly client: EngineClient, private readonly identifier: string, private readonly browserVersion: string) {
    super();
    this.unsubscribe = client.subscribeObject(identifier, event => {
      if (event.event === 'disconnected' || event.event === 'transportclosed') {
        this.didDisconnect();
        if (!this.closing) void this.releaseDriver();
      }
    });
  }
  private releaseDriver(): Promise<void> { return this.released ??= this.client.release(); }
  private didDisconnect(): void {
    if (this.disconnected) return;
    this.disconnected = true;
    for (const context of this.ownedContexts) context.didClose();
    this.ownedContexts.clear();
    this.unsubscribe();
    this.emit('disconnected', this);
  }
  version(): string { return this.browserVersion; }
  contexts(): BrowserContext[] { return [...this.ownedContexts]; }
  isConnected(): boolean { return !this.disconnected && !this.closing && !this.client.isClosed(); }
  async newContext(contextOptions: BrowserContextOptions = {}): Promise<BrowserContext> {
    options('browser.newContext', contextOptions, ['viewport', 'baseURL', 'storageState']);
    if (contextOptions.baseURL !== undefined && typeof contextOptions.baseURL !== 'string') throw failure('InvalidArgumentError', 'browser.newContext.baseURL', 'expected a string');
    if (contextOptions.viewport !== undefined && contextOptions.viewport !== null) {
      options('browser.newContext.viewport', contextOptions.viewport, ['width', 'height']);
      if (![contextOptions.viewport.width, contextOptions.viewport.height].every(value => Number.isInteger(value) && value > 0 && value <= 0xffffffff)) throw failure('InvalidArgumentError', 'browser.newContext.viewport', 'width and height must be positive 32-bit integers');
    }
    if (!this.isConnected()) throw failure('TargetClosedError', 'browser.newContext', 'browser has been closed');
    const storageState = contextOptions.storageState === undefined ? undefined : await prepareStorageState(contextOptions.storageState);
    const result = await this.client.request('browser.newContext', { browser: this.identifier, ...(contextOptions.viewport !== undefined ? { viewport: contextOptions.viewport } : {}), ...(storageState === undefined ? {} : { storageState }) });
    if (!this.isConnected()) {
      if (!this.client.isClosed()) await this.client.request('context.close', { context: identifier(result) });
      throw failure('TargetClosedError', 'browser.newContext', 'browser closed while the context was being created');
    }
    const context = new BrowserContext(this.client, identifier(result), this, contextOptions.viewport === undefined ? { width: 1280, height: 720 } : contextOptions.viewport, contextOptions.baseURL);
    this.ownedContexts.add(context);
    context.once('close', () => this.ownedContexts.delete(context));
    return context;
  }
  async newPage(contextOptions: BrowserContextOptions = {}): Promise<Page> {
    const context = await this.newContext(contextOptions);
    try { return await context.newOwnedPage(); } catch (error) { await context.close(); throw error; }
  }
  close(): Promise<void> {
    this.closing ??= (async () => {
      try { if (!this.disconnected) await this.client.request('browser.close', { browser: this.identifier }); }
      finally { this.didDisconnect(); await this.releaseDriver(); }
    })();
    return this.closing;
  }
}

export class BrowserContext extends ConsoleEmitter<{ [Event in keyof ContextEvents]: [ContextEvents[Event]] }> {
  private readonly ownedPages = new Set<Page>();
  private closed = false;
  private closing: Promise<void> | undefined;
  private readonly unsubscribe: () => void;
  private defaultTimeout = 30000;
  private defaultNavigationTimeout: number | undefined;
  constructor(private readonly client: EngineClient, private readonly identifier: string, private readonly owner: Browser, readonly viewport: ViewportSize | null, readonly baseURL: string | undefined) {
    super(enabled => client.setConsoleSubscription('context', identifier, enabled));
    this.unsubscribe = client.subscribeObject(identifier, event => { if (event.event === 'close' || event.event === 'transportclosed') this.didClose(); });
  }
  async waitForEvent<Event extends keyof ContextEvents>(event: Event, waitOptions: EventWaitOptions<ContextEvents[Event]> | ((value: ContextEvents[Event]) => boolean | Promise<boolean>) = {}): Promise<ContextEvents[Event]> {
    if (!['console', 'page', 'close'].includes(event)) throw failure('UnsupportedFeatureError', 'context.waitForEvent', 'event is not implemented');
    if (this.closed) throw failure('TargetClosedError', 'context.waitForEvent', 'context is closed');
    const configured = typeof waitOptions === 'function' ? { predicate: waitOptions } : waitOptions;
    options('context.waitForEvent', configured, ['predicate', 'timeout']);
    return waitForEvent(this, event, configured, this.timeout(), 'context.waitForEvent');
  }
  setDefaultTimeout(timeout: number): void { this.defaultTimeout = validateTimeout(timeout, 'context.setDefaultTimeout'); }
  setDefaultNavigationTimeout(timeout: number): void { this.defaultNavigationTimeout = validateTimeout(timeout, 'context.setDefaultNavigationTimeout'); }
  timeout(): number { return this.defaultTimeout; }
  navigationTimeout(): number { return this.defaultNavigationTimeout ?? this.defaultTimeout; }
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
  async newPage(): Promise<Page> { return this.createPage(false); }
  async newOwnedPage(): Promise<Page> { return this.createPage(true); }
  private async createPage(ownsContext: boolean): Promise<Page> {
    if (this.closed) throw failure('TargetClosedError', 'context.newPage', 'context has been closed');
    const result = await this.client.request('context.newPage', { context: this.identifier });
    if (this.closed) throw failure('TargetClosedError', 'context.newPage', 'context closed while the page was being created');
    const page = new Page(this.client, identifier(result), this, ownsContext, result as PageInitialization);
    this.ownedPages.add(page);
    page.once('close', () => this.ownedPages.delete(page));
    this.emit('page', page);
    return page;
  }
  close(): Promise<void> {
    if (this.closed) return this.closing ?? Promise.resolve();
    this.closing ??= (async () => {
      try { await this.client.request('context.close', { context: this.identifier }); }
      finally { this.didClose(); }
    })();
    return this.closing;
  }
  didClose(): void {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribe();
    for (const page of this.ownedPages) page.didClose();
    this.ownedPages.clear();
    this.emit('close', this);
  }
}

export class Page extends ConsoleEmitter<{ [Event in keyof PageEvents]: [PageEvents[Event]] }> {
  readonly keyboard = new Keyboard(this);
  private closed = false;
  private closing: Promise<void> | undefined;
  private crashed = false;
  private readonly unsubscribe: () => void;
  private readonly ownedFrames = new Map<string, Frame>();
  private readonly requests = new Map<string, Request>();
  private readonly responses = new Map<string, Response>();
  private readonly mainFrameIdentifier: string;
  private defaultTimeout: number | undefined;
  private defaultNavigationTimeout: number | undefined;
  constructor(private readonly client: EngineClient, private readonly identifier: string, private readonly owner: BrowserContext, private readonly ownsContext: boolean, initialization: PageInitialization) {
    super(enabled => client.setConsoleSubscription('page', identifier, enabled));
    this.mainFrameIdentifier = initialization.mainFrame;
    for (const snapshot of initialization.frames) this.updateFrame(snapshot);
    this.unsubscribe = client.subscribeObject(identifier, ({ event, parameters }) => {
      if (event === 'close' || event === 'transportclosed') this.didClose();
      else if (event === 'crash') { if (!this.crashed) { this.crashed = true; this.emit('crash', this); } }
      else if (event === 'frameattached' || event === 'framenavigated') this.emit(event, this.updateFrame(parameters as FrameSnapshot));
      else if (event === 'framedetached') {
        const snapshot = parameters as FrameSnapshot;
        const frame = this.ownedFrames.get(snapshot.identifier);
        if (frame) { frame.didDetach(); this.ownedFrames.delete(snapshot.identifier); this.emit(event, frame); }
      } else if (event === 'request' || event === 'requestfinished') {
        const request = this.requestFor(parameters as RequestMetadata);
        if (event === 'requestfinished') request.didFinish();
        this.emit(event, request);
      }
      else if (event === 'response') this.emit('response', this.responseFor(parameters as ResponseMetadata));
      else if (event === 'requestfailed') {
        const details = parameters as { request: RequestMetadata; errorText: string };
        const request = this.requestFor(details.request); request.didFail(details.errorText); this.emit(event, request);
      } else if (event === 'load' || event === 'domcontentloaded') this.emit(event, this);
      else if (event === 'pageerror') this.emit('pageerror', pageError(parameters));
      else if (event === 'console') {
        if (!this.listenerCount('console') && !this.owner.listenerCount('console')) {
          const group = (parameters as { group?: unknown })?.group;
          if (typeof group === 'string') this.client.discardConsoleArguments(this.identifier, group);
          return;
        }
        let message: ConsoleMessage;
        try { message = consoleMessage(this, this.client, this.identifier, parameters); }
        catch (error) { this.client.rejectConsoleProtocol(error); return; }
        this.emit('console', message);
        this.owner.emit('console', message);
      }
    });
  }
  private updateFrame(snapshot: FrameSnapshot): Frame {
    let frame = this.ownedFrames.get(snapshot.identifier);
    if (!frame) { frame = new Frame(this, snapshot); this.ownedFrames.set(snapshot.identifier, frame); }
    else frame.didNavigate(snapshot);
    return frame;
  }
  frameByIdentifier(identifier: string): Frame | null { return this.ownedFrames.get(identifier) ?? null; }
  mainFrame(): Frame { return this.ownedFrames.get(this.mainFrameIdentifier)!; }
  frames(): Frame[] { return [...this.ownedFrames.values()]; }
  frame(nameOrOptions: string | { name?: string; url?: URLMatcher }): Frame | null {
    const match = typeof nameOrOptions === 'string' ? { name: nameOrOptions } : nameOrOptions;
    return this.frames().find(frame => (match.name === undefined || frame.name() === match.name) && (match.url === undefined || matchesURL(frame.url(), match.url, this.owner.baseURL))) ?? null;
  }
  locator: Frame['locator'] = (...arguments_) => this.mainFrame().locator(...arguments_);
  getByText: Frame['getByText'] = (...arguments_) => this.mainFrame().getByText(...arguments_);
  getByLabel: Frame['getByLabel'] = (...arguments_) => this.mainFrame().getByLabel(...arguments_);
  getByTestId: Frame['getByTestId'] = (...arguments_) => this.mainFrame().getByTestId(...arguments_);
  getByRole: Frame['getByRole'] = (...arguments_) => this.mainFrame().getByRole(...arguments_);
  getByPlaceholder: Frame['getByPlaceholder'] = (...arguments_) => this.mainFrame().getByPlaceholder(...arguments_);
  getByAltText: Frame['getByAltText'] = (...arguments_) => this.mainFrame().getByAltText(...arguments_);
  getByTitle: Frame['getByTitle'] = (...arguments_) => this.mainFrame().getByTitle(...arguments_);
  async pressKey(key: string, options: KeyboardPressOptions): Promise<void> {
    this.checkOpen('keyboard.press');
    await this.client.request('keyboard.press', { page: this.identifier, keyUnits: Array.from({ length: key.length }, (_, index) => key.charCodeAt(index)), ...options });
  }
  async runLocator<Result>(frame: string, selector: string, action: string, parameters: object, timeoutOptions: LocatorTimeoutOptions): Promise<Result> {
    const method = `locator.${action}`;
    this.checkOpen(method);
    options(method, timeoutOptions, ['timeout']);
    const request = JSON.stringify({ selector, action, ...parameters });
    if (request.length > 100000) throw failure('ResourceLimitError', method, 'locator request exceeds 100000 UTF-16 units');
    const input = ['click', 'dblclick', 'hover', 'check', 'uncheck', 'setChecked'].includes(action) ? { pointer: parameters } : action === 'press' ? { keyboard: parameters } : {};
    const result = await this.client.request('locator.run', { page: this.identifier, frame, action, request: Array.from({ length: request.length }, (_, index) => request.charCodeAt(index)), ...input }, validateTimeout(timeoutOptions.timeout ?? this.timeout(), method));
    return codec.decode(result) as Result;
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
      request = new Request(metadata); this.requests.set(metadata.identity, request);
      if (this.requests.size > 1024) this.requests.delete(this.requests.keys().next().value!);
    }
    return request;
  }
  private responseFor(metadata: ResponseMetadata): Response {
    let response = this.responses.get(metadata.request.identity);
    if (!response) {
      response = new Response(this.client, this.identifier, metadata, this.requestFor(metadata.request));
      this.responses.set(metadata.request.identity, response);
      if (this.responses.size > 1024) this.responses.delete(this.responses.keys().next().value!);
    }
    return response;
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
  async waitForLoadState(state: 'load' | 'domcontentloaded' | 'networkidle' = 'load', waitOptions: { timeout?: number } = {}): Promise<void> {
    this.checkOpen('page.waitForLoadState');
    options('page.waitForLoadState', waitOptions, ['timeout']);
    await this.client.request('page.waitForLoadState', { page: this.identifier, state }, validateTimeout(waitOptions.timeout ?? this.navigationTimeout(), 'page.waitForLoadState'));
  }
  async waitForEvent<Event extends keyof PageEvents>(event: Event, waitOptions: EventWaitOptions<PageEvents[Event]> | ((value: PageEvents[Event]) => boolean | Promise<boolean>) = {}): Promise<PageEvents[Event]> {
    if (!['response', 'request', 'requestfinished', 'requestfailed', 'framenavigated', 'frameattached', 'framedetached', 'close', 'crash', 'load', 'domcontentloaded', 'pageerror', 'console'].includes(event)) throw failure('UnsupportedFeatureError', 'page.waitForEvent', 'event is not implemented');
    this.checkOpen('page.waitForEvent');
    const configured = typeof waitOptions === 'function' ? { predicate: waitOptions } : waitOptions;
    options('page.waitForEvent', configured, ['predicate', 'timeout']);
    return waitForEvent(this, event, configured, this.timeout(), 'page.waitForEvent');
  }
  async waitForResponse(matcher: string | RegExp | ((response: Response) => boolean | Promise<boolean>), waitOptions: { timeout?: number } = {}): Promise<Response> {
    options('page.waitForResponse', waitOptions, ['timeout']);
    return this.waitForEvent('response', { ...waitOptions, predicate: response => typeof matcher === 'function' ? matcher(response) : matchesURL(response.url(), matcher, this.owner.baseURL) });
  }
  async waitForURL(matcher: URLMatcher, waitOptions: Omit<NavigationOptions, 'referer'> = {}): Promise<void> {
    this.checkOpen('page.waitForURL');
    options('page.waitForURL', waitOptions, ['timeout', 'waitUntil']);
    const started = performance.now();
    const timeout = validateTimeout(waitOptions.timeout ?? this.navigationTimeout(), 'page.waitForURL');
    if (!matchesURL(this.url(), matcher, this.owner.baseURL)) await this.waitForEvent('framenavigated', { timeout, predicate: frame => frame === this.mainFrame() && matchesURL(frame.url(), matcher, this.owner.baseURL) });
    if (waitOptions.waitUntil === 'commit') return;
    const remaining = timeout === 0 ? 0 : timeout - (performance.now() - started);
    if (timeout !== 0 && remaining <= 0) throw failure('TimeoutError', 'page.waitForURL', 'URL wait exceeded its deadline');
    await this.waitForLoadState(waitOptions.waitUntil ?? 'load', { timeout: remaining });
  }
  context(): BrowserContext { return this.owner; }
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
  close(): Promise<void> {
    if (this.closed) return this.closing ?? Promise.resolve();
    this.closing ??= (async () => {
      try {
        if (this.ownsContext) await this.owner.close();
        else await this.client.request('page.close', { page: this.identifier });
      } finally { this.didClose(); }
    })();
    return this.closing;
  }
  didClose(): void {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribe();
    for (const frame of this.ownedFrames.values()) frame.didDetach();
    for (const request of this.requests.values()) request.didFail('Target closed');
    this.emit('close', this);
  }
}

export const chromium = new BrowserType('chromium');
export const firefox = new BrowserType('firefox');
export const webkit = new BrowserType('webkit');
export const request = { async newContext(): Promise<never> { throw failure('UnsupportedFeatureError', 'request.newContext', 'API requests are not implemented'); } };
