import { randomBytes } from 'node:crypto';
import { closeSync, constants, createReadStream, fstatSync, openSync, ReadStream, statSync } from 'node:fs';
import { finished } from 'node:stream/promises';
import { types } from 'node:util';
import { validateHeaderName, validateHeaderValue } from 'node:http';
import { basename } from 'node:path';
import { performance } from 'node:perf_hooks';
import { EngineClient, retainEngine } from './client.js';
import { failure } from './errors.js';
import { fileMimeType } from './file-mime-types.js';
import { writeAtomicFile } from './files.js';
import { decodeStorageState, prepareCookies, type StorageState, type StorageStateOptions, type WireStorageState } from './storage.js';
import { validateBoolean, validateOptions } from './validation.js';

const maximumBodyBytes = 32 * 1024 * 1024;
const maximumMetadataBytes = 1024 * 1024;
const maximumStateBytes = 7 * 1024 * 1024;
const maximumFields = 4096;

export interface APIRequestContextOptions {
  baseURL?: string;
  extraHTTPHeaders?: Record<string, string>;
  userAgent?: string;
  timeout?: number;
  ignoreHTTPSErrors?: boolean;
  httpCredentials?: { username: string; password: string; origin?: string; send?: 'unauthorized' | 'always' };
  storageState?: StorageState | string;
  maxRedirects?: number;
  failOnStatusCode?: boolean;
  proxy?: { server: string; bypass?: string; username?: string; password?: string };
  clientCertificates?: ReadonlyArray<{ origin: string; certPath?: string; keyPath?: string; pfxPath?: string; cert?: Buffer; key?: Buffer; pfx?: Buffer; passphrase?: string }>;
}
export interface APIRequestFilePayload { name: string; mimeType: string; buffer: Buffer }
export interface APIRequestOptions {
  method?: string;
  headers?: Record<string, string>;
  params?: Record<string, string | number | boolean> | URLSearchParams | string;
  data?: string | Buffer | object | number | boolean | null;
  form?: Record<string, string | number | boolean> | FormData;
  multipart?: Record<string, string | number | boolean | ReadStream | APIRequestFilePayload> | FormData;
  timeout?: number;
  maxRedirects?: number;
  maxRetries?: number;
  failOnStatusCode?: boolean;
  ignoreHTTPSErrors?: boolean;
}
export interface APIRequestHeader { name: string; value: string }
interface ContextDefaults { baseURL: string | undefined; timeout: number; maxRedirects: number; failOnStatusCode: boolean; hasContentType: boolean }
interface ResponseMetadata {
  identifier: string;
  context: string;
  url: string;
  status: number;
  statusText: string;
  headers: APIRequestHeader[];
  bodyLength: number;
}
interface MultipartPart { header: string; size: number; source: string | Buffer | Blob | ReadStream }

const maximumPreparedBytes = 64 * 1024 * 1024;
const maximumPreparations = 128;
const maximumStreamScratchBytes = 1024 * 1024;
let activePreparations = 0;
let preparedBytes = 0;

/** Credits bound payload and stream scratch custody; encoding and transport copies have separately bounded overhead. */
class RequestPreparation {
  private payloadBytes = 0;
  private scratchBytes = 0;
  private released = false;
  private retiring = false;
  private trackedWork = 0;
  constructor(private readonly method: string, readonly signal: AbortSignal | undefined = undefined) {
    if (activePreparations >= maximumPreparations) throw failure('ResourceLimitError', method, 'host request preparation exceeds 128 active operations');
    activePreparations++;
  }
  check(deadline: number): void {
    if (this.signal?.aborted) throw this.signal.reason;
    remainingTime(deadline, this.method);
  }
  /** A caller can stop waiting while the original preparation retains every credit through cleanup. */
  async wait<Value>(work: Promise<Value>, deadline: number): Promise<Value> {
    this.trackedWork++;
    const tracked = work.finally(() => {
      this.trackedWork--;
      if (this.retiring) this.release();
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let aborted: (() => void) | undefined;
    try {
      this.check(deadline);
      const interrupted = new Promise<never>((_, reject) => {
        if (deadline !== Infinity) timer = setTimeout(() => reject(failure('TimeoutError', this.method, 'deadline exceeded during request preparation')), remainingTime(deadline, this.method));
        if (this.signal) {
          aborted = () => reject(this.signal!.reason);
          this.signal.addEventListener('abort', aborted, { once: true });
        }
      });
      return await Promise.race([tracked, interrupted]);
    } finally {
      clearTimeout(timer);
      if (aborted) this.signal?.removeEventListener('abort', aborted);
      // Also observe work when check() throws before the race is installed.
      void tracked.catch(() => {});
    }
  }
  reservePayload(bytes: number): void {
    boundedLength(this.payloadBytes + bytes, this.method);
    this.reserve(bytes);
    this.payloadBytes += bytes;
  }
  reserveScratch(bytes: number): void {
    boundedLength(bytes, this.method, maximumStreamScratchBytes);
    if (bytes <= this.scratchBytes) return;
    this.reserve(bytes - this.scratchBytes);
    this.scratchBytes = bytes;
  }
  private reserve(bytes: number): void {
    if (preparedBytes + bytes > maximumPreparedBytes) throw failure('ResourceLimitError', this.method, 'host prepared payload and stream scratch exceed 64 MiB');
    preparedBytes += bytes;
  }
  release(): void {
    if (this.released) return;
    this.retiring = true;
    if (this.trackedWork) return;
    this.released = true;
    preparedBytes -= this.payloadBytes + this.scratchBytes;
    activePreparations--;
  }
}
function* ownEntries(value: Record<string, unknown>): Generator<[string, unknown]> {
  for (const name in value) if (Object.hasOwn(value, name)) yield [name, value[name]];
}
function quotedJSONBytes(value: string, deadline: number, method: string): number {
  let bytes = 2;
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit === 34 || unit === 92 || unit === 8 || unit === 9 || unit === 10 || unit === 12 || unit === 13) bytes += 2;
    else if (unit < 32) bytes += 6;
    else if (unit < 128) bytes++;
    else if (unit < 2048) bytes += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff && value.charCodeAt(index + 1) >= 0xdc00 && value.charCodeAt(index + 1) <= 0xdfff) { bytes += 4; index++; }
    else if (unit >= 0xd800 && unit <= 0xdfff) bytes += 6;
    else bytes += 3;
    boundedLength(bytes, method);
    if (index % 1024 === 0) remainingTime(deadline, method);
  }
  return bytes;
}

/** Charge escaped output before JSON.stringify grows its result, preserving its getter and toJSON evaluation order. */
function boundedJSON(value: unknown, preparation: RequestPreparation, deadline: number, method: string, maximumBytes = maximumBodyBytes): string {
  const ancestors: object[] = [];
  const members = new WeakMap<object, number>();
  let first = true;
  let nodes = 0;
  let serializedBytes = 0;
  const serialized = JSON.stringify(value, function (this: object, key: string, item: unknown): unknown {
    if (++nodes > 100000) throw failure('ResourceLimitError', method, 'JSON preparation exceeds 100000 values');
    remainingTime(deadline, method);
    while (ancestors.length && ancestors.at(-1) !== this) ancestors.pop();
    if (ancestors.length >= 128) throw failure('ResourceLimitError', method, 'JSON preparation exceeds 128 levels');
    if (types.isStringObject(item)) item = String(item);
    else if (types.isNumberObject(item)) item = Number(item);
    else if (types.isBooleanObject(item)) item = Boolean.prototype.valueOf.call(item);
    else if (types.isBigIntObject(item)) throw failure('InvalidArgumentError', method, 'BigInt data is not JSON serializable');
    const root = first;
    first = false;
    const arrayMember = Array.isArray(this);
    if (item === undefined || typeof item === 'function' || typeof item === 'symbol') {
      if (!arrayMember) return undefined;
      item = null;
    }
    let bytes = 0;
    if (!root) {
      const count = members.get(this) ?? 0;
      members.set(this, count + 1);
      if (count) bytes++;
      if (!arrayMember) bytes += quotedJSONBytes(key, deadline, method) + 1;
    }
    if (typeof item === 'string') bytes += quotedJSONBytes(item, deadline, method);
    else if (typeof item === 'number') bytes += Number.isFinite(item) ? String(item).length : 4;
    else if (typeof item === 'boolean') bytes += item ? 4 : 5;
    else if (item === null) bytes += 4;
    else if (typeof item === 'bigint') throw failure('InvalidArgumentError', method, 'BigInt data is not JSON serializable');
    else if (typeof item === 'object') {
      if ('isRawJSON' in JSON && typeof JSON.isRawJSON === 'function' && JSON.isRawJSON(item)) {
        const raw = record(item, method).rawJSON;
        requireString(raw, method);
        bytes += Buffer.byteLength(raw);
      } else {
        bytes += 2;
        members.set(item, 0);
        ancestors.push(item);
      }
    }
    serializedBytes += bytes;
    boundedLength(serializedBytes, method, maximumBytes);
    preparation.reservePayload(bytes);
    return item;
  });
  if (serialized === undefined) throw failure('InvalidArgumentError', method, 'data is not JSON serializable');
  return serialized;
}
function encodedFormBytes(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const point = character.codePointAt(0)!;
    if (point === 32 || (point >= 48 && point <= 57) || (point >= 65 && point <= 90) || (point >= 97 && point <= 122) || point === 42 || point === 45 || point === 46 || point === 95) bytes++;
    else bytes += point < 128 ? 3 : point < 2048 ? 6 : point > 65535 ? 12 : 9;
  }
  return bytes;
}

function requireString(value: unknown, method: string): asserts value is string {
  if (typeof value !== 'string') throw failure('InvalidArgumentError', method, 'expected a string');
}
function record(value: unknown, method: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw failure('InvalidArgumentError', method, 'expected an object');
  return value as Record<string, unknown>;
}
function timeoutValue(value: unknown, method: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw failure('InvalidArgumentError', method, 'timeout must be a finite nonnegative number');
  return value;
}
function unsignedInteger(value: unknown, method: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 4294967295) throw failure('InvalidArgumentError', method, 'expected an integer between 0 and 4294967295');
  return value;
}
function deadlineFor(timeout: number, started: number): number { return timeout === 0 ? Infinity : started + timeout; }
function remainingTime(deadline: number, method: string): number {
  if (deadline === Infinity) return 0;
  const remaining = deadline - performance.now();
  if (remaining <= 0) throw failure('TimeoutError', method, 'deadline exceeded during request preparation');
  return remaining;
}
function boundedLength(length: number, method: string, maximum = maximumBodyBytes): void {
  if (!Number.isSafeInteger(length) || length < 0 || length > maximum) throw failure('ResourceLimitError', method, `prepared payload exceeds ${maximum} bytes`);
}
function bodyString(value: string, method: string): Buffer {
  boundedLength(Buffer.byteLength(value), method);
  return Buffer.from(value);
}
function primitiveString(value: unknown, method: string): string {
  if (!['string', 'number', 'boolean'].includes(typeof value)) throw failure('InvalidArgumentError', method, 'expected a string, number or boolean');
  return String(value);
}
function headers(value: unknown, method: string): APIRequestHeader[] {
  if (value === undefined) return [];
  const values = record(value, method);
  const result: APIRequestHeader[] = [];
  let bytes = 0;
  let fields = 0;
  for (const [name, value] of ownEntries(values)) {
    if (++fields > maximumFields) throw failure('ResourceLimitError', method, 'too many headers');
    if (value === undefined) continue;
    requireString(value, `${method}.${name}`);
    try { validateHeaderName(name); validateHeaderValue(name, value); }
    catch { throw failure('InvalidArgumentError', method, `invalid HTTP header ${name}`); }
    bytes += Buffer.byteLength(name) + Buffer.byteLength(value);
    boundedLength(bytes, method, maximumMetadataBytes);
    if (result.length === maximumFields) throw failure('ResourceLimitError', method, 'too many headers');
    result.push({ name, value });
  }
  return result;
}
function defaultContentType(values: APIRequestHeader[], value: string, contextHasContentType: boolean): void {
  if (!contextHasContentType && !values.some(header => header.name.toLowerCase() === 'content-type')) values.push({ name: 'content-type', value });
}
function requestURL(input: string | object, params: APIRequestOptions['params'], baseURL: string | undefined, method: string): string {
  if (typeof input !== 'string') {
    if (input && typeof input === 'object') throw failure('UnsupportedFeatureError', `${method}.Request`, 'fetch(Request) is not implemented; pass a URL string');
    throw failure('InvalidArgumentError', method, 'expected a URL string');
  }
  boundedLength(Buffer.byteLength(input), method, maximumMetadataBytes);
  if (baseURL !== undefined) boundedLength(Buffer.byteLength(baseURL), method, maximumMetadataBytes);
  let url: URL;
  try { url = new URL(input, baseURL); }
  catch { throw failure('InvalidArgumentError', method, 'invalid URL or missing baseURL for a relative URL'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw failure('UnsupportedFeatureError', method, 'only HTTP and HTTPS requests are implemented');
  if (typeof params === 'string' || params instanceof URLSearchParams) {
    if (params instanceof URLSearchParams) {
      let queryBytes = 0;
      let fields = 0;
      for (const [name, value] of params) {
        if (++fields > maximumFields) throw failure('ResourceLimitError', method, 'too many query parameters');
        queryBytes += encodedFormBytes(name) + encodedFormBytes(value) + 1 + (fields > 1 ? 1 : 0);
        boundedLength(queryBytes, method, maximumMetadataBytes);
      }
    }
    const encoded = params.toString();
    boundedLength(Buffer.byteLength(encoded), method, maximumMetadataBytes);
    if (encoded) url.search = encoded;
  }
  else if (params !== undefined) {
    const values = record(params, `${method}.params`);
    let count = 0;
    let queryBytes = Buffer.byteLength(url.search);
    for (const [name, value] of ownEntries(values)) {
      if (++count > maximumFields) throw failure('ResourceLimitError', `${method}.params`, 'too many query parameters');
      if (value === undefined) continue;
      const text = primitiveString(value, `${method}.params.${name}`);
      queryBytes += encodedFormBytes(name) + encodedFormBytes(text) + 2;
      boundedLength(queryBytes, method, maximumMetadataBytes);
      url.searchParams.append(name, text);
    }
  }
  boundedLength(Buffer.byteLength(url.href), method, maximumMetadataBytes);
  return url.href;
}
function formEntries(value: APIRequestOptions['form'], method: string): Array<[string, string]> {
  const result: Array<[string, string]> = [];
  const entries = typeof FormData !== 'undefined' && value instanceof FormData ? value.entries() : ownEntries(record(value, method));
  let bytes = 0;
  let fields = 0;
  for (const [name, value] of entries) {
    if (++fields > maximumFields) throw failure('ResourceLimitError', method, 'too many form fields');
    if (value === undefined) continue;
    const text = primitiveString(value, `${method}.${name}`);
    bytes += Buffer.byteLength(name) + Buffer.byteLength(text);
    boundedLength(bytes, method);
    if (result.length === maximumFields) throw failure('ResourceLimitError', method, 'too many form fields');
    result.push([name, text]);
  }
  return result;
}

/** Await consumed stream work, including destruction; preflight requires stream ownership that permits descriptor closure. */
async function consumeStream(stream: ReadStream, maximumBytes: number, deadline: number, method: string, signal?: AbortSignal): Promise<Buffer> {
  if (signal?.aborted) throw signal.reason;
  const remaining = remainingTime(deadline, method);
  const aborted = () => stream.destroy(signal!.reason instanceof Error ? signal!.reason : failure('TargetClosedError', method, 'request preparation owner was disposed'));
  signal?.addEventListener('abort', aborted, { once: true });
  const settlement = finished(stream, { cleanup: true }).then(() => undefined, error => error as unknown);
  const timer = remaining === 0 ? undefined : setTimeout(() => stream.destroy(failure('TimeoutError', method, 'deadline exceeded reading request input')), remaining);
  const chunks: Buffer[] = [];
  let length = 0;
  let failed = false;
  try {
    for await (const chunk of stream) {
      remainingTime(deadline, method);
      if (!Buffer.isBuffer(chunk)) throw failure('InvalidArgumentError', method, 'file stream must yield binary buffers');
      if (chunk.length > stream.readableHighWaterMark) throw failure('ResourceLimitError', method, 'file stream exceeded its declared scratch allowance');
      boundedLength(length + chunk.length, method, maximumBytes);
      chunks.push(chunk);
      length += chunk.length;
    }
    remainingTime(deadline, method);
    return Buffer.concat(chunks, length);
  } catch (error) {
    failed = true;
    stream.destroy();
    throw error;
  } finally {
    clearTimeout(timer);
    const cleanupError = await settlement;
    signal?.removeEventListener('abort', aborted);
    if (!failed && cleanupError !== undefined) throw cleanupError;
  }
}
function streamScratchBytes(stream: ReadStream, method: string): number {
  const bytes = stream.readableHighWaterMark;
  if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > maximumStreamScratchBytes) throw failure('UnsupportedFeatureError', method, 'file stream highWaterMark must be between 1 byte and 1 MiB');
  return bytes;
}
function streamSize(stream: ReadStream, method: string): number {
  if ('autoClose' in stream && stream.autoClose === false) throw failure('UnsupportedFeatureError', method, 'multipart requires autoClose:true to safely cancel consumed input; borrowed file descriptors are not implemented');
  if (typeof stream.path !== 'string' && !Buffer.isBuffer(stream.path)) throw failure('UnsupportedFeatureError', method, 'multipart file streams require a named local file path');
  if (stream.readableFlowing || stream.bytesRead || stream.readableEnded || stream.destroyed || stream.readableEncoding) throw failure('UnsupportedFeatureError', method, 'multipart requires an unread binary file stream');
  streamScratchBytes(stream, method);
  const fileDescriptor = 'fd' in stream && typeof stream.fd === 'number' ? stream.fd : undefined;
  const information = fileDescriptor === undefined ? statSync(stream.path) : fstatSync(fileDescriptor);
  if (!information.isFile()) throw failure('UnsupportedFeatureError', method, 'multipart requires a regular file stream');
  const start = 'start' in stream && typeof stream.start === 'number' ? stream.start : 0;
  const requestedEnd = 'end' in stream && typeof stream.end === 'number' ? stream.end : Infinity;
  const end = Math.min(requestedEnd, information.size - 1);
  return Math.max(0, end - start + 1);
}

/** Inventory the whole multipart body before allocating bytes or consuming any caller-owned file. */
async function multipartBody(value: APIRequestOptions['multipart'], values: APIRequestHeader[], contextHasContentType: boolean, deadline: number, method: string, preparation: RequestPreparation): Promise<Buffer> {
  const boundary = `----WebKitFormBoundary${randomBytes(12).toString('hex')}`;
  const parts: MultipartPart[] = [];
  const entries = typeof FormData !== 'undefined' && value instanceof FormData ? value.entries() : ownEntries(record(value, `${method}.multipart`));
  let length = Buffer.byteLength(`--${boundary}--\r\n`);
  let fields = 0;
  let scratchBytes = 0;
  for (const [name, value] of entries) {
    if (++fields > maximumFields) throw failure('ResourceLimitError', method, 'too many multipart fields');
    let source: MultipartPart['source'];
    let size: number;
    let fileName: string | undefined;
    let mimeType: string | undefined;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      source = String(value);
      if (!source) continue;
      size = Buffer.byteLength(source);
    } else if (typeof Blob !== 'undefined' && value instanceof Blob) {
      if (!('name' in value) || typeof value.name !== 'string') throw failure('InvalidArgumentError', method, 'multipart Blob requires a file name');
      source = value;
      size = value.size;
      fileName = value.name;
      mimeType = value.type || fileMimeType(fileName);
    } else if (value instanceof ReadStream) {
      source = value;
      size = streamSize(value, method);
      scratchBytes = Math.max(scratchBytes, streamScratchBytes(value, method));
      fileName = basename(Buffer.isBuffer(value.path) ? value.path.toString() : value.path);
      mimeType = fileMimeType(fileName);
    } else {
      const payload = record(value, `${method}.multipart.${name}`);
      validateOptions(`${method}.multipart.${name}`, payload, ['name', 'mimeType', 'buffer']);
      requireString(payload.name, `${method}.multipart.${name}.name`);
      requireString(payload.mimeType, `${method}.multipart.${name}.mimeType`);
      if (!Buffer.isBuffer(payload.buffer)) throw failure('InvalidArgumentError', method, 'multipart file payload requires a Buffer');
      source = payload.buffer;
      size = source.length;
      fileName = payload.name;
      mimeType = payload.mimeType || fileMimeType(fileName);
    }
    const prefix = `--${boundary}\r\ncontent-disposition: form-data; name="`;
    let headerBytes = Buffer.byteLength(prefix) + Buffer.byteLength(name) + 1 + 4;
    if (fileName !== undefined) headerBytes += Buffer.byteLength('; filename="') + Buffer.byteLength(fileName) + 1 + Buffer.byteLength('\r\ncontent-type: ') + Buffer.byteLength(mimeType!);
    boundedLength(length + headerBytes + size + 2, method);
    let header = prefix + name + '"';
    if (fileName !== undefined) header += `; filename="${fileName}"\r\ncontent-type: ${mimeType}`;
    header += '\r\n\r\n';
    length += headerBytes + size + 2;
    parts.push({ header, source, size });
    preparation.check(deadline);
  }
  preparation.reservePayload(length);
  preparation.reserveScratch(scratchBytes);
  // Snapshot every view together before the first await so caller mutation cannot affect later parts.
  for (const part of parts) if (Buffer.isBuffer(part.source)) part.source = Buffer.from(part.source);
  const chunks: Buffer[] = [];
  for (const part of parts) {
    preparation.check(deadline);
    chunks.push(Buffer.from(part.header));
    if (typeof part.source === 'string') chunks.push(Buffer.from(part.source));
    else if (Buffer.isBuffer(part.source)) chunks.push(part.source);
    else if (part.source instanceof ReadStream) chunks.push(await consumeStream(part.source, part.size, deadline, method, preparation.signal));
    else {
      const bytes = Buffer.from(await Blob.prototype.arrayBuffer.call(part.source));
      if (bytes.length !== part.size) throw failure('InvalidArgumentError', method, 'multipart file size changed during preparation');
      chunks.push(bytes);
    }
    chunks.push(Buffer.from('\r\n'));
  }
  preparation.check(deadline);
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  defaultContentType(values, `multipart/form-data; boundary=${boundary}`, contextHasContentType);
  return Buffer.concat(chunks);
}
async function prepareBody(options: APIRequestOptions, values: APIRequestHeader[], contextHasContentType: boolean, deadline: number, method: string, preparation: RequestPreparation): Promise<Buffer | undefined> {
  if ([options.data, options.form, options.multipart].filter(value => value !== undefined).length > 1) throw failure('InvalidArgumentError', method, "only one of 'data', 'form' or 'multipart' can be specified");
  if (options.data !== undefined) {
    const data = options.data;
    if (Buffer.isBuffer(data)) {
      preparation.reservePayload(data.length);
      defaultContentType(values, 'application/octet-stream', contextHasContentType);
      return Buffer.from(data);
    }
    if (typeof data === 'string' && !values.some(header => header.name.toLowerCase() === 'content-type' && header.value === 'application/json')) {
      preparation.reservePayload(Buffer.byteLength(data));
      defaultContentType(values, 'application/octet-stream', contextHasContentType);
      return bodyString(data, method);
    }
    if (!['string', 'object', 'number', 'boolean'].includes(typeof data)) throw failure('InvalidArgumentError', method, 'unsupported data value type');
    let serialized: string;
    try {
      if (typeof data === 'string') {
        boundedLength(Buffer.byteLength(data), method);
        let validJSON = false;
        try { JSON.parse(data); validJSON = true; } catch {}
        if (validJSON) { preparation.reservePayload(Buffer.byteLength(data)); serialized = data; }
        else serialized = boundedJSON(data, preparation, deadline, method);
      } else serialized = boundedJSON(data, preparation, deadline, method);
    } catch (error) {
      if (error instanceof Error && ['ResourceLimitError', 'TimeoutError', 'InvalidArgumentError'].includes(error.name)) throw error;
      throw failure('InvalidArgumentError', method, 'data is not JSON serializable');
    }
    defaultContentType(values, 'application/json', contextHasContentType);
    return bodyString(serialized, method);
  }
  if (options.form !== undefined) {
    const entries = formEntries(options.form, `${method}.form`);
    const length = entries.reduce((total, [name, value]) => total + encodedFormBytes(name) + encodedFormBytes(value) + 1, Math.max(0, entries.length - 1));
    preparation.reservePayload(length);
    const encoded = new URLSearchParams(entries).toString();
    defaultContentType(values, 'application/x-www-form-urlencoded', contextHasContentType);
    return bodyString(encoded, method);
  }
  if (options.multipart !== undefined) return multipartBody(options.multipart, values, contextHasContentType, deadline, method, preparation);
  return undefined;
}

/** Open the actual file nonblocking before validating its type, eliminating pathname replacement with a FIFO. */
async function readStorageFile(path: string, deadline: number, preparation: RequestPreparation): Promise<Buffer> {
  const method = 'request.newContext.storageState';
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  let stream: ReadStream | undefined;
  let settlement: Promise<unknown> | undefined;
  try {
    const information = fstatSync(descriptor);
    if (!information.isFile()) throw failure('InvalidArgumentError', method, 'storage state path must name a regular file');
    boundedLength(information.size, method, maximumStateBytes);
    preparation.reservePayload(information.size);
    preparation.reserveScratch(64 * 1024);
    remainingTime(deadline, method);
    stream = createReadStream(path, { fd: descriptor, autoClose: true, highWaterMark: 64 * 1024 });
    settlement = finished(stream, { cleanup: true }).then(() => undefined, error => error as unknown);
    return await consumeStream(stream, information.size, deadline, method);
  } finally {
    if (!stream) closeSync(descriptor);
    else { stream.destroy(); await settlement; }
  }
}

/** Public string state is encoded as UTF-16 units on the shared native storage boundary. */
async function storageInput(input: StorageState | string, deadline: number, preparation: RequestPreparation): Promise<WireStorageState> {
  const method = 'request.newContext.storageState';
  let value: unknown = input;
  if (typeof input === 'string') {
    const bytes = await readStorageFile(input, deadline, preparation);
    try { value = JSON.parse(bytes.toString('utf8')); }
    catch { throw failure('InvalidArgumentError', method, 'storage state file contains invalid JSON'); }
  }
  const state = record(value, method);
  validateOptions(method, state, ['cookies', 'origins']);
  const cookieSources = state.cookies ?? [];
  if (!Array.isArray(cookieSources)) throw failure('InvalidArgumentError', method, 'cookies must be an array');
  if (cookieSources.length > maximumFields) throw failure('ResourceLimitError', method, 'storage state exceeds 4096 cookies');
  const cookieFields = ['name', 'value', 'url', 'domain', 'path', 'expires', 'httpOnly', 'secure', 'sameSite', 'partitionKey', '_crHasCrossSiteAncestor'];
  const cookieInventory: Array<Array<[string, unknown]>> = [];
  let metadataBytes = 0;
  for (const cookie of cookieSources) {
    const fields: Array<[string, unknown]> = [];
    for (const [name, value] of ownEntries(record(cookie, `${method}.cookies`))) {
      if (!cookieFields.includes(name)) throw failure('UnsupportedFeatureError', `${method}.cookies.${name}`, 'cookie field is not implemented');
      if (typeof value === 'string') metadataBytes += Buffer.byteLength(value);
      boundedLength(metadataBytes, method, maximumStateBytes);
      fields.push([name, value]);
    }
    cookieInventory.push(fields);
  }
  preparation.reservePayload(metadataBytes);
  const cookies = prepareCookies(cookieInventory.map(fields => Object.fromEntries(fields)), `${method}.cookies`);
  if (state.origins !== undefined && !Array.isArray(state.origins)) throw failure('InvalidArgumentError', method, 'origins must be an array');
  const originValues = state.origins as unknown[] | undefined ?? [];
  if (originValues.length > 1024) throw failure('ResourceLimitError', method, 'storage state exceeds 1024 origins');
  let codeUnits = 0;
  let storageEntries = 0;
  const origins = originValues.map(value => {
    const origin = record(value, method);
    validateOptions(method, origin, ['origin', 'localStorage']);
    requireString(origin.origin, `${method}.origin`);
    const originBytes = Buffer.byteLength(origin.origin);
    metadataBytes += originBytes;
    boundedLength(metadataBytes, method, maximumStateBytes);
    preparation.reservePayload(originBytes);
    let url: URL;
    try { url = new URL(origin.origin); } catch { throw failure('InvalidArgumentError', method, 'invalid storage origin'); }
    if (!['http:', 'https:'].includes(url.protocol)) throw failure('UnsupportedFeatureError', method, 'only HTTP and HTTPS origin storage is implemented');
    if (!Array.isArray(origin.localStorage)) throw failure('InvalidArgumentError', method, 'localStorage must be an array');
    storageEntries += origin.localStorage.length;
    if (storageEntries > 100000) throw failure('ResourceLimitError', method, 'storage state exceeds 100000 localStorage entries');
    const localStorage = Array.from(origin.localStorage, value => {
      const entry = record(value, method);
      validateOptions(method, entry, ['name', 'value']);
      requireString(entry.name, `${method}.name`);
      requireString(entry.value, `${method}.value`);
      codeUnits += entry.name.length + entry.value.length + 2;
      if (codeUnits > 100000) throw failure('ResourceLimitError', method, 'storage state exceeds 100000 localStorage code units');
      const name = entry.name;
      const entryValue = entry.value;
      return { name: Array.from({ length: name.length }, (_, index) => name.charCodeAt(index)), value: Array.from({ length: entryValue.length }, (_, index) => entryValue.charCodeAt(index)) };
    });
    return { origin: url.origin, localStorage };
  });
  const prepared = { cookies, origins };
  boundedJSON(prepared, preparation, deadline, method, maximumStateBytes);
  remainingTime(deadline, method);
  return prepared;
}
function responseMetadata(value: unknown, owner: string, client: EngineClient): ResponseMetadata {
  const method = 'apiRequest.fetch';
  const invalid = (): never => {
    const error = failure('ProtocolError', method, 'native response omitted valid original owner or metadata');
    client.rejectProtocol(error);
    throw error;
  };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  const response = value as Record<string, unknown>;
  if (typeof response.identifier !== 'string' || !response.identifier || response.context !== owner || typeof response.url !== 'string' || typeof response.status !== 'number' || !Number.isInteger(response.status) || response.status < 100 || response.status > 999 || typeof response.statusText !== 'string' || !Array.isArray(response.headers) || typeof response.bodyLength !== 'number' || !Number.isSafeInteger(response.bodyLength) || response.bodyLength < 0 || response.bodyLength > maximumBodyBytes) return invalid();
  if (response.headers.some(value => !value || typeof value !== 'object' || typeof value.name !== 'string' || typeof value.value !== 'string')) return invalid();
  return response as unknown as ResponseMetadata;
}

class UnsupportedRequestTracing {
  async start(_options?: object): Promise<never> { return this.unsupported('start'); }
  async startChunk(_options?: object): Promise<never> { return this.unsupported('startChunk'); }
  async stopChunk(_options?: object): Promise<never> { return this.unsupported('stopChunk'); }
  async stop(_options?: object): Promise<never> { return this.unsupported('stop'); }
  async group(_name: string, _options?: object): Promise<never> { return this.unsupported('group'); }
  async groupEnd(): Promise<never> { return this.unsupported('groupEnd'); }
  private unsupported(method: string): never { throw failure('UnsupportedFeatureError', `APIRequestContext.tracing.${method}`, 'standalone request tracing is not implemented'); }
}

/** One native standalone cookie jar and response owner, retaining its implicit engine exactly once. */
export class APIRequestContext {
  readonly tracing = new UnsupportedRequestTracing();
  private closed = false;
  private closeReason: string | undefined;
  private released = false;
  private unsubscribe: (() => void) | undefined;
  private disposal: Promise<void> | undefined;
  private readonly responses = new Set<APIResponse>();
  private readonly preparationAborted = new AbortController();
  constructor(private readonly client: EngineClient, readonly identifier: string, private readonly defaults: ContextDefaults) {
    this.unsubscribe = client.subscribeObject(identifier, event => {
      if (event.event === 'transportclosed') {
        this.closeLocally();
        void this.release().catch(() => {});
      }
    });
  }
  assertLive(method: string): void {
    if (this.closed || this.client.isClosed()) throw failure('TargetClosedError', method, this.closeReason ?? 'API request context has been disposed');
  }
  private closeLocally(): void {
    this.closed = true;
    this.preparationAborted.abort(failure('TargetClosedError', 'APIRequestContext.fetch', this.closeReason ?? 'API request context has been disposed'));
    for (const response of this.responses) response.ownerClosed();
    this.responses.clear();
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }
  private async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    await this.client.release();
  }
  forgetResponse(response: APIResponse): void { this.responses.delete(response); }
  async fetch(urlOrRequest: string | object, options: APIRequestOptions = {}): Promise<APIResponse> {
    return this.performFetch(urlOrRequest, options, undefined);
  }
  async get(url: string, options: APIRequestOptions = {}): Promise<APIResponse> { return this.performFetch(url, options, 'GET'); }
  async post(url: string, options: APIRequestOptions = {}): Promise<APIResponse> { return this.performFetch(url, options, 'POST'); }
  async put(url: string, options: APIRequestOptions = {}): Promise<APIResponse> { return this.performFetch(url, options, 'PUT'); }
  async patch(url: string, options: APIRequestOptions = {}): Promise<APIResponse> { return this.performFetch(url, options, 'PATCH'); }
  async delete(url: string, options: APIRequestOptions = {}): Promise<APIResponse> { return this.performFetch(url, options, 'DELETE'); }
  async head(url: string, options: APIRequestOptions = {}): Promise<APIResponse> { return this.performFetch(url, options, 'HEAD'); }
  private async performFetch(urlOrRequest: string | object, options: APIRequestOptions, forcedMethod: string | undefined): Promise<APIResponse> {
    const started = performance.now();
    const method = `APIRequestContext.${forcedMethod?.toLowerCase() ?? 'fetch'}`;
    this.assertLive(method);
    validateOptions(method, options, ['method', 'headers', 'params', 'data', 'form', 'multipart', 'timeout', 'maxRedirects', 'maxRetries', 'failOnStatusCode', 'ignoreHTTPSErrors']);
    options = { ...options };
    const deadline = deadlineFor(timeoutValue(options.timeout, `${method}.timeout`, this.defaults.timeout), started);
    const preparation = new RequestPreparation(method, this.preparationAborted.signal);
    try {
      const url = requestURL(urlOrRequest, options.params, this.defaults.baseURL, method);
      let verb = forcedMethod ?? options.method ?? 'GET';
      requireString(verb, `${method}.method`);
      verb = verb.toUpperCase();
      if (!verb || !/^[!#$%&'*+\-.^_`|~0-9A-Z]+$/.test(verb)) throw failure('InvalidArgumentError', method, 'method must be a nonempty HTTP token');
      validateBoolean(`${method}.ignoreHTTPSErrors`, options.ignoreHTTPSErrors);
      validateBoolean(`${method}.failOnStatusCode`, options.failOnStatusCode);
      const maxRedirects = unsignedInteger(options.maxRedirects, `${method}.maxRedirects`, this.defaults.maxRedirects);
      const maxRetries = unsignedInteger(options.maxRetries, `${method}.maxRetries`, 0);
      const values = headers(options.headers, `${method}.headers`);
      const body = await preparation.wait(prepareBody(options, values, this.defaults.hasContentType, deadline, method, preparation), deadline);
      this.assertLive(method);
      const parameters = { context: this.identifier, url, method: verb, headers: values, maxRedirects, maxRetries, failOnStatusCode: options.failOnStatusCode ?? this.defaults.failOnStatusCode, hasBody: body !== undefined, ...(options.ignoreHTTPSErrors === undefined ? {} : { ignoreHTTPSErrors: options.ignoreHTTPSErrors }) };
      const remaining = remainingTime(deadline, method);
      const result = body === undefined ? await this.client.request('apiRequest.fetch', parameters, remaining) : await this.client.requestWithInput('apiRequest.fetch', parameters, [body], remaining);
      const metadata = responseMetadata(result, this.identifier, this.client);
      if (this.closed || this.client.isClosed()) {
        await this.client.request('apiResponse.dispose', { context: this.identifier, response: metadata.identifier }).catch(error => this.client.rejectProtocol(error));
        this.assertLive(method);
      }
      const response = new APIResponse(this, this.client, metadata);
      this.responses.add(response);
      return response;
    } finally { preparation.release(); }
  }
  async storageState(options: StorageStateOptions = {}): Promise<StorageState> {
    const method = 'APIRequestContext.storageState';
    this.assertLive(method);
    validateOptions(method, options, ['path', 'indexedDB']);
    options = { ...options };
    validateBoolean(`${method}.indexedDB`, options.indexedDB);
    if (options.indexedDB) throw failure('UnsupportedFeatureError', `${method}.indexedDB`, 'IndexedDB snapshots are not implemented');
    if (options.path !== undefined) requireString(options.path, `${method}.path`);
    const state = decodeStorageState(await this.client.request('apiRequest.storageState', { context: this.identifier }) as WireStorageState);
    this.assertLive(method);
    if (options.path) await writeAtomicFile(options.path, JSON.stringify(state, null, 2));
    return state;
  }
  async dispose(options: { reason?: string } = {}): Promise<void> {
    validateOptions('APIRequestContext.dispose', options, ['reason']);
    if (options.reason !== undefined) requireString(options.reason, 'APIRequestContext.dispose.reason');
    if (this.disposal) return this.disposal;
    if (this.closed) return this.release();
    this.closeReason = options.reason;
    this.closeLocally();
    this.disposal = (async () => {
      try { await this.client.request('apiRequest.dispose', { context: this.identifier, ...(options.reason === undefined ? {} : { reason: options.reason }) }); }
      catch (error) {
        if (!(error instanceof Error && ['TargetClosedError', 'BrowserDisconnectedError'].includes(error.name))) {
          this.client.rejectProtocol(error);
          throw error;
        }
      } finally { await this.release(); }
    })();
    return this.disposal;
  }
  async [Symbol.asyncDispose](): Promise<void> { await this.dispose(); }
}

/** Response metadata survives disposal; body custody belongs to its original context. */
export class APIResponse {
  private disposed = false;
  private cachedBody: Promise<Buffer> | undefined;
  private disposal: Promise<void> | undefined;
  private readonly headerMap: Record<string, string> = Object.create(null) as Record<string, string>;
  constructor(private readonly owner: APIRequestContext, private readonly client: EngineClient, private readonly metadata: ResponseMetadata) {
    for (const header of metadata.headers) {
      const name = header.name.toLowerCase();
      const previous = this.headerMap[name];
      this.headerMap[name] = previous === undefined ? header.value : `${previous}${name === 'set-cookie' ? '\n' : ', '}${header.value}`;
    }
  }
  ok(): boolean { return this.metadata.status >= 200 && this.metadata.status <= 299; }
  url(): string { return this.metadata.url; }
  status(): number { return this.metadata.status; }
  statusText(): string { return this.metadata.statusText; }
  headers(): Record<string, string> { return { ...this.headerMap }; }
  headersArray(): APIRequestHeader[] { return this.metadata.headers; }
  private assertLive(): void {
    this.owner.assertLive('APIResponse.body');
    if (this.disposed) throw failure('TargetClosedError', 'APIResponse.body', 'response has been disposed');
  }
  async body(): Promise<Buffer> {
    this.assertLive();
    if (!this.cachedBody) {
      const pending = this.client.requestBinary('apiResponse.body', { context: this.metadata.context, response: this.metadata.identifier }, 0, this.metadata.bodyLength);
      this.cachedBody = pending;
      void pending.catch(() => { if (this.cachedBody === pending) this.cachedBody = undefined; });
    }
    const body = await this.cachedBody;
    this.assertLive();
    return body;
  }
  async text(): Promise<string> { return (await this.body()).toString('utf8'); }
  async json(): Promise<ReturnType<typeof JSON.parse>> { return JSON.parse(await this.text()); }
  ownerClosed(): void { this.disposed = true; this.cachedBody = undefined; }
  async dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    if (this.disposed) return;
    this.ownerClosed();
    this.owner.forgetResponse(this);
    this.disposal = this.client.request('apiResponse.dispose', { context: this.metadata.context, response: this.metadata.identifier }).then(() => {}, error => {
      if (error instanceof Error && ['TargetClosedError', 'BrowserDisconnectedError'].includes(error.name)) return;
      this.client.rejectProtocol(error);
      throw error;
    });
    return this.disposal;
  }
  async [Symbol.asyncDispose](): Promise<void> { await this.dispose(); }
}

export class APIRequest {
  async newContext(options: APIRequestContextOptions = {}): Promise<APIRequestContext> {
    const started = performance.now();
    const method = 'request.newContext';
    validateOptions(method, options, ['baseURL', 'extraHTTPHeaders', 'userAgent', 'timeout', 'ignoreHTTPSErrors', 'httpCredentials', 'storageState', 'maxRedirects', 'failOnStatusCode', 'proxy', 'clientCertificates']);
    options = { ...options };
    for (const field of ['proxy', 'clientCertificates'] as const) if (options[field] !== undefined) throw failure('UnsupportedFeatureError', `${method}.${field}`, 'option is not implemented for standalone API requests');
    if (options.baseURL !== undefined) requireString(options.baseURL, `${method}.baseURL`);
    if (options.userAgent !== undefined) requireString(options.userAgent, `${method}.userAgent`);
    validateBoolean(`${method}.ignoreHTTPSErrors`, options.ignoreHTTPSErrors);
    validateBoolean(`${method}.failOnStatusCode`, options.failOnStatusCode);
    const timeout = timeoutValue(options.timeout, `${method}.timeout`, 30000);
    const deadline = deadlineFor(timeout, started);
    const preparation = new RequestPreparation(method);
    try {
      const maxRedirects = unsignedInteger(options.maxRedirects, `${method}.maxRedirects`, 20);
      const extraHTTPHeaders = headers(options.extraHTTPHeaders, `${method}.extraHTTPHeaders`);
      let credentials: APIRequestContextOptions['httpCredentials'];
      if (options.httpCredentials !== undefined) {
        const value = record(options.httpCredentials, `${method}.httpCredentials`);
        validateOptions(`${method}.httpCredentials`, value, ['username', 'password', 'origin', 'send']);
        requireString(value.username, `${method}.httpCredentials.username`);
        requireString(value.password, `${method}.httpCredentials.password`);
        if (value.origin !== undefined) requireString(value.origin, `${method}.httpCredentials.origin`);
        if (value.send !== undefined && value.send !== 'unauthorized' && value.send !== 'always') throw failure('InvalidArgumentError', `${method}.httpCredentials.send`, 'expected unauthorized or always');
        credentials = { username: value.username, password: value.password, ...(value.origin === undefined ? {} : { origin: value.origin }), ...(value.send === undefined ? {} : { send: value.send }) };
      }
      let metadataBytes = extraHTTPHeaders.reduce((total, header) => total + Buffer.byteLength(header.name) + Buffer.byteLength(header.value), 0);
      if (options.userAgent !== undefined) {
        metadataBytes += Buffer.byteLength(options.userAgent);
        try { validateHeaderValue('user-agent', options.userAgent); } catch { throw failure('InvalidArgumentError', `${method}.userAgent`, 'invalid HTTP user agent'); }
      }
      if (credentials) for (const value of Object.values(credentials)) metadataBytes += Buffer.byteLength(value);
      boundedLength(metadataBytes, method, maximumMetadataBytes);
      const storageState = options.storageState === undefined ? undefined : await preparation.wait(storageInput(options.storageState, deadline, preparation), deadline);
      remainingTime(deadline, method);
      const client = retainEngine(deadline, method);
      try {
        const parameters = { extraHTTPHeaders, ...(options.userAgent === undefined ? {} : { userAgent: options.userAgent }), ...(options.ignoreHTTPSErrors === undefined ? {} : { ignoreHTTPSErrors: options.ignoreHTTPSErrors }), ...(credentials === undefined ? {} : { httpCredentials: credentials }), ...(storageState === undefined ? {} : { storageState }) };
        const result = await client.request('apiRequest.newContext', parameters, remainingTime(deadline, method));
        if (!result || typeof result !== 'object' || !('identifier' in result) || typeof result.identifier !== 'string' || !result.identifier) {
          const error = failure('ProtocolError', method, 'native request context omitted its original identifier');
          client.rejectProtocol(error);
          throw error;
        }
        return new APIRequestContext(client, result.identifier, { baseURL: options.baseURL, timeout, maxRedirects, failOnStatusCode: options.failOnStatusCode ?? false, hasContentType: extraHTTPHeaders.some(header => header.name.toLowerCase() === 'content-type') });
      } catch (error) { await client.release(); throw error; }
    } finally { preparation.release(); }
  }
}
export const request = new APIRequest();
