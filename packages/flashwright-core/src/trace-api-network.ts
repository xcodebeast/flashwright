import { failure } from './errors.js';

interface Header { name: string; value: string }
export interface APITraceAttempt {
  generation: string;
  call: string;
  attempt: string;
  snapshot: Record<string, unknown>;
}

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
  if (status < 100 || status > 999) invalid('invalid API trace status');
  const requestBodySize = nonnegative(event.requestBodySize, 'request body size');
  const responseBodySize = event.responseBodySize === null ? -1 : nonnegative(event.responseBodySize, 'response body size');
  const requestHeaders = headers(event.requestHeaders);
  const responseHeaders = headers(event.responseHeaders);
  let url: URL;
  try { url = new URL(event.url as string); }
  catch { return invalid('invalid API trace URL'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') invalid('invalid API trace URL scheme');
  const contentType = responseHeaders.find(header => header.name.toLowerCase() === 'content-type')?.value ?? 'x-unknown';
  const redirectURL = responseHeaders.find(header => header.name.toLowerCase() === 'location')?.value ?? '';
  const snapshot = {
    startedDateTime: new Date(startedWallTime).toISOString(), time: elapsedMilliseconds,
    request: { method: event.method, url: url.toString(), httpVersion: 'HTTP/1.1', cookies: [], headers: requestHeaders,
      queryString: [...url.searchParams].map(([name, value]) => ({ name, value })), headersSize: -1, bodySize: requestBodySize },
    response: { status, statusText: event.statusText, httpVersion: event.httpVersion, cookies: [], headers: responseHeaders,
      content: { size: responseBodySize, mimeType: contentType }, headersSize: -1, bodySize: responseBodySize, redirectURL, _transferSize: -1 },
    cache: {}, timings: { send: -1, wait: elapsedMilliseconds, receive: -1 }, _apiRequest: true,
  };
  return { generation: event.generation as string, call: event.call as string, attempt: event.attempt as string, snapshot };
}
