import { types } from 'node:util';
import { failure } from './errors.js';

export const maximumRunnerRecordBytes = 256 * 1024;

export function runnerTraceLimit(message: string): Error { return failure('ResourceLimitError', 'runner.tracing', message); }
export function runnerTraceInvalid(message: string): Error { return failure('ProtocolError', 'runner.tracing', message); }

/** Trace-only reads must never execute a caller's getter or proxy trap. */
export function runnerTraceField(value: unknown, name: string): unknown {
  if (!value || typeof value !== 'object' || types.isProxy(value)) throw runnerTraceInvalid('expected an ordinary trace record');
  const descriptor = Object.getOwnPropertyDescriptor(value, name);
  if (!descriptor) return undefined;
  if (!('value' in descriptor)) throw runnerTraceInvalid('trace metadata contains an accessor');
  return descriptor.value;
}

/** Measure escaped JSON text before allocating its encoded representation. */
function stringBytes(value: string, allowance: number): number {
  if (value.length + 2 > allowance) throw runnerTraceLimit('runner trace record exceeds 256 KiB');
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
    if (bytes > allowance) throw runnerTraceLimit('runner trace record exceeds 256 KiB');
  }
  return bytes;
}

/** Snapshot normalized runner metadata, bounding copies before JSON can invoke serialization. */
export function snapshotRunnerRecord(event: unknown): Record<string, unknown> {
  let remaining = maximumRunnerRecordBytes - 1;
  let values = 0;
  const ancestors = new Set<object>();
  const reserve = (bytes: number): void => {
    remaining -= bytes;
    if (remaining < 0) throw runnerTraceLimit('runner trace record exceeds 256 KiB');
  };
  const visit = (value: unknown, depth: number): unknown => {
    if (++values > 10000 || depth > 32) throw runnerTraceLimit('runner trace metadata exceeds its value or depth limit');
    if (value === undefined) return undefined;
    if (typeof value === 'string') { reserve(stringBytes(value, remaining)); return value; }
    if (value === null) { reserve(4); return null; }
    if (typeof value === 'boolean') { reserve(value ? 4 : 5); return value; }
    if (typeof value === 'number' && Number.isFinite(value)) { reserve(String(value).length); return value; }
    if (typeof value !== 'object' || value === null || types.isProxy(value)) throw runnerTraceInvalid('runner trace metadata must contain JSON data');
    if (ancestors.has(value)) throw runnerTraceInvalid('runner trace metadata contains a cycle');
    ancestors.add(value);
    reserve(2);
    let result: unknown;
    if (Array.isArray(value)) {
      const length = runnerTraceField(value, 'length') as number;
      if (length > 10000) throw runnerTraceLimit('runner trace array exceeds 10000 values');
      const array: unknown[] = [];
      Object.setPrototypeOf(array, null);
      for (let index = 0; index < length; index++) {
        if (index) reserve(1);
        const item = runnerTraceField(value, String(index));
        array[index] = item === undefined ? (visit(undefined, depth + 1), reserve(4), null) : visit(item, depth + 1);
      }
      result = array;
    } else {
      if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw runnerTraceInvalid('runner trace metadata contains a non-plain object');
      const object: Record<string, unknown> = Object.create(null);
      let count = 0;
      let written = 0;
      for (const name in value) {
        if (!Object.hasOwn(value, name)) continue;
        if (++count > 10000) throw runnerTraceLimit('runner trace object exceeds 10000 fields');
        const item = runnerTraceField(value, name);
        if (item === undefined) { visit(undefined, depth + 1); continue; }
        if (written++) reserve(1);
        reserve(stringBytes(name, remaining) + 1);
        object[name] = visit(item, depth + 1);
      }
      result = object;
    }
    ancestors.delete(value);
    return result;
  };
  const snapshot = visit(event, 0);
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) throw runnerTraceInvalid('expected one runner trace record');
  return snapshot as Record<string, unknown>;
}

export function encodeRunnerRecord(record: Record<string, unknown>): Buffer {
  const text = JSON.stringify(record) + '\n';
  if (Buffer.byteLength(text) > maximumRunnerRecordBytes) throw runnerTraceLimit('runner trace record exceeds 256 KiB');
  return Buffer.from(text);
}

/** Match ordinary pinned parameter previews with bounded traversal and no caller code execution. */
export function runnerTraceParameters(parameters: unknown): Record<string, string> {
  const output: Record<string, string> = Object.create(null);
  if (parameters === undefined || parameters === null) return output;
  if (typeof parameters !== 'object' || types.isProxy(parameters) || ![Object.prototype, null].includes(Object.getPrototypeOf(parameters))) throw runnerTraceInvalid('runner parameters must be ordinary data properties');
  let remaining = 5000;
  let values = 0;
  const text = (value: string): string => {
    const length = Math.min(value.length, Math.max(0, remaining));
    remaining -= length;
    return length === value.length ? value : value.slice(0, length) + '[Truncated]';
  };
  const preview = (value: unknown, visited: Set<unknown>, depth: number): string => {
    if (remaining <= 0 || ++values > 1000 || depth > 8) return '[Truncated]';
    if (visited.has(value)) return '';
    visited.add(value);
    remaining -= 16;
    if (typeof value === 'string') return text(value);
    if (typeof value === 'number' || typeof value === 'boolean' || value === null || value === undefined) return text(String(value));
    if (typeof value === 'bigint') return text(value > 10n ** 1000n || value < -(10n ** 1000n) ? '[BigInt]' : String(value));
    if (typeof value === 'symbol') return '[Symbol]';
    if (types.isProxy(value)) return '[Proxy]';
    if (typeof value === 'function') return '[Function]';
    if (!Array.isArray(value)) return 'Object';
    const length = runnerTraceField(value, 'length') as number;
    const parts: string[] = [];
    let index = 0;
    for (; index < Math.min(length, 100) && remaining > 0; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      parts.push(!descriptor ? '' : 'value' in descriptor ? preview(descriptor.value, visited, depth + 1) : '[Accessor]');
    }
    if (index < length) parts.push('[Truncated]');
    return '[' + parts.join(', ') + ']';
  };
  let count = 0;
  for (const name in parameters) {
    if (!Object.hasOwn(parameters, name)) continue;
    if (++count > 100 || name.length > 256) throw runnerTraceLimit('runner parameter names exceed their count or length limit');
    remaining -= name.length;
    const descriptor = Object.getOwnPropertyDescriptor(parameters, name)!;
    output[name] = 'value' in descriptor ? preview(descriptor.value, new Set(), 0) : '[Accessor]';
  }
  return output;
}

/** Error formatting has a separate bounded traversal before string concatenation or stack parsing. */
export function runnerTraceErrorMessage(error: unknown): string {
  let remaining = 32768;
  const seen = new Set<unknown>();
  const parts: string[] = [];
  for (let depth = 0; error; depth++) {
    if (depth >= 16 || seen.has(error)) throw runnerTraceLimit('runner error cause chain exceeds its depth or repeats');
    seen.add(error);
    const message = runnerTraceField(error, 'message');
    const value = runnerTraceField(error, 'value');
    if (message !== undefined && typeof message !== 'string' || value !== undefined && typeof value !== 'string') throw runnerTraceInvalid('runner error message and value must be strings');
    const text = message || String(value);
    if (text.length + (depth ? 10 : 0) > remaining) throw runnerTraceLimit('runner error message exceeds 32768 characters');
    remaining -= text.length + (depth ? 10 : 0);
    parts.push((depth ? '[cause]: ' : '') + text);
    error = runnerTraceField(error, 'cause');
  }
  return parts.join('\n');
}
