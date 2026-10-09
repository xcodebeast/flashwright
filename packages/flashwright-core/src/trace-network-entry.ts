import { failure } from './errors.js';

export interface NetworkTraceHeader { name: string; value: string }
export type NetworkTraceBody = { kind: 'pending' } | { kind: 'unavailable'; reason: string } | { kind: 'resource'; token: string; byteLength: number };
export interface NetworkTraceResource { alias: string; byteLength: number; formParameters?: NetworkTraceHeader[] }
export interface NetworkTraceConversionContext {
  pageReference: string;
  monotonicTime: number;
  /** Explicit parse-time wall clock for Set-Cookie Max-Age, in milliseconds. */
  cookieWallTime: number;
  resolveResource(token: string): NetworkTraceResource;
}

/** Native admission metadata. Raw namespaces are retained separately and never merged. */
export interface NetworkTraceMetadata {
  page: string;
  frame: string;
  identity: unknown;
  nativeTime: number;
  startedWallTime: number;
  originalIngress: { sequence: number; nativeTime: number };
  originalRequestTimestamp: number;
  originalRequestWallTime: number;
  request: { url: string; method: string; resourceType: string; headers: NetworkTraceHeader[] };
  effectiveRequest: { url: string; method: string };
  requestPostData?: { token: string; byteLength: number; mimeType: string };
  requestHeaders?: NetworkTraceHeader[];
  responseHeaders?: NetworkTraceHeader[];
  requestHeadersReady: boolean;
  responseHeadersReady: boolean;
  requestExtra?: Record<string, unknown>;
  responseExtra?: Record<string, unknown>;
  response?: Record<string, unknown>;
  servedFromCache: boolean;
  redirectURL?: string;
  terminal?: { kind: 'finished' | 'failed' | 'retired'; timestamp?: number; encodedDataLength?: number; errorText?: string };
  routing: { continued?: boolean; fulfilled?: boolean; aborted?: boolean };
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Dictionary = { [key: string]: Json };
export const networkTraceEntryLimits = Object.freeze({ inputBytes: 1024 * 1024, outputBytes: 2 * 1024 * 1024, values: 20000, depth: 16, stringUnits: 256 * 1024, headers: 2048 });
const invalid = (message: string) => failure('ProtocolError', 'tracing.network', message);
const limited = (message: string) => failure('ResourceLimitError', 'tracing.network', message);

/** Copy owned JSON without invoking getters; limits apply before allocation of encoded output. */
function boundedCopy(root: unknown, byteLimit: number): Json {
  let bytes = 0;
  let values = 0;
  const ancestors = new Set<object>();
  function account(amount: number): void {
    bytes += amount;
    if (bytes > byteLimit) throw limited('network entry byte limit exceeded');
  }
  function copy(value: unknown, depth: number): Json {
    if (++values > networkTraceEntryLimits.values || depth > networkTraceEntryLimits.depth) throw limited('network entry value or depth limit exceeded');
    if (typeof value === 'string') {
      if (value.length > networkTraceEntryLimits.stringUnits) throw limited('network entry string limit exceeded');
      account(Buffer.byteLength(JSON.stringify(value))); return value;
    }
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw invalid('network entry numbers must be finite');
      account(String(value).length); return value;
    }
    if (value === null || typeof value === 'boolean') { account(5); return value; }
    if (typeof value !== 'object' || value === null) throw invalid('network entry must contain JSON data');
    if (ancestors.has(value)) throw invalid('network entry contains a cycle');
    const array = Array.isArray(value);
    if (!array && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw invalid('network entry requires plain objects');
    const keys = Object.keys(value);
    if (keys.length > networkTraceEntryLimits.values || (array && value.length > networkTraceEntryLimits.values)) throw limited('network entry collection limit exceeded');
    if (array && keys.length !== value.length) throw invalid('network entry arrays must be dense');
    ancestors.add(value);
    account(2 + keys.length);
    const result: Json[] | Dictionary = array ? [] : Object.create(null) as Dictionary;
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor)) throw invalid('network entry requires own data properties');
      if (array && !/^(0|[1-9][0-9]*)$/.test(key)) throw invalid('network entry array has extra properties');
      if (!array) { copy(key, depth + 1); account(1); }
      const child = copy(descriptor.value, depth + 1);
      if (Array.isArray(result)) result.push(child); else result[key] = child;
    }
    ancestors.delete(value);
    return result;
  }
  return copy(root, 0);
}
function object(value: Json | undefined, name: string): Dictionary {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw invalid(`${name} must be an object`);
  return value;
}
function string(value: Json | undefined, name: string): string {
  if (typeof value !== 'string') throw invalid(`${name} must be a string`);
  return value;
}
function number(value: Json | undefined, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw invalid(`${name} must be finite`);
  return value;
}
function boolean(value: Json | undefined, name: string): boolean {
  if (typeof value !== 'boolean') throw invalid(`${name} must be boolean`);
  return value;
}
function byteLength(value: Json | undefined): number {
  const length = number(value, 'byteLength');
  if (!Number.isSafeInteger(length) || length < 0) throw invalid('byteLength must be a nonnegative safe integer');
  return length;
}
function headers(value: Json | undefined): NetworkTraceHeader[] {
  if (!Array.isArray(value)) throw invalid('headers must be an array');
  if (value.length > networkTraceEntryLimits.headers) throw limited('network entry header limit exceeded');
  return value.map(item => {
    const header = object(item, 'header');
    return { name: string(header.name, 'header.name'), value: string(header.value, 'header.value') };
  });
}
function provisionalHeaders(value: Json | undefined): NetworkTraceHeader[] {
  const result: NetworkTraceHeader[] = [];
  for (const [name, rawValue] of Object.entries(object(value, 'response.headers'))) {
    if (result.length >= networkTraceEntryLimits.headers) throw limited('network entry header limit exceeded');
    result.push({ name, value: string(rawValue, 'response header value') });
  }
  return result;
}
const headerValue = (values: NetworkTraceHeader[], name: string) => values.find(header => header.name.toLowerCase() === name)?.value;
const headerUnits = (values: NetworkTraceHeader[]) => values.reduce((total, header) => total + header.name.length + header.value.length + 4, 0);
const milliseconds = (value: number) => (value * 1000 | 0) / 1000;
const seconds = (value: number) => (value * 1000000 | 0) / 1000;
function url(value: Json | undefined): URL {
  try { return new URL(string(value, 'URL')); } catch { throw invalid('network entry URL is invalid'); }
}
function isoDate(value: number | string): string | undefined {
  const date = new Date(value);
  return Number.isFinite(date.valueOf()) ? date.toISOString() : undefined;
}

/** Match the pinned HAR cookie parser, including its case-sensitive attribute names. */
function cookie(text: string, wallTime: number): Dictionary {
  const result: Dictionary = { name: '', value: '' };
  let first = true;
  for (const pair of text.split(/; */)) {
    const equals = pair.indexOf('=');
    const name = (equals < 0 ? pair : pair.slice(0, equals)).trim();
    const value = equals < 0 ? '' : pair.slice(equals + 1).trim();
    if (first) { result.name = name; result.value = value; first = false; continue; }
    if (name === 'Domain') result.domain = value;
    if (name === 'Path') result.path = value;
    if (name === 'SameSite') result.sameSite = value;
    if (name === 'Secure') result.secure = true;
    if (name === 'HttpOnly') result.httpOnly = true;
    if (name === 'Expires' || name === 'Max-Age') {
      const expires = isoDate(name === 'Expires' ? value : wallTime + Number(value) * 1000);
      if (expires !== undefined) result.expires = expires; else delete result.expires;
    }
  }
  return result;
}

/** Pure conversion of one immutable journal version. Resource lookup never fetches bytes. */
export function convertNetworkTraceEntry(metadata: unknown, body: NetworkTraceBody, context: NetworkTraceConversionContext): Dictionary {
  const source = object(boundedCopy(metadata, networkTraceEntryLimits.inputBytes), 'metadata');
  const outcome = object(boundedCopy(body, 65536), 'body');
  const mapping = object(boundedCopy({ pageReference: context.pageReference, monotonicTime: context.monotonicTime, cookieWallTime: context.cookieWallTime }, 65536), 'mapping');
  const wallTime = number(mapping.cookieWallTime, 'cookieWallTime');
  const request = object(source.request, 'request');
  const effectiveRequest = object(source.effectiveRequest, 'effectiveRequest');
  const requestURL = url(request.url);
  const requestHeaders = headers(source.requestHeaders ?? request.headers);
  const requestHeadersReady = boolean(source.requestHeadersReady, 'requestHeadersReady');
  const responseHeadersReady = boolean(source.responseHeadersReady, 'responseHeadersReady');
  const servedFromCache = boolean(source.servedFromCache, 'servedFromCache');
  const startedDateTime = isoDate(number(source.startedWallTime, 'startedWallTime'));
  if (!startedDateTime) throw invalid('startedWallTime is outside the date range');
  const response = source.response === undefined ? undefined : object(source.response, 'response');
  const terminal = source.terminal === undefined ? undefined : object(source.terminal, 'terminal');
  if (terminal && !['finished', 'failed', 'retired'].includes(string(terminal.kind, 'terminal.kind'))) throw invalid('invalid terminal kind');
  const finished = terminal?.kind === 'finished';
  const selectedResponseHeaders = response ? source.responseHeaders === undefined ? provisionalHeaders(response.headers) : headers(source.responseHeaders) : [];
  const content: Dictionary = { size: -1, mimeType: headerValue(selectedResponseHeaders, 'content-type') ?? (response ? headerValue(provisionalHeaders(response.headers), 'content-type') : undefined) ?? 'x-unknown' };
  const requestEntry: Dictionary = {
    method: string(request.method, 'request.method'), url: requestURL.toString(), httpVersion: 'HTTP/1.1',
    cookies: requestHeaders.filter(header => header.name.toLowerCase() === 'cookie').flatMap(header => header.value.split(';').map(value => cookie(value, wallTime))),
    headers: requestHeaders as unknown as Json[], queryString: [...requestURL.searchParams].map(([name, value]) => ({ name, value })), headersSize: -1, bodySize: 0,
  };
  const responseEntry: Dictionary = {
    status: response ? number(response.status, 'response.status') : -1,
    statusText: response ? string(response.statusText, 'response.statusText') : '', httpVersion: 'HTTP/1.1',
    cookies: selectedResponseHeaders.filter(header => header.name.toLowerCase() === 'set-cookie').map(header => cookie(header.value, wallTime)),
    headers: selectedResponseHeaders as unknown as Json[], content, headersSize: -1, bodySize: -1,
    redirectURL: source.redirectURL === undefined ? '' : string(source.redirectURL, 'redirectURL'), _transferSize: -1,
  };
  const timings: Dictionary = { send: -1, wait: -1, receive: -1 };
  const entry: Dictionary = { pageref: string(mapping.pageReference, 'pageReference'), startedDateTime, time: -1, request: requestEntry, response: responseEntry, cache: {}, timings, _frameref: string(source.frame, 'frame'), _monotonicTime: number(mapping.monotonicTime, 'monotonicTime') };
  function resource(descriptor: Dictionary): Dictionary {
    const resolved = object(boundedCopy(context.resolveResource(string(descriptor.token, 'resource.token')), networkTraceEntryLimits.inputBytes), 'resource');
    const alias = string(resolved.alias, 'resource.alias');
    if (!/^[a-f0-9]{40}(?:\.[a-zA-Z0-9_-]+)?$|^[a-f0-9]{64}(?:\.[a-zA-Z0-9_-]+)?$/.test(alias)) throw invalid('invalid resource alias');
    if (byteLength(resolved.byteLength) !== byteLength(descriptor.byteLength)) throw invalid('resource byte length mismatch');
    return resolved;
  }
  if (source.requestPostData !== undefined) {
    const postData = object(source.requestPostData, 'requestPostData');
    const owned = resource(postData);
    const mimeType = string(postData.mimeType, 'requestPostData.mimeType');
    const params = mimeType === 'application/x-www-form-urlencoded' && owned.formParameters !== undefined ? headers(owned.formParameters) : [];
    requestEntry.bodySize = byteLength(postData.byteLength);
    requestEntry.postData = { mimeType, text: '', params: params as unknown as Json[], _sha1: owned.alias! };
  }
  if (!['resource', 'pending', 'unavailable'].includes(string(outcome.kind, 'body.kind'))) throw invalid('invalid body kind');
  if (outcome.kind === 'unavailable') string(outcome.reason, 'body.reason');
  if (outcome.kind === 'resource') {
    if (!response || !finished || (Number(response.status) >= 300 && Number(response.status) <= 399)) throw invalid('resource body requires a finished non-redirect response');
    const owned = resource(outcome);
    content.size = byteLength(owned.byteLength); content._sha1 = owned.alias!;
  }
  if (response) {
    const timing = !servedFromCache && response.timing !== undefined ? object(response.timing, 'response.timing') : undefined;
    const timingValue = (name: string) => timing ? number(timing[name], `timing.${name}`) : -1;
    const responseStart = timingValue('receiveHeadersEnd');
    timings.dns = timingValue('dnsEnd') !== -1 ? milliseconds(timingValue('dnsEnd') - timingValue('dnsStart')) : -1;
    timings.connect = timingValue('connectEnd') !== -1 ? milliseconds(timingValue('connectEnd') - timingValue('connectStart')) : -1;
    // Pinned HAR checks connectEnd, even when sslStart is -1 on plain HTTP.
    timings.ssl = timingValue('connectEnd') !== -1 ? milliseconds(timingValue('connectEnd') - timingValue('sslStart')) : -1;
    timings.send = 0;
    timings.wait = responseStart !== -1 ? milliseconds(responseStart - timingValue('sendStart')) : -1;
    if (finished) {
      if (terminal.timestamp !== undefined) {
        const delta = number(terminal.timestamp, 'terminal.timestamp') - number(source.originalRequestTimestamp, 'originalRequestTimestamp');
        const end = source.redirectURL ? delta * 1000 : seconds(delta);
        const clamped = Math.max(end, responseStart);
        timings.receive = clamped !== -1 ? milliseconds(clamped - responseStart) : -1;
      }
      const protocol = response.protocol === undefined ? '' : string(response.protocol, 'response.protocol');
      requestEntry.httpVersion = responseEntry.httpVersion = protocol === 'h2' ? 'HTTP/2.0' : !protocol || protocol === 'http/1.1' ? 'HTTP/1.1' : protocol;
      if (response.remoteIPAddress && typeof response.remotePort === 'number') {
        entry.serverIPAddress = string(response.remoteIPAddress, 'response.remoteIPAddress');
        if (response.remotePort) entry._serverPort = response.remotePort;
      }
      const security: Dictionary = {};
      if (response.securityDetails !== undefined) {
        const details = object(response.securityDetails, 'securityDetails');
        for (const key of ['protocol', 'subjectName', 'issuer', 'validFrom', 'validTo']) {
          if (details[key] !== undefined) security[key] = key.startsWith('valid') ? number(details[key], key) : string(details[key], key);
        }
      }
      entry._securityDetails = security;
      // The reference publishes all four sizes together after both header promises settle.
      if (requestHeadersReady && responseHeadersReady) {
        requestEntry.headersSize = 4 + string(effectiveRequest.method, 'effectiveRequest.method').length + url(effectiveRequest.url).pathname.length + 8 + headerUnits(requestHeaders);
        const extra = source.responseExtra === undefined ? undefined : object(source.responseExtra, 'responseExtra');
        const responseHeaderSize = extra && !servedFromCache ? (extra.headersText === undefined ? 0 : string(extra.headersText, 'headersText').length) : 4 + 8 + 3 + String(responseEntry.statusText).length + headerUnits(selectedResponseHeaders) + 2;
        const transferred = terminal.encodedDataLength === undefined ? undefined : number(terminal.encodedDataLength, 'encodedDataLength');
        const encoded = transferred === undefined ? Number(headerValue(selectedResponseHeaders, 'content-length') || 0) : transferred - responseHeaderSize;
        if (!Number.isFinite(encoded)) throw invalid('Content-Length is not finite');
        responseEntry.headersSize = responseHeaderSize;
        responseEntry.bodySize = encoded;
        responseEntry._transferSize = transferred ?? responseHeaderSize + encoded;
        if (outcome.kind !== 'pending' && encoded !== -1) content.compression = Math.max(0, (outcome.kind === 'resource' ? Number(content.size) : 0) - encoded);
      }
    }
    entry.time = ['dns', 'connect', 'ssl', 'wait', 'receive'].reduce((total, key) => total + Math.max(0, Number(timings[key])), 0);
  }
  if (terminal?.kind === 'failed' && terminal.errorText !== undefined) responseEntry._failureText = string(terminal.errorText, 'errorText');
  const routing = object(source.routing, 'routing');
  for (const [sourceKey, targetKey] of [['continued', '_wasContinued'], ['fulfilled', '_wasFulfilled'], ['aborted', '_wasAborted']] as const) {
    if (routing[sourceKey] !== undefined && boolean(routing[sourceKey], sourceKey)) entry[targetKey] = true;
  }
  return object(boundedCopy(entry, networkTraceEntryLimits.outputBytes), 'HAR entry');
}
