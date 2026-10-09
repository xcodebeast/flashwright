import { runTraceUserCallback } from './trace-hooks.js';
import type { EventEmitter } from 'node:events';
import { failure } from './errors.js';
import { globToRegexPattern, resolveGlobBase } from './url-match.cjs';

// Match the pinned declaration: native URLPattern is available only in runtimes that provide it.
type NativeURLPattern = typeof globalThis extends { URLPattern: new (...arguments_: any[]) => infer Pattern } ? Pattern : never;
export type URLMatcher = string | RegExp | NativeURLPattern | ((url: URL) => boolean);

function isNativeURLPattern(matcher: unknown): matcher is NativeURLPattern {
  return typeof globalThis.URLPattern === 'function' && matcher instanceof globalThis.URLPattern;
}

export function validateURLMatcher(matcher: unknown): asserts matcher is URLMatcher {
  if (typeof matcher === 'string' || typeof matcher === 'function' || matcher instanceof RegExp || isNativeURLPattern(matcher)) return;
  throw failure('InvalidArgumentError', 'url matcher', 'expected a string, regular expression, native URLPattern or function');
}
export interface EventWaitOptions<Value> { predicate?: (value: Value) => boolean | Promise<boolean>; timeout?: number }

export function validateTimeout(value: number, method: string): number {
  if (!Number.isFinite(value) || value < 0) throw failure('InvalidArgumentError', method, 'timeout must be a finite nonnegative number');
  return value;
}

/** Arm listeners synchronously, before the caller can start its trigger. */
export function waitForEvent<Value>(emitter: EventEmitter, event: string, options: EventWaitOptions<Value>, defaultTimeout: number, method: string): Promise<Value> {
  const timeout = validateTimeout(options.timeout ?? defaultTimeout, method);
  if (options.predicate !== undefined && typeof options.predicate !== 'function') throw failure('InvalidArgumentError', method, 'predicate must be a function');
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    function finish(error?: Error, value?: Value): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      emitter.off(event, listener);
      emitter.off('close', closed);
      emitter.off('crash', crashed);
      if (error) reject(error); else resolve(value as Value);
    }
    const closed = () => { if (event !== 'close') finish(failure('TargetClosedError', method, 'page or context closed while waiting')); };
    const crashed = () => { if (event !== 'crash') finish(failure('PageCrashedError', method, 'page crashed while waiting')); };
    const listener = (value: Value) => {
      Promise.resolve().then(() => options.predicate ? runTraceUserCallback(() => options.predicate!(value)) : true)
        .then(matches => { if (matches) finish(undefined, value); }, error => finish(error instanceof Error ? error : new Error(String(error))));
    };
    emitter.on(event, listener);
    emitter.on('close', closed);
    emitter.on('crash', crashed);
    if (timeout) timer = setTimeout(() => finish(failure('TimeoutError', method, 'event wait exceeded its deadline')), timeout);
  });
}

export function matchesURL(url: string, matcher: URLMatcher, baseURL?: string): boolean {
  if (matcher === '') return true;
  if (typeof matcher === 'function') { try { return runTraceUserCallback(() => matcher(new URL(url))); } catch (error) { if (error instanceof TypeError && !URL.canParse(url)) return false; throw error; } }
  if (matcher instanceof RegExp) return runTraceUserCallback(() => matcher.test(url));
  if (isNativeURLPattern(matcher)) return URL.canParse(url) && runTraceUserCallback(() => matcher.test(new URL(url).href));
  if (typeof matcher !== 'string') throw failure('InvalidArgumentError', 'url matcher', 'expected a string, regular expression or function');
  return new RegExp(globToRegexPattern(resolveGlobBase(baseURL, matcher))).test(url);
}
