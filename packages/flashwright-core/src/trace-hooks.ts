import { AsyncLocalStorage } from 'node:async_hooks';
import type { Tracing, TraceCall } from './tracing.js';

export interface TraceCallMetadata { readonly context: string; readonly generation: string }
interface CallScope { internal: boolean; traceCall?: TraceCallMetadata }
export interface TraceOwner { tracing: Tracing; pageId?: string; selector?: string }
export interface TraceMethod { className?: string; method?: string; parameters?: readonly string[] }
let activeChunks = 0;
const scope = new AsyncLocalStorage<CallScope>();
let pageOwnerResolver: ((page: object) => TraceOwner | undefined) | undefined;

export function traceRecordingActive(): boolean { return activeChunks !== 0; }
export function traceChunkOpened(): void { activeChunks++; }
export function traceChunkClosed(): void { activeChunks--; }
export function installTracePageResolver(resolver: (page: object) => TraceOwner | undefined): void { pageOwnerResolver = resolver; }
export function tracePageOwner(page: object): TraceOwner | undefined { return pageOwnerResolver?.(page); }
export function runTraceInternal<Value>(callback: () => Value): Value { return activeChunks ? scope.run({ internal: true }, callback) : callback(); }
export function runTraceUserCallback<Value>(callback: () => Value): Value { return activeChunks || scope.getStore() ? scope.exit(callback) : callback(); }
/** Capture at request invocation so a later chunk cannot acquire an old call's work. */
export function traceCommandMetadata(): TraceCallMetadata | undefined { return activeChunks ? scope.getStore()?.traceCall : undefined; }

/** Inventory only public operations; native helpers and nested public delegation share one call. */
export function instrumentTraceMethods<Owner extends object>(prototype: Owner, className: string, ownerFor: (owner: Owner) => TraceOwner | undefined, methods: Partial<Record<Exclude<keyof Owner, keyof Object>, TraceMethod>>, publicClassName = className): void {
  for (const [name, configuration] of Object.entries(methods) as [string, TraceMethod][]) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
    if (!descriptor || typeof descriptor.value !== 'function') throw new Error(`Missing trace method ${className}.${name}`);
    const original = descriptor.value as (this: Owner, ...arguments_: unknown[]) => unknown;
    const wrapped = function(this: Owner, ...arguments_: unknown[]): unknown {
      if (!activeChunks || scope.getStore()?.internal) return original.apply(this, arguments_);
      const owner = ownerFor(this);
      if (!owner) return original.apply(this, arguments_);
      const call: TraceCall | undefined = owner.tracing.begin(configuration.className ?? className, configuration.method ?? name, `${publicClassName === 'BrowserContext' ? 'browserContext' : publicClassName.toLowerCase()}.${name}`, owner, configuration.parameters ?? [], arguments_);
      if (!call) return original.apply(this, arguments_);
      let result: unknown;
      try { result = scope.run({ internal: true, ...(call.nativeTrace ? { traceCall: call.nativeTrace } : {}) }, () => original.apply(this, arguments_)); }
      catch (error) { owner.tracing.completeSynchronously(call, error); throw error; }
      return Promise.resolve(result).then(async value => { await owner.tracing.complete(call, value, undefined, false); return value; }, async error => { await owner.tracing.complete(call, undefined, error, true); throw error; });
    };
    Object.defineProperty(wrapped, 'name', { value: original.name });
    Object.defineProperty(wrapped, 'length', { value: original.length });
    Object.defineProperty(prototype, name, { ...descriptor, value: wrapped });
  }
}

/** Listener execution can intentionally call another public API while its trigger is pending. */
export function instrumentTraceCallbacks(prototype: object, method: string): void {
  const inherited = Reflect.get(prototype, method) as (...arguments_: unknown[]) => unknown;
  Object.defineProperty(prototype, method, { configurable: true, writable: true, value: function(this: object, ...arguments_: unknown[]): unknown {
    // An unfinished old call can retain its internal scope after its chunk closes.
    if (!activeChunks && !scope.getStore()) return inherited.apply(this, arguments_);
    return runTraceUserCallback(() => inherited.apply(this, arguments_));
  } });
}
