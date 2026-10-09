import { AsyncLocalStorage, AsyncResource } from 'node:async_hooks';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import type { EngineClient } from './client.js';
import type { Page } from './index.js';
import type { Request, Header } from './network.js';
import type { Disposable } from './init-scripts.js';
import { failure } from './errors.js';
import { fileMimeType } from './file-mime-types.js';
import { responseStatusText } from './response-status-text.js';
import { runTraceUserCallback, instrumentTraceMethods, tracePageOwner } from './trace-hooks.js';
import { validateOptions } from './validation.js';
import { matchesURL, validateURLMatcher, type URLMatcher } from './waits.js';

export interface RouteContinueOptions { url?: string; method?: string; headers?: Record<string, string | undefined>; postData?: any }
export interface RouteFulfillOptions { status?: number; headers?: Record<string, string>; contentType?: string; body?: string | Buffer; json?: any; path?: string }
export interface RouteOptions { times?: number }
export interface UnrouteAllOptions { behavior?: 'wait' | 'ignoreErrors' | 'default' }
export type RouteHandler = (route: Route, request: Request) => unknown | Promise<unknown>;
export interface RequestOverrides { url?: string; method?: string; headers?: Record<string, string | undefined>; postDataBuffer?: Buffer }
const maximumBodyBytes = 32 * 1024 * 1024;
const maximumMetadataBytes = 1024 * 1024;
interface Handling { registry: RouteRegistry; decision: Promise<boolean>; resolve(value: boolean): void; operationFailed: boolean; generation: number; next: readonly RouteRegistry[] }
const invocation = new AsyncLocalStorage<{ route: Route; handling: Handling }>();

function checkBody(body: Buffer, method: string): Buffer {
  if (body.byteLength > maximumBodyBytes) throw failure('ResourceLimitError', method, 'route body exceeds 32 MiB');
  return body;
}
function encodeBody(value: string | Buffer, method: string): Buffer {
  if (Buffer.isBuffer(value)) return checkBody(value, method);
  if (typeof value !== 'string') throw failure('InvalidArgumentError', method, 'body must be a string or Buffer');
  if (Buffer.byteLength(value) > maximumBodyBytes) throw failure('ResourceLimitError', method, 'route body exceeds 32 MiB');
  return Buffer.from(value);
}
function headerEntries(value: Record<string, string | undefined>, method: string): Header[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw failure('InvalidArgumentError', method, 'headers must be an object');
  let bytes = 0;
  const result: Header[] = [];
  for (const [name, entry] of Object.entries(value)) {
    if (entry === undefined) continue;
    if (typeof entry !== 'string' || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || /[\r\n\0]/.test(entry)) throw failure('InvalidArgumentError', method, 'invalid HTTP header');
    bytes += (name.length + entry.length) * 2;
    if (bytes > maximumMetadataBytes || result.length === 4096) throw failure('ResourceLimitError', method, 'route headers exceed the supported allowance');
    result.push({ name, value: entry });
  }
  return result;
}

export function prepareRouteOverrides(options: RouteContinueOptions, request: Request): RequestOverrides {
  validateOptions('route.continue', options, ['url', 'method', 'headers', 'postData']);
  const overrides: RequestOverrides = {};
  if (options.url !== undefined) {
    if (typeof options.url !== 'string' || !URL.canParse(options.url)) throw failure('InvalidArgumentError', 'route.continue', 'url must be an absolute URL');
    if (new URL(options.url).protocol !== new URL(request.url()).protocol) throw failure('InvalidArgumentError', 'route.continue', 'New URL must have same protocol as overridden URL');
    if (options.url.length * 2 > maximumMetadataBytes) throw failure('ResourceLimitError', 'route.continue', 'route URL exceeds the supported allowance');
    overrides.url = options.url;
  }
  if (options.method !== undefined) {
    if (typeof options.method !== 'string' || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(options.method)) throw failure('InvalidArgumentError', 'route.continue', 'method must be an HTTP token');
    if (options.method.length > 128) throw failure('ResourceLimitError', 'route.continue', 'HTTP method exceeds the supported allowance');
    overrides.method = options.method;
  }
  if (options.headers !== undefined) { headerEntries(options.headers, 'route.continue'); overrides.headers = options.headers; }
  if (typeof options.postData === 'string' || Buffer.isBuffer(options.postData)) overrides.postDataBuffer = encodeBody(options.postData, 'route.continue');
  else if (options.postData) overrides.postDataBuffer = encodeBody(JSON.stringify(options.postData), 'route.continue');
  return overrides;
}

async function readBody(path: string): Promise<Buffer> {
  if (typeof path !== 'string' || !path || path.includes('\0')) throw failure('InvalidArgumentError', 'route.fulfill', 'path must be a nonempty file path');
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const information = await file.stat();
    if (!information.isFile()) throw failure('UnsupportedFeatureError', 'route.fulfill', 'only regular response-body files are supported');
    if (information.size > maximumBodyBytes) throw failure('ResourceLimitError', 'route.fulfill', 'route body exceeds 32 MiB');
    const chunks: Buffer[] = []; let bytes = 0;
    for await (const chunk of file.createReadStream({ autoClose: false, highWaterMark: 64 * 1024 })) {
      bytes += chunk.length;
      if (bytes > maximumBodyBytes) throw failure('ResourceLimitError', 'route.fulfill', 'route body exceeds 32 MiB');
      chunks.push(chunk as Buffer);
    }
    return chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks, bytes);
  } finally { await file.close(); }
}

/** One browser occurrence keeps one public Route while each callback has a separate handling scope. */
export class Route {
  static { instrumentTraceMethods(this.prototype, 'Route', route => tracePageOwner(route.page), { continue: { parameters: ['options'] }, fallback: { parameters: ['options'] }, fulfill: { parameters: ['options'] }, abort: { parameters: ['errorCode'] } }); }
  private handling: Handling | undefined;
  private previousHandling: Handling | undefined;
  private claimed = false;
  private targetClosed = false;
  private generation = 0;
  private resolveClosed!: () => void;
  private readonly closed = new Promise<void>(resolve => { this.resolveClosed = resolve; });
  private readonly closeListener = () => { this.targetClosed = true; this.resolveClosed(); this.detach(); };
  constructor(private readonly client: EngineClient, private readonly pageIdentifier: string, readonly page: Page, private readonly requestValue: Request, private readonly onFinished: () => void) {
    page.once('close', this.closeListener); page.once('crash', this.closeListener);
    if (page.isClosed()) this.closeListener();
  }
  request(): Request { return this.requestValue; }
  requestEnded(): void { this.closeListener(); }
  private detach(): void { this.page.off('close', this.closeListener); this.page.off('crash', this.closeListener); this.onFinished(); }
  private checkHandling(method: string): Handling {
    const current = invocation.getStore();
    if (!this.handling || this.claimed || current?.route === this && current.handling !== this.handling) throw new Error(`${method}: Route is already handled!`);
    return this.handling;
  }
  begin(registry: RouteRegistry, next: readonly RouteRegistry[]): Handling {
    let resolve!: (value: boolean) => void;
    const decision = new Promise<boolean>(settle => { resolve = settle; });
    return this.previousHandling = this.handling = { registry, next, decision, resolve, operationFailed: false, generation: this.generation };
  }
  async fallback(options: RouteContinueOptions = {}): Promise<void> {
    const handling = this.checkHandling('fallback');
    this.requestValue.applyOverrides(prepareRouteOverrides(options, this.requestValue));
    this.handling = undefined; handling.resolve(false);
  }
  async continue(options: RouteContinueOptions = {}): Promise<void> {
    const handling = this.checkHandling('continue');
    this.requestValue.applyOverrides(prepareRouteOverrides(options, this.requestValue));
    await this.finish('continue', handling, this.continueParameters());
  }
  async abort(errorCode = 'failed'): Promise<void> {
    const handling = this.checkHandling('abort');
    if (!['aborted', 'accessdenied', 'addressunreachable', 'blockedbyclient', 'blockedbyresponse', 'connectionaborted', 'connectionclosed', 'connectionfailed', 'connectionrefused', 'connectionreset', 'internetdisconnected', 'namenotresolved', 'timedout', 'failed'].includes(errorCode)) throw new Error(`Unknown error code: ${errorCode}`);
    await this.finish('abort', handling, { parameters: { reason: errorCode } });
  }
  async fulfill(options: RouteFulfillOptions = {}): Promise<void> {
    const handling = this.checkHandling('fulfill');
    validateOptions('route.fulfill', options, ['status', 'headers', 'contentType', 'body', 'json', 'path']);
    if (options.json !== undefined && options.body !== undefined) throw new Error('Can specify either body or json parameters');
    const status = options.status || 200;
    if (!Number.isInteger(status) || status < 100 || status > 599) throw failure('InvalidArgumentError', 'route.fulfill', 'status must be an integer between 100 and 599');
    let body = options.path ? await readBody(options.path) : encodeBody(options.json !== undefined ? JSON.stringify(options.json) : options.body ?? '', 'route.fulfill');
    body = checkBody(body, 'route.fulfill');
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(options.headers ?? {})) headers[name.toLowerCase()] = String(value);
    if (options.contentType) headers['content-type'] = String(options.contentType);
    else if (options.json) headers['content-type'] = 'application/json';
    else if (options.path) headers['content-type'] = fileMimeType(options.path);
    if (body.length && !('content-length' in headers)) headers['content-length'] = String(body.length);
    const origin = Object.entries(this.requestValue.metadata.headers).find(([name]) => name.toLowerCase() === 'origin')?.[1];
    const url = new URL(this.requestValue.metadata.url);
    if (origin && url.protocol.startsWith('http') && url.origin !== origin.trim() && !('access-control-allow-origin' in headers)) {
      headers['access-control-allow-origin'] = origin; headers['access-control-allow-credentials'] = 'true'; headers.vary = 'Origin';
    }
    const entries = Object.entries(headers).flatMap(([name, value]) => name === 'set-cookie' ? value.split('\n').flatMap(value => headerEntries({ [name]: value }, 'route.fulfill')) : headerEntries({ [name]: value }, 'route.fulfill'));
    if (entries.length > 4096 || entries.reduce((bytes, entry) => bytes + (entry.name.length + entry.value.length) * 2, 0) > maximumMetadataBytes) throw failure('ResourceLimitError', 'route.fulfill', 'response headers exceed the supported allowance');
    this.checkHandling('fulfill');
    await this.finish('fulfill', handling, { parameters: { status, statusText: responseStatusText(status), headers: entries }, body });
  }
  async fetch(): Promise<never> { throw failure('UnsupportedFeatureError', 'route.fetch', 'APIRequestContext-backed route fetching is not implemented'); }
  private continueParameters(isFallback = false): { parameters: Record<string, unknown>; body?: Buffer } {
    const overrides = this.requestValue.routeOverrides();
    const { postDataBuffer: body, headers, ...parameters } = overrides;
    return { parameters: { ...parameters, isFallback, ...(headers ? { headers: headerEntries(headers, 'route.continue') } : {}) }, ...(body !== undefined ? { body } : {}) };
  }
  private async finish(operation: 'continue' | 'fulfill' | 'abort', handling: Handling | undefined, prepared: { parameters: Record<string, unknown>; body?: Buffer }): Promise<void> {
    if (this.claimed) throw new Error(`${operation}: Route is already handled!`);
    this.claimed = true;
    try {
      if (!this.targetClosed) {
        const parameters = { page: this.pageIdentifier, identifier: this.requestValue.metadata.identifier, identity: this.requestValue.metadata.identity, ...prepared.parameters };
        const result = prepared.body === undefined ? this.client.request(`route.${operation}`, parameters) : this.client.requestWithInput(`route.${operation}`, parameters, [prepared.body]);
        await Promise.race([result, this.closed]);
      }
      if (this.handling === handling) this.handling = undefined;
      handling?.resolve(true);
    } catch (error) { if (handling) handling.operationFailed = true; throw error; }
    finally { this.detach(); }
  }
  bypass(registry: RouteRegistry): void {
    const handling = this.handling ?? this.previousHandling;
    if (this.claimed || this.targetClosed || handling?.registry !== registry) return;
    this.handling = undefined; handling.resolve(true); this.generation++;
    void this.dispatch(handling.next);
  }
  isCurrentHandling(handling: Handling): boolean { return this.previousHandling === handling && this.generation === handling.generation; }
  async dispatch(registries: readonly RouteRegistry[]): Promise<void> {
    const generation = this.generation;
    for (const [index, registry] of registries.entries()) {
      if (this.claimed || this.targetClosed || generation !== this.generation) return;
      const handled = await registry.dispatch(this, registries.slice(index + 1));
      if (handled || this.claimed || this.targetClosed || generation !== this.generation) return;
    }
    if (!this.claimed && !this.targetClosed && generation === this.generation) await this.finish('continue', undefined, this.continueParameters(true)).catch(() => {});
  }
}

interface Activation { handling: Handling; complete: Promise<void> }
class Handler {
  count = 0;
  ignoreErrors = false;
  readonly active = new Set<Activation>();
  readonly invoke: (route: Route, handling: Handling) => unknown;
  constructor(readonly matcher: URLMatcher, readonly callback: RouteHandler, readonly times: number) {
    this.invoke = AsyncResource.bind((route: Route, handling: Handling) => invocation.run({ route, handling }, () => runTraceUserCallback(() => callback(route, route.request()))));
  }
  async handle(route: Route, handling: Handling): Promise<boolean> {
    let finish!: () => void;
    const activation = { handling, complete: new Promise<void>(resolve => { finish = resolve; }) };
    this.active.add(activation); this.count++;
    try { const [handled] = await Promise.all([handling.decision, this.invoke(route, handling)]); return handled; }
    catch (error) { if (this.ignoreErrors) return false; throw error; }
    finally { finish(); this.active.delete(activation); }
  }
}

export class RouteRegistry {
  private handlers: Handler[] = [];
  private readonly active = new Set<Route>();
  private control = Promise.resolve();
  private closed = false;
  constructor(private readonly client: EngineClient, private readonly scope: 'page' | 'context', private readonly identifier: string, private readonly baseURL?: string) {}
  async route(matcher: URLMatcher, callback: RouteHandler, options: RouteOptions = {}): Promise<Disposable> {
    if (this.closed) throw failure('TargetClosedError', `${this.scope}.route`, 'route owner is closed');
    validateURLMatcher(matcher); validateOptions(`${this.scope}.route`, options, ['times']);
    if (typeof callback !== 'function') throw failure('InvalidArgumentError', `${this.scope}.route`, 'handler must be a function');
    if (options.times !== undefined && (!Number.isSafeInteger(options.times) || options.times < 1)) throw failure('InvalidArgumentError', `${this.scope}.route`, 'times must be a positive integer');
    const handler = new Handler(matcher, callback, options.times ?? Number.MAX_SAFE_INTEGER);
    this.handlers.unshift(handler);
    try { await this.synchronize(); }
    catch (error) { this.handlers = this.handlers.filter(entry => entry !== handler); await this.synchronize().catch(() => {}); throw error; }
    const dispose = () => this.unroute(matcher, callback);
    return { dispose, [Symbol.asyncDispose]: dispose };
  }
  async unroute(matcher: URLMatcher, callback?: RouteHandler): Promise<void> {
    validateURLMatcher(matcher);
    const removed = this.handlers.filter(handler => equalMatcher(handler.matcher, matcher) && (callback === undefined || callback === handler.callback));
    this.handlers = this.handlers.filter(handler => !removed.includes(handler));
    await this.remove(removed, 'default');
  }
  async unrouteAll(options: UnrouteAllOptions = {}): Promise<void> {
    validateOptions(`${this.scope}.unrouteAll`, options, ['behavior']);
    const behavior = options.behavior ?? 'default';
    if (!['default', 'wait', 'ignoreErrors'].includes(behavior)) throw failure('InvalidArgumentError', `${this.scope}.unrouteAll`, 'unknown behavior');
    const removed = this.handlers; this.handlers = [];
    await this.remove(removed, behavior);
  }
  private async remove(removed: Handler[], behavior: NonNullable<UnrouteAllOptions['behavior']>): Promise<void> {
    if (behavior === 'ignoreErrors') for (const handler of removed) handler.ignoreErrors = true;
    if (behavior === 'wait') await Promise.all(removed.flatMap(handler => [...handler.active].filter(activation => !activation.handling.operationFailed).map(activation => activation.complete)));
    await this.synchronize();
  }
  private synchronize(): Promise<void> {
    const enabled = this.handlers.length > 0;
    const result = this.control.catch(() => {}).then(async () => {
      if (this.closed) return;
      if (!enabled) for (const route of this.active) route.bypass(this);
      await this.client.request(`${this.scope}.route.setEnabled`, { [this.scope]: this.identifier, enabled });
    });
    this.control = result;
    return result;
  }
  async dispatch(route: Route, next: readonly RouteRegistry[]): Promise<boolean> {
    for (const handler of [...this.handlers]) {
      if (this.closed) return true;
      if (!matchesURL(route.request().url(), handler.matcher, this.baseURL) || !this.handlers.includes(handler)) continue;
      if (handler.count + 1 >= handler.times) this.handlers.splice(this.handlers.indexOf(handler), 1);
      const handling = route.begin(this, next);
      this.active.add(route);
      try {
        if (await handler.handle(route, handling) || !route.isCurrentHandling(handling)) return true;
      } finally {
        if (!this.handlers.length) void this.synchronize().catch(() => {});
      }
    }
    return false;
  }
  finished(route: Route): void { this.active.delete(route); }
  close(): void { this.closed = true; this.handlers = []; this.active.clear(); }
}
function equalMatcher(first: URLMatcher, second: URLMatcher): boolean {
  return first instanceof RegExp && second instanceof RegExp ? first.source === second.source && first.flags === second.flags : first === second;
}
