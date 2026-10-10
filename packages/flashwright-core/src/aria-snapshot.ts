import { failure } from './errors.js';
import { validateBoolean, validateOptions } from './validation.js';

export interface AriaSnapshotOptions {
  mode?: 'default' | 'ai';
  depth?: number;
  boxes?: boolean;
  timeout?: number;
}

/** Capture application getters once, before trace hooks can request browser diagnostics. */
export function normalizeAriaSnapshotOptions(options: AriaSnapshotOptions): AriaSnapshotOptions {
  const method = 'aria.snapshot';
  validateOptions(method, options, ['mode', 'depth', 'boxes', 'timeout']);
  const { mode, depth, boxes, timeout } = options;
  if (mode !== undefined && mode !== 'default' && mode !== 'ai')
    throw failure('InvalidArgumentError', method, 'mode must be default or ai');
  if (mode === 'ai') throw failure('UnsupportedFeatureError', method, 'AI snapshots are not implemented');
  if (depth !== undefined && !Number.isInteger(depth))
    throw failure('InvalidArgumentError', method, 'depth must be an integer');
  validateBoolean(`${method}.boxes`, boxes);
  if (timeout !== undefined && (!Number.isFinite(timeout) || timeout < 0))
    throw failure('InvalidArgumentError', method, 'timeout must be a finite nonnegative number');
  return { ...(mode === undefined ? {} : { mode }), ...(depth === undefined ? {} : { depth }),
    ...(boxes === undefined ? {} : { boxes }), ...(timeout === undefined ? {} : { timeout }) };
}

export function prepareAriaSnapshotArguments(arguments_: readonly unknown[]): unknown[] {
  return [normalizeAriaSnapshotOptions((arguments_[0] === undefined ? {} : arguments_[0]) as AriaSnapshotOptions)];
}

export function prepareAriaSnapshot(selector: string | null, options: AriaSnapshotOptions): number[] {
  const method = 'aria.snapshot';
  const { depth, boxes } = normalizeAriaSnapshotOptions(options);
  const request = JSON.stringify({ selector, mode: 'default', depth, boxes });
  if (request.length > 100000) throw failure('ResourceLimitError', method, 'snapshot request exceeds 100000 UTF-16 units');
  return Array.from({ length: request.length }, (_, index) => request.charCodeAt(index));
}
