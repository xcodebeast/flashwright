import { types } from 'node:util';
import { callerLocations, type CallerLocation } from './call-sites.js';

const truncated = '[Truncated]';

/** Trace previews never call application accessors, toJSON, iterators or proxy traps. */
export function tracePreview(value: unknown, maximumBytes = 32768, preserveNonFiniteNumbers = false): unknown {
  let remaining = Math.floor(maximumBytes / 6) - 64;
  const seen = new Set<object>();
  const visit = (input: unknown, depth: number): unknown => {
    if (remaining <= 0 || depth > 5) return truncated;
    remaining -= 16;
    if (input === null || typeof input === 'boolean') return input;
    if (typeof input === 'number') {
      if (preserveNonFiniteNumbers || Number.isFinite(input) && !Object.is(input, -0)) return input;
      return `[Number ${Object.is(input, -0) ? '-0' : String(input)}]`;
    }
    if (typeof input === 'string') {
      const length = Math.min(input.length, Math.max(0, remaining));
      remaining -= length;
      return length === input.length ? input : input.slice(0, length) + truncated;
    }
    if (typeof input === 'undefined') return undefined;
    if (typeof input === 'bigint') return '[BigInt]';
    if (typeof input === 'symbol') return '[Symbol]';
    if (typeof input === 'function') return types.isProxy(input) ? '[Proxy function]' : visit(Function.prototype.toString.call(input), depth + 1);
    if (types.isProxy(input)) return '[Proxy]';
    if (seen.has(input)) return '[Circular]';
    seen.add(input);
    if (types.isTypedArray(input)) return '[TypedArray]';
    if (Array.isArray(input)) {
      const length = Object.getOwnPropertyDescriptor(input, 'length')!.value as number;
      const output: unknown[] = [];
      Object.setPrototypeOf(output, null);
      let index = 0;
      for (; index < Math.min(length, 100) && remaining > 0; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
        output[index] = !descriptor ? undefined : 'value' in descriptor ? visit(descriptor.value, depth + 1) : '[Accessor]';
      }
      if (index < length) output[index] = truncated;
      return output;
    }
    if (![Object.prototype, null].includes(Object.getPrototypeOf(input))) return '[Object]';
    const output: Record<string, unknown> = Object.create(null);
    let count = 0;
    for (const key in input) {
      if (!Object.hasOwn(input, key)) continue;
      if (++count > 100 || remaining <= 0) { output['[Truncated]'] = true; break; }
      const descriptor = Object.getOwnPropertyDescriptor(input, key)!;
      const safeKey = key.length > 256 ? key.slice(0, 256) + truncated : key;
      remaining -= safeKey.length;
      output[safeKey] = 'value' in descriptor ? visit(descriptor.value, depth + 1) : '[Accessor]';
    }
    return output;
  };
  const preview = visit(value, 0);
  const encoded = JSON.stringify(preview);
  return encoded !== undefined && Buffer.byteLength(encoded) > maximumBytes ? truncated : preview;
}

export type TraceLocation = CallerLocation;

/** Capture the caller once; source text is deliberately absent in the first trace phase. */
export function traceStack(): TraceLocation[] {
  return callerLocations().filter(location => !/[\\/](?:flashwright-core|@flashwright[\\/]core)[\\/](?:src|dist)[\\/]|node:|^native$|^internal:/.test(location.file));
}

/** Viewer evaluation fields require protocol envelopes even for bounded summaries. */
export function serializedTracePreview(value: unknown, maximumBytes = 16384): unknown {
  const encode = (preview: unknown): unknown => {
    if (preview === undefined) return { v: 'undefined' };
    if (preview === null) return { v: 'null' };
    if (typeof preview === 'boolean') return { b: preview };
    if (typeof preview === 'string') return { s: preview };
    if (typeof preview === 'number') {
      if (!Number.isFinite(preview)) return { v: String(preview) };
      if (Object.is(preview, -0)) return { v: '-0' };
      return { n: preview };
    }
    if (Array.isArray(preview)) return { a: Array.from({ length: preview.length }, (_, index) => encode(preview[index])) };
    return { o: Object.entries(preview as Record<string, unknown>).map(([key, value]) => ({ k: key, v: encode(value) })) };
  };
  const encoded = encode(tracePreview(value, maximumBytes, true));
  return Buffer.byteLength(JSON.stringify(encoded)) > maximumBytes ? { s: truncated } : encoded;
}

export function traceError(error: unknown): { name: string; message: string; stack?: string } {
  if (!error || typeof error !== 'object' || types.isProxy(error)) return { name: 'Error', message: String(tracePreview(error, 16384)) };
  const read = (name: string, maximumCharacters: number): string | undefined => {
    let owner: object | null = error;
    for (let depth = 0; owner && depth < 8; depth++) {
      if (types.isProxy(owner)) return undefined;
      const descriptor = Object.getOwnPropertyDescriptor(owner, name);
      if (descriptor) {
        if (!('value' in descriptor) || typeof descriptor.value !== 'string') return undefined;
        return descriptor.value.length <= maximumCharacters ? descriptor.value : descriptor.value.slice(0, maximumCharacters) + truncated;
      }
      owner = Object.getPrototypeOf(owner);
    }
    return undefined;
  };
  const stack = read('stack', 2048);
  return { name: read('name', 512) ?? 'Error', message: read('message', 2048) ?? '[Thrown object]', ...(stack === undefined ? {} : { stack }) };
}
