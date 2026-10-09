import type { Page } from './index.js';
import type { Frame } from './frame.js';
import type { RequestOverrides } from './routing.js';
import { instrumentTraceMethods, tracePageOwner } from './trace-hooks.js';
import type { EngineClient } from './client.js';
import { failure } from './errors.js';

export interface RequestReference { identifier: string; identity: string }
export interface RequestMetadata extends RequestReference {
  url: string; method: string; headers: Record<string, string>;
  redirectedFrom?: string | null;
  postDataEntries: string[] | null; resourceType: string; navigation: boolean; frame: string | null; loader: string;
}
export interface ResponseMetadata {
  identifier: string; url: string; status: number; statusText: string; headers: Record<string, string>;
  request: RequestReference; fromServiceWorker: boolean;
}

export interface Header { name: string; value: string }

function indexHeaders(entries: Header[]): Map<string, string[]> {
  const values = new Map<string, string[]>();
  for (const entry of entries) {
    const name = entry.name.toLowerCase();
    const previous = values.get(name);
    if (previous) previous.push(entry.value);
    else values.set(name, [entry.value]);
  }
  return values;
}

function headers(values: Map<string, string[]>): Record<string, string> {
  return Object.fromEntries([...values].map(([name, entries]) => [name, entries.join(name === 'set-cookie' ? '\n' : ', ')]));
}

function provisionalHeaders(values: Record<string, string>): Header[] {
  return Object.entries(values).flatMap(([name, value]) => String(value).split('\n').map(value => ({ name, value })));
}

/** Match the pinned header-array ownership while keeping indexed values independent of array mutation. */
class RawHeaders {
  private entries: Promise<{ array: Header[]; values: Map<string, string[]> }> | undefined;
  private retained = 0;
  constructor(private readonly client: EngineClient, private readonly page: string, private readonly identity: string, private readonly kind: 'request' | 'response', private readonly sizeChanged: () => void = () => {}) {}
  private read(): Promise<{ array: Header[]; values: Map<string, string[]> }> {
    return this.entries ??= this.client.request('network.headers', { page: this.page, requestIdentity: this.identity, kind: this.kind }).then(value => {
      if (!Array.isArray(value) || value.some(entry => !entry || typeof entry.name !== 'string' || typeof entry.value !== 'string')) {
        const error = failure('ProtocolError', 'network.headers', 'raw header entries are malformed');
        this.client.rejectProtocol(error);
        throw error;
      }
      const array = value as Header[];
      const values = indexHeaders(array);
      this.retained = array.reduce((bytes, entry) => bytes + 32 + (entry.name.length * 2 + entry.value.length) * 2, 0);
      this.sizeChanged();
      return { array, values };
    });
  }
  retainedBytes(): number { return this.retained; }
  async all(): Promise<Record<string, string>> { return headers((await this.read()).values); }
  async array(copyArray = false): Promise<Header[]> { const entries = (await this.read()).array; return copyArray ? entries.slice() : entries; }
  async value(name: string): Promise<string | null> {
    const values = await this.values(name);
    return values.length ? values.join(name.toLowerCase() === 'set-cookie' ? '\n' : ', ') : null;
  }
  async values(name: string): Promise<string[]> { return [...((await this.read()).values.get(name.toLowerCase()) ?? [])]; }
}

/** Decode the browser's byte entries in their original order without a text round trip. */
function requestPostData(entries: RequestMetadata['postDataEntries']): Buffer | null {
  if (entries === null) return null;
  if (!Array.isArray(entries) || entries.length === 0) throw failure('ProtocolError', 'request', 'request byte entries are malformed');
  const buffers = entries.map(entry => {
    if (typeof entry !== 'string' || entry.length === 0) throw failure('ProtocolError', 'request', 'request byte entry is malformed');
    const buffer = Buffer.from(entry, 'base64');
    if (buffer.toString('base64') !== entry) throw failure('ProtocolError', 'request', 'request byte entry is not canonical base64');
    return buffer;
  });
  return buffers.length === 1 ? buffers[0]! : Buffer.concat(buffers);
}

/** Public network metadata remains usable after its page closes. */
export class Request {
  private originalPostData: Buffer | null | undefined;
  private overrides: RequestOverrides = {};
  private successor: Request | null = null;
  private readonly metadataBytes: number;
  private readonly frameValue: Frame | null;
  private responseValue: Response | null = null;
  private failureText: string | null = null;
  private finished = false;
  private resolveResponse!: (response: Response | null) => void;
  private readonly responseReady = new Promise<Response | null>(resolve => { this.resolveResponse = resolve; });
  private readonly rawHeaders: RawHeaders;
  constructor(client: EngineClient, page: string, readonly metadata: RequestMetadata, owner?: Page, private readonly predecessor: Request | null = null, private readonly sizeChanged: () => void = () => {}) {
    this.rawHeaders = new RawHeaders(client, page, metadata.identity, 'request', sizeChanged);
    this.frameValue = owner?.frameByIdentifier(metadata.frame ?? '') ?? null;
    if (predecessor) predecessor.successor = this;
    this.metadataBytes = 256 + [metadata.identifier, metadata.identity, metadata.url, metadata.method, metadata.resourceType, metadata.frame ?? '', metadata.loader, ...Object.entries(metadata.headers).flat(), ...(metadata.postDataEntries ?? [])].reduce((bytes, text) => bytes + text.length * 2, 0);
  }
  url(): string { return this.overrides.url ?? this.metadata.url; }
  method(): string { return this.overrides.method ?? this.metadata.method; }
  private overrideHeaderEntries(): Header[] | undefined { return this.overrides.headers ? provisionalHeaders(Object.fromEntries(Object.entries(this.overrides.headers).filter((entry): entry is [string, string] => entry[1] !== undefined))) : undefined; }
  headers(): Record<string, string> { return headers(indexHeaders(this.overrideHeaderEntries() ?? provisionalHeaders(this.metadata.headers))); }
  allHeaders(): Promise<Record<string, string>> { const entries = this.overrideHeaderEntries(); return entries ? Promise.resolve(headers(indexHeaders(entries))) : this.rawHeaders.all(); }
  headersArray(): Promise<Header[]> { const entries = this.overrideHeaderEntries(); return entries ? Promise.resolve(entries) : this.rawHeaders.array(); }
  headerValue(name: string): Promise<string | null> { const entries = this.overrideHeaderEntries(); return entries ? Promise.resolve(headers(indexHeaders(entries))[name.toLowerCase()] ?? null) : this.rawHeaders.value(name); }
  applyOverrides(overrides: RequestOverrides): void { this.overrides = { ...this.overrides, ...overrides }; this.sizeChanged(); }
  routeOverrides(): RequestOverrides { return this.overrides; }
  refreshRetainedSize(): void { this.sizeChanged(); }
  retainedBytes(): number { return this.metadataBytes + this.rawHeaders.retainedBytes() + (this.responseValue?.retainedBytes() ?? 0) + (this.originalPostData?.byteLength ?? 0) + (this.overrides.postDataBuffer?.byteLength ?? 0) + (this.overrides.url?.length ?? 0) * 2 + (this.overrides.method?.length ?? 0) * 2 + Object.entries(this.overrides.headers ?? {}).reduce((bytes, [name, value]) => bytes + (name.length + (value?.length ?? 0)) * 2, 0); }
  frame(): Frame { if (!this.frameValue) throw failure('UnsupportedFeatureError', 'request.frame', 'request frame is not available'); return this.frameValue; }
  redirectedFrom(): Request | null { return this.predecessor; }
  redirectedTo(): Request | null { return this.successor; }
  serviceWorker(): null { return null; }
  postData(): string | null { return this.postDataBuffer()?.toString('utf8') || null; }
  /** Ordinary network observation allocates no decoded body until a caller asks for it. */
  postDataBuffer(): Buffer | null {
    if (this.overrides.postDataBuffer !== undefined) return this.overrides.postDataBuffer;
    if (this.originalPostData === undefined) { this.originalPostData = requestPostData(this.metadata.postDataEntries); this.sizeChanged(); }
    return this.originalPostData;
  }
  resourceType(): string { return this.metadata.resourceType.toLowerCase(); }
  isNavigationRequest(): boolean { return this.metadata.navigation; }
  async response(): Promise<Response | null> { return this.responseReady; }
  failure(): { errorText: string } | null { return this.failureText ? { errorText: this.failureText } : null; }
  didRespond(response: Response): void { this.responseValue = response; this.sizeChanged(); this.resolveResponse(response); }
  didFail(errorText: string): void { if (!this.finished) this.failureText = errorText; this.didFinish(); }
  didFinish(): void { this.finished = true; this.resolveResponse(this.responseValue); }
}

export class Response {
  static { instrumentTraceMethods(this.prototype, 'Response', response => tracePageOwner(response.owner), { body: {}, text: {}, json: {} }); }

  private readonly rawHeaders: RawHeaders;
  private readonly metadataBytes: number;
  constructor(private readonly client: EngineClient, private readonly pageIdentifier: string, private readonly metadata: ResponseMetadata, private readonly requestValue: Request, private readonly owner: Page) {
    this.rawHeaders = new RawHeaders(client, pageIdentifier, metadata.request.identity, 'response', () => requestValue.refreshRetainedSize());
    this.metadataBytes = 128 + [metadata.identifier, metadata.url, metadata.statusText, ...Object.entries(metadata.headers).flat()].reduce((bytes, text) => bytes + text.length * 2, 0);
  }
  retainedBytes(): number { return this.metadataBytes + this.rawHeaders.retainedBytes(); }
  url(): string { return this.metadata.url; }
  status(): number { return this.metadata.status; }
  statusText(): string { return this.metadata.statusText; }
  ok(): boolean { return this.status() === 0 || this.status() >= 200 && this.status() <= 299; }
  headers(): Record<string, string> { return headers(indexHeaders(provisionalHeaders(this.metadata.headers))); }
  allHeaders(): Promise<Record<string, string>> { return this.rawHeaders.all(); }
  headersArray(): Promise<Header[]> { return this.rawHeaders.array(true); }
  headerValue(name: string): Promise<string | null> { return this.rawHeaders.value(name); }
  headerValues(name: string): Promise<string[]> { return this.rawHeaders.values(name); }
  request(): Request { return this.requestValue; }
  fromServiceWorker(): boolean { return this.metadata.fromServiceWorker ?? false; }
  async body(): Promise<Buffer> {
    if (this.status() >= 300 && this.status() < 400 && this.headers().location) throw failure('ProtocolError', 'response.body', 'response body is unavailable for redirect responses');
    return this.client.requestBinary('response.body', { page: this.pageIdentifier, request: this.metadata.identifier, requestIdentity: this.metadata.request.identity });
  }
  async text(): Promise<string> { return (await this.body()).toString('utf8'); }
  async json(): Promise<any> { return JSON.parse(await this.text()); }
}
