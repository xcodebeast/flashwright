import { readFile } from 'node:fs/promises';
import { writeAtomicFile } from './files.js';
import { failure } from './errors.js';
import { validateOptions } from './validation.js';

export interface SetCookie {
  name: string; value: string; url?: string; domain?: string; path?: string; expires?: number;
  httpOnly?: boolean; secure?: boolean; sameSite?: 'Strict' | 'Lax' | 'None'; partitionKey?: string;
}
export interface Cookie {
  name: string; value: string; domain: string; path: string; expires: number;
  httpOnly: boolean; secure: boolean; sameSite: 'Strict' | 'Lax' | 'None'; partitionKey?: string;
}
interface CanonicalCookie extends SetCookie { domain: string; path: string; _crHasCrossSiteAncestor?: boolean }
export interface StorageEntry { name: string; value: string }
export interface StorageState { cookies: Cookie[]; origins: Array<{ origin: string; localStorage: StorageEntry[] }> }
export interface StorageStateOptions { path?: string; indexedDB?: boolean }
export interface CookieFilter { name?: string | RegExp; domain?: string | RegExp; path?: string | RegExp }
interface WireStorageEntry { name: number[]; value: number[] }
export interface WireStorageState { cookies: CanonicalCookie[]; origins: Array<{ origin: string; localStorage: WireStorageEntry[] }> }

function requireString(value: unknown, method: string): asserts value is string {
  if (typeof value !== 'string') throw failure('InvalidArgumentError', method, 'expected a string');
}
function requireCookieString(value: unknown, method: string): asserts value is string {
  requireString(value, method);
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (code >= 0xd800 && code <= 0xdfff) throw failure('InvalidArgumentError', method, 'cookie fields cannot contain unpaired UTF-16 surrogates');
  }
}
function validatedObject(value: unknown, method: string, fields: string[]): Record<string, unknown> {
  validateOptions(method, value as object, fields);
  return value as Record<string, unknown>;
}

/** URL/domain/path and expiry rules follow the pinned reference's network helpers. */
export function prepareCookies(value: unknown, method: string): CanonicalCookie[] {
  if (!Array.isArray(value)) throw failure('InvalidArgumentError', method, 'cookies must be an array');
  return value.map(cookie => {
    const fields = validatedObject(cookie, method, ['name', 'value', 'url', 'domain', 'path', 'expires', 'httpOnly', 'secure', 'sameSite', 'partitionKey', '_crHasCrossSiteAncestor']);
    requireCookieString(fields.name, `${method}.name`);
    requireCookieString(fields.value, `${method}.value`);
    for (const field of ['url', 'domain', 'path', 'partitionKey']) if (fields[field] !== undefined) requireCookieString(fields[field], `${method}.${field}`);
    for (const field of ['httpOnly', 'secure', '_crHasCrossSiteAncestor']) if (fields[field] !== undefined && typeof fields[field] !== 'boolean') throw failure('InvalidArgumentError', `${method}.${field}`, 'expected a boolean');
    if (fields.expires !== undefined && (typeof fields.expires !== 'number' || !Number.isFinite(fields.expires) || (fields.expires < 0 && fields.expires !== -1) || fields.expires > 253402300799)) throw failure('InvalidArgumentError', `${method}.expires`, 'expected -1 or a valid nonnegative Unix timestamp');
    if (fields.sameSite !== undefined && !['Strict', 'Lax', 'None'].includes(fields.sameSite as string)) throw failure('InvalidArgumentError', `${method}.sameSite`, 'expected Strict, Lax or None');
    if (!fields.url && !(fields.domain && fields.path)) throw failure('InvalidArgumentError', method, 'cookies require a URL or a domain/path pair');
    if (fields.url && (fields.domain || fields.path)) throw failure('InvalidArgumentError', method, 'cookies require either a URL or a domain/path pair');
    const result: CanonicalCookie = { ...fields, name: fields.name, value: fields.value, domain: typeof fields.domain === 'string' ? fields.domain : '', path: typeof fields.path === 'string' ? fields.path : '' };
    if (result.url) {
      if (result.url === 'about:blank' || result.url.startsWith('data:')) throw failure('InvalidArgumentError', method, 'blank and data URLs cannot have cookies');
      let url: URL;
      try { url = new URL(result.url); } catch { throw failure('InvalidArgumentError', method, 'cookie URL is invalid'); }
      result.domain = url.hostname;
      result.path = url.pathname.substring(0, url.pathname.lastIndexOf('/') + 1);
      result.secure = url.protocol === 'https:';
    }
    return result;
  });
}

/** Match the public URL filter, including the reference's localhost secure-cookie rule. */
export function filterCookies(cookies: Cookie[], urls?: string | ReadonlyArray<string>): Cookie[] {
  const values = typeof urls === 'string' ? (urls ? [urls] : []) : urls === undefined ? [] : urls;
  if (!Array.isArray(values) || values.some(value => typeof value !== 'string')) throw failure('InvalidArgumentError', 'context.cookies', 'URLs must be a string or an array of strings');
  let parsed: URL[];
  try { parsed = values.map(value => new URL(value)); } catch { throw failure('InvalidArgumentError', 'context.cookies', 'cookie filter URL is invalid'); }
  return cookies.filter(cookie => !parsed.length || parsed.some(url => {
    const domain = cookie.domain.startsWith('.') ? cookie.domain : '.' + cookie.domain;
    if (!('.' + url.hostname).endsWith(domain) || !url.pathname.startsWith(cookie.path)) return false;
    return !cookie.secure || url.protocol === 'https:' || url.hostname === 'localhost' || url.hostname.endsWith('.localhost');
  }));
}

export function cookieFilter(filter: CookieFilter): (cookie: Cookie) => boolean {
  validateOptions('context.clearCookies', filter, ['name', 'domain', 'path']);
  const fields = (['name', 'domain', 'path'] as const).map(field => {
    const value = filter[field];
    if (value !== undefined && typeof value !== 'string' && !(value instanceof RegExp)) throw failure('InvalidArgumentError', `context.clearCookies.${field}`, 'expected a string or regular expression');
    return { field, value: value instanceof RegExp ? new RegExp(value.source, value.flags) : value };
  });
  return cookie => fields.every(({ field, value }) => {
    if (!value) return true;
    if (value instanceof RegExp) { value.lastIndex = 0; return value.test(cookie[field]); }
    return cookie[field] === value;
  });
}

const stringCodeUnits = (value: string): number[] => Array.from({ length: value.length }, (_, index) => value.charCodeAt(index));
function stringFromCodeUnits(value: number[]): string {
  let result = '';
  for (let index = 0; index < value.length; index += 8192) result += String.fromCharCode(...value.slice(index, index + 8192));
  return result;
}

export async function prepareStorageState(input: StorageState | string): Promise<WireStorageState> {
  let value: unknown = input;
  if (typeof input === 'string') {
    const contents = await readFile(input, 'utf8');
    try { value = JSON.parse(contents); } catch { throw failure('InvalidArgumentError', 'browser.newContext.storageState', `invalid JSON in storage state file ${input}`); }
  }
  const state = validatedObject(value, 'browser.newContext.storageState', ['cookies', 'origins']);
  const cookies = prepareCookies(state.cookies === undefined ? [] : state.cookies, 'browser.newContext.storageState.cookies');
  if (state.origins !== undefined && !Array.isArray(state.origins)) throw failure('InvalidArgumentError', 'browser.newContext.storageState.origins', 'origins must be an array');
  const origins = (state.origins as unknown[] | undefined ?? []).map(value => {
    const record = validatedObject(value, 'browser.newContext.storageState.origins', ['origin', 'localStorage']);
    requireString(record.origin, 'browser.newContext.storageState.origin');
    let url: URL;
    try { url = new URL(record.origin); } catch { throw failure('InvalidArgumentError', 'browser.newContext.storageState.origin', 'invalid origin'); }
    if (!['http:', 'https:'].includes(url.protocol)) throw failure('UnsupportedFeatureError', 'browser.newContext.storageState.origin', 'only HTTP and HTTPS origin storage is implemented');
    if (!Array.isArray(record.localStorage)) throw failure('InvalidArgumentError', 'browser.newContext.storageState.localStorage', 'expected an array');
    const localStorage = record.localStorage.map(value => {
      const entry = validatedObject(value, 'browser.newContext.storageState.localStorage', ['name', 'value']);
      requireString(entry.name, 'browser.newContext.storageState.localStorage.name');
      requireString(entry.value, 'browser.newContext.storageState.localStorage.value');
      return { name: stringCodeUnits(entry.name), value: stringCodeUnits(entry.value) };
    });
    return { origin: url.origin, localStorage };
  });
  return { cookies, origins };
}

export function decodeStorageState(state: WireStorageState): StorageState {
  return { cookies: state.cookies as Cookie[], origins: state.origins.map(origin => ({ origin: origin.origin, localStorage: origin.localStorage.map(entry => ({ name: stringFromCodeUnits(entry.name), value: stringFromCodeUnits(entry.value) })) })) };
}

/** Complete the snapshot before atomically replacing a requested state file. */
export async function writeStorageState(path: string, state: StorageState): Promise<void> {
  await writeAtomicFile(path, JSON.stringify(state, null, 2));
}
