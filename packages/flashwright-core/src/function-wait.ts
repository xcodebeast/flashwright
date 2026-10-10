import { failure } from './errors.js';
import { validateOptions } from './validation.js';
import { validateTimeout } from './waits.js';

export interface PageWaitForFunctionOptions {
  polling?: number | 'raf';
  timeout?: number;
}

interface PreparedFunctionWait { source: number[]; isFunction: boolean; polling: number | null }
const normalizedArguments = new WeakMap<object, { pageFunction: string | Function; prepared: PreparedFunctionWait }>();

/** Invalid options and source must fail before trace capture or frame ownership lookup. */
export function prepareFunctionWaitArguments(arguments_: readonly unknown[]): unknown[] {
  const [pageFunction, argument, suppliedOptions = {}] = arguments_;
  if (suppliedOptions && typeof suppliedOptions === 'object' && normalizedArguments.get(suppliedOptions)?.pageFunction === pageFunction) return [...arguments_];
  const method = 'frame.waitForFunction';
  validateOptions(method, suppliedOptions as object, ['polling', 'timeout']);
  const options = suppliedOptions as PageWaitForFunctionOptions;
  const polling = options.polling;
  const timeout = options.timeout;
  const normalized: PageWaitForFunctionOptions = Object.freeze({ ...(polling === undefined ? {} : { polling }), ...(timeout === undefined ? {} : { timeout }) });
  if (normalized.timeout !== undefined) validateTimeout(normalized.timeout, method);
  const prepared = prepareFunctionWait(method, pageFunction as string | Function, normalized);
  normalizedArguments.set(normalized, { pageFunction: pageFunction as string | Function, prepared });
  return [pageFunction, argument, normalized];
}

/** Normalize function syntax before allocation without executing the caller's predicate. */
export function prepareFunctionWait(method: string, pageFunction: string | Function, options: PageWaitForFunctionOptions): PreparedFunctionWait {
  const cached = normalizedArguments.get(options);
  if (cached && cached.pageFunction === pageFunction) return cached.prepared;
  validateOptions(method, options, ['polling', 'timeout']);
  const polling = options.polling;
  if (polling !== undefined && polling !== 'raf' && (typeof polling !== 'number' || !Number.isFinite(polling) || polling <= 0)) {
    throw failure('InvalidArgumentError', method, 'polling must be raf or a finite positive interval in milliseconds');
  }
  if (typeof pageFunction !== 'string' && typeof pageFunction !== 'function') {
    throw failure('InvalidArgumentError', method, 'expected a function or JavaScript expression string');
  }
  let source = String(pageFunction).trim();
  if (source.length > 100000) throw failure('ResourceLimitError', method, 'predicate source exceeds 100000 UTF-16 units');
  if (typeof pageFunction === 'function') {
    try { new Function(`(${source})`); }
    catch {
      source = source.startsWith('async ') ? `async function ${source.slice(6)}` : `function ${source}`;
      try { new Function(`(${source})`); }
      catch { throw failure('InvalidArgumentError', method, 'passed function is not well-serializable'); }
    }
  }
  if (/^(async)?\s*function(\s|\()/.test(source)) source = `(${source})`;
  if (source.length > 100000) throw failure('ResourceLimitError', method, 'normalized predicate source exceeds 100000 UTF-16 units');
  return { source: Array.from({ length: source.length }, (_, index) => source.charCodeAt(index)), isFunction: typeof pageFunction === 'function', polling: typeof polling === 'number' ? polling : null };
}
