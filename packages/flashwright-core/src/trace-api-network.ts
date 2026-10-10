import { failure } from './errors.js';

interface Header { name: string; value: string }
export interface APITraceAttempt {
  generation: string;
  call: string;
  attempt: string;
  responseIdentifier: string | undefined;
  requestBodyPresent: boolean;
  snapshot: Record<string, unknown>;
}

export interface APITraceRequestBody { alias: string; mimeType: string; size: number; params?: { name: string; value: string }[] }

function invalid(message: string): never { throw failure('ProtocolError', 'tracing.api', message); }

function headers(value: unknown): Header[] {
  if (!Array.isArray(value) || value.length > 4096) invalid('invalid API trace header count');
  let bytes = 0;
  return value.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) invalid('invalid API trace header');
    const { name, value } = item as Record<string, unknown>;
    if (typeof name !== 'string' || typeof value !== 'string') invalid('invalid API trace header');
    bytes += Buffer.byteLength(name) + Buffer.byteLength(value) + 64;
    if (bytes > 32 * 1024) throw failure('ResourceLimitError', 'tracing.api', 'API trace headers exceed 32 KiB');
    return { name, value };
  });
}

function nonnegative(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) invalid(`invalid API trace ${name}`);
  return value;
}

function responseCookie(header: string, url: URL, now: number): Record<string, unknown> | undefined {
  const pairs = header.split(';').map(pair => pair.trim()).filter(Boolean);
  if (!pairs.length) return undefined;
  const firstEquals = pairs[0]!.indexOf('=');
  const cookie: Record<string, unknown> = {
    name: (firstEquals < 0 ? pairs[0]! : pairs[0]!.slice(0, firstEquals)).trim(),
    value: firstEquals < 0 ? '' : pairs[0]!.slice(firstEquals + 1).trim(),
    domain: '', path: '', httpOnly: false, secure: false, sameSite: 'Lax',
  };
  let expires = -1;
  for (const pair of pairs.slice(1)) {
    const equals = pair.indexOf('=');
    const name = (equals < 0 ? pair : pair.slice(0, equals)).trim().toLowerCase();
    const value = equals < 0 ? '' : pair.slice(equals + 1).trim();
    if (name === 'expires') {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) expires = parsed <= 0 ? 0 : Math.min(parsed / 1000, 253402300799);
    } else if (name === 'max-age') {
      const age = Number.parseInt(value, 10);
      if (Number.isFinite(age)) expires = age <= 0 ? 0 : Math.min(now / 1000 + age, 253402300799);
    } else if (name === 'domain') {
      let domain = value.toLocaleLowerCase();
      if (domain && !domain.startsWith('.') && domain.includes('.')) domain = `.${domain}`;
      cookie.domain = domain;
    } else if (name === 'path') cookie.path = value;
    else if (name === 'secure') cookie.secure = true;
    else if (name === 'httponly') cookie.httpOnly = true;
    else if (name === 'samesite' && ['none', 'lax', 'strict'].includes(value.toLowerCase())) cookie.sameSite = value[0]!.toUpperCase() + value.slice(1).toLowerCase();
  }
  if (!cookie.domain) cookie.domain = url.hostname;
  const domain = cookie.domain as string;
  if (domain !== url.hostname && !(domain.startsWith('.') && `.${url.hostname}`.endsWith(domain))) return undefined;
  if (!(cookie.path as string).startsWith('/')) cookie.path = '/' + url.pathname.slice(1).split('/').slice(0, -1).join('/');
  if (expires !== -1) {
    const date = new Date(expires);
    if (Number.isFinite(date.valueOf())) cookie.expires = date.toISOString();
  }
  return cookie;
}

/** Build the pinned viewer's API HAR shape from one original native wire attempt. */
export function apiTraceAttempt(value: unknown): APITraceAttempt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('invalid API trace attempt');
  const event = value as Record<string, unknown>;
  for (const name of ['generation', 'call', 'attempt', 'url', 'method', 'httpVersion'] as const) {
    if (typeof event[name] !== 'string' || !event[name] || event[name].length > 32768) invalid(`invalid API trace ${name}`);
  }
  if (typeof event.statusText !== 'string' || event.statusText.length > 32768) invalid('invalid API trace statusText');
  if (!/^(?:0\.9|1\.0|1\.1|2\.0|3\.0|\?)$/.test(event.httpVersion as string)) invalid('invalid API trace HTTP version');
  const startedWallTime = event.startedWallTime;
  const elapsedMilliseconds = event.elapsedMilliseconds;
  if (typeof startedWallTime !== 'number' || !Number.isFinite(startedWallTime) || startedWallTime < 0 || startedWallTime > 8_640_000_000_000_000 || typeof elapsedMilliseconds !== 'number' || !Number.isFinite(elapsedMilliseconds) || elapsedMilliseconds < 0) invalid('invalid API trace clock');
  const status = nonnegative(event.status, 'status');
  if (event.failed !== true && event.failed !== false) invalid('invalid API trace failure state');
  const failed = event.failed;
  if ((!failed && (status < 100 || status > 999)) || (failed && status !== 0)) invalid('invalid API trace status');
  const requestBodySize = nonnegative(event.requestBodySize, 'request body size');
  if (typeof event.requestBodyPresent !== 'boolean' || (!event.requestBodyPresent && requestBodySize !== 0)) invalid('invalid API trace request body presence');
  const responseBodySize = event.responseBodySize === null ? 0 : nonnegative(event.responseBodySize, 'response body size');
  if (event.responseIdentifier !== null && (typeof event.responseIdentifier !== 'string' || !event.responseIdentifier || event.responseIdentifier.length > 128)) invalid('invalid API trace response identity');
  const requestHeaders = headers(event.requestHeaders);
  const responseHeaders = headers(event.responseHeaders);
  let url: URL;
  try { url = new URL(event.url as string); }
  catch { return invalid('invalid API trace URL'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') invalid('invalid API trace URL scheme');
  const contentType = responseHeaders.find(header => header.name.toLowerCase() === 'content-type')?.value ?? 'x-unknown';
  const redirectURL = responseHeaders.find(header => header.name.toLowerCase() === 'location')?.value ?? '';
  const requestCookies = requestHeaders.filter(header => header.name.toLowerCase() === 'cookie').flatMap(header => header.value.split(';').map(value => {
    const equals = value.indexOf('=');
    return { name: (equals < 0 ? value : value.slice(0, equals)).trim(), value: equals < 0 ? '' : value.slice(equals + 1).trim() };
  }));
  const responseCookies = responseHeaders.filter(header => header.name.toLowerCase() === 'set-cookie')
    .flatMap(header => responseCookie(header.value, url, startedWallTime + elapsedMilliseconds) ?? []);
  const snapshot = {
    startedDateTime: new Date(startedWallTime).toISOString(), time: failed ? -1 : elapsedMilliseconds,
    request: { method: event.method, url: url.toString(), httpVersion: 'HTTP/1.1', cookies: requestCookies, headers: requestHeaders,
      queryString: [...url.searchParams].map(([name, value]) => ({ name, value })), headersSize: -1, bodySize: requestBodySize },
    response: { status: failed ? -1 : status, statusText: event.statusText, httpVersion: failed ? 'HTTP/1.1' : event.httpVersion, cookies: responseCookies, headers: responseHeaders,
      content: { size: failed ? -1 : responseBodySize, mimeType: contentType }, headersSize: -1, bodySize: failed ? -1 : responseBodySize, redirectURL, _transferSize: -1 },
    cache: {}, timings: { send: -1, wait: failed ? -1 : elapsedMilliseconds, receive: -1 }, _apiRequest: true,
  };
  return { generation: event.generation as string, call: event.call as string, attempt: event.attempt as string,
    responseIdentifier: event.responseIdentifier === null ? undefined : event.responseIdentifier as string,
    requestBodyPresent: event.requestBodyPresent, snapshot };
}

export function apiTraceBodyExtension(attempt: APITraceAttempt): string {
  const response = attempt.snapshot.response as { content: { mimeType: string } };
  return apiTraceResourceExtension(response.content.mimeType);
}

export function apiTraceResourceExtension(value: string): string {
  const mimeType = value.split(';', 1)[0]!.trim().toLowerCase();
  const extensions: Record<string, string> = {
    'text/plain': 'txt', 'text/html': 'html', 'text/css': 'css', 'text/javascript': 'js', 'application/javascript': 'js',
    'application/json': 'json', 'application/xml': 'xml', 'text/xml': 'xml', 'image/svg+xml': 'svg',
    'image/png': 'png', 'image/jpeg': 'jpeg', 'image/webp': 'webp', 'image/gif': 'gif', 'application/pdf': 'pdf',
    'application/octet-stream': 'bin',
  };
  return extensions[mimeType] ?? 'dat';
}

export function apiTraceBodySnapshot(attempt: APITraceAttempt, alias: string | undefined, reason?: string): Record<string, unknown> {
  const response = attempt.snapshot.response as { content: Record<string, unknown> };
  return { ...attempt.snapshot, response: { ...response, content: { ...response.content,
    ...(alias ? { _sha1: alias } : {}), ...(reason ? { _flashwrightContentUnavailable: reason } : {}) } } };
}

export function apiTraceRequestBodySnapshot(attempt: APITraceAttempt, body: APITraceRequestBody): Record<string, unknown> {
  const request = attempt.snapshot.request as Record<string, unknown>;
  if (request.bodySize !== body.size) invalid('API trace request body changed between preparation and wire attempt');
  return { ...attempt.snapshot, request: { ...request, postData: { mimeType: body.mimeType, text: '', params: body.params ?? [], _sha1: body.alias } } };
}
