import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, constants as filesystemConstants } from 'node:fs';
import { mkdir, open, rename, rm, writeFile, copyFile } from 'node:fs/promises';
import { basename, join, resolve, sep } from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { types } from 'node:util';
import { failure } from '@flashwright/core';
import { currentFiniteTestInfo, type FiniteTestInfo, type SuiteTestResult } from './suite-runtime.js';
import type { PlannedTest } from './suite-collector.js';
import type { IndependentConfig } from './config.js';
import { buildFailureContext, maximumFailureContextDiagnosticCharacters, maximumFailureContextErrors, type FailureContextError } from '../failure-context-format.js';
import { runIndependentTraceStep } from './tracing.js';

export interface IndependentAttachment { name: string; path: string; contentType: string }
export interface IndependentStep { title: string; started: number; duration: number; status: 'running' | 'passed' | 'failed'; parent: number | null; error?: string }
export interface IndependentTestInfo extends FiniteTestInfo {
  readonly outputDir: string;
  readonly line: number;
  readonly column: number;
  readonly titlePath: readonly string[];
  readonly project: IndependentConfig & { readonly name: string };
  readonly annotations: { type: string; description?: string }[];
  readonly attachments: IndependentAttachment[];
  outputPath(...segments: string[]): string;
  attach(name: string, options: { body?: string | Buffer; path?: string; contentType?: string }): Promise<void>;
}
interface AttemptOutput { info: IndependentTestInfo; open: boolean; pending: Set<Promise<void>>; errors: unknown[]; steps: IndependentStep[] }
const outputs = new WeakMap<FiniteTestInfo, AttemptOutput>();
const byId = new Map<string, AttemptOutput>();
const stepScope = new AsyncLocalStorage<{ owner: AttemptOutput; index: number }>();
const nativeStackGetter = Object.getOwnPropertyDescriptor(new Error(), 'stack')?.get;
export function currentIndependentInfo(): IndependentTestInfo {
  const output = outputs.get(currentFiniteTestInfo());
  if (!output?.open) throw failure('InvalidArgumentError', 'test.info', 'independent attempt output scope has ended');
  return output.info;
}
export function beginOutput(test: PlannedTest, info: FiniteTestInfo, root: string, project?: IndependentConfig & { readonly name: string }): void {
  const outputDir = join(root, createHash('sha256').update(test.id).digest('hex').slice(0, 20) + '-retry' + info.retry);
  const outputPath = (...segments: string[]): string => {
    const target = resolve(outputDir, ...segments);
    if (target !== outputDir && !target.startsWith(outputDir + sep)) throw failure('InvalidArgumentError', 'testInfo.outputPath', 'path must remain inside the original attempt directory');
    mkdirSync(outputDir, { recursive: true });
    return target;
  };
  const attachments: IndependentAttachment[] = [];
  const enriched = Object.assign(info, { outputDir, line: test.location?.line ?? 0, column: test.location?.column ?? 0, titlePath: test.titlePath, project: project!, annotations: [] as { type: string; description?: string }[], attachments, outputPath, attach });
  const output: AttemptOutput = { info: enriched, open: true, pending: new Set(), errors: [], steps: [] };
  outputs.set(info, output); byId.set(test.id, output);
  function attach(name: string, options: { body?: string | Buffer; path?: string; contentType?: string }): Promise<void> {
    if (!output.open || currentFiniteTestInfo() !== info) return Promise.reject(failure('InvalidArgumentError', 'testInfo.attach', 'attachment belongs to an inactive attempt'));
    if (typeof name !== 'string' || !options || (options.body === undefined) === (options.path === undefined)) return Promise.reject(failure('InvalidArgumentError', 'testInfo.attach', 'provide exactly one body or path'));
    const body = typeof options.body === 'string' ? Buffer.from(options.body) : options.body === undefined ? undefined : Buffer.from(options.body);
    const source = options.path === undefined ? undefined : resolve(options.path);
    const target = outputPath('attachments', randomUUID() + (source ? '-' + basename(source) : '.bin'));
    const operation = (async () => {
      await mkdir(join(outputDir, 'attachments'), { recursive: true });
      if (source) await copyFile(source, target); else await writeFile(target, body!, { flag: 'wx' });
      attachments.push({ name, path: target, contentType: options.contentType ?? (typeof options.body === 'string' ? 'text/plain' : 'application/octet-stream') });
    })();
    output.pending.add(operation);
    void operation.then(() => output.pending.delete(operation), error => { output.errors.push(error); output.pending.delete(operation); });
    return operation;
  }
}
export async function independentStep<T>(title: string, callback: () => Promise<T> | T, ...options: unknown[]): Promise<T> {
  if (options.some(option => option !== undefined)) throw failure('UnsupportedFeatureError', 'test.step.options', 'step options are not integrated with the independent runner');
  const info = currentIndependentInfo(), owner = outputs.get(info)!;
  const parent = stepScope.getStore();
  const step: IndependentStep = { title, started: performance.now(), duration: 0, status: 'running', parent: parent?.owner === owner ? parent.index : null };
  const index = owner.steps.push(step) - 1;
  try { const value = await runIndependentTraceStep(info, title, () => stepScope.run({ owner, index }, callback)); step.status = 'passed'; return value; }
  catch (error) {
    step.status = 'failed';
    const details = failureDetails(error);
    step.error = details.stack?.split('\n', 1)[0] ?? details.message ?? 'Step failed.';
    throw error;
  }
  finally { step.duration = performance.now() - step.started; }
}

function data(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}
function diagnostic(value: unknown): string | undefined {
  return typeof value === 'string' ? value.slice(0, maximumFailureContextDiagnosticCharacters + 1) : undefined;
}
/** Retain original error data without custom getters, coercions or serialization hooks. */
function failureDetails(error: unknown): FailureContextError {
  if (typeof error === 'string') return { message: diagnostic(error) };
  if (typeof error === 'bigint') return { message: 'A BigInt value was thrown; numeric expansion was omitted.' };
  if (typeof error === 'symbol') return { message: `Symbol(${diagnostic(error.description) ?? ''})` };
  if (typeof error === 'function') return { message: 'A function was thrown; diagnostic coercion was omitted.' };
  if (!error || typeof error !== 'object') return { message: String(error) };
  if (types.isProxy(error)) return { message: 'A proxy value was thrown; diagnostic access was omitted.' };
  const message = diagnostic(data(error, 'message'));
  let stack = diagnostic(data(error, 'stack'));
  if (stack === undefined && types.isNativeError(error) && nativeStackGetter && Object.getOwnPropertyDescriptor(error, 'stack')?.get === nativeStackGetter) {
    // V8 can materialize native stacks lazily; formatter failures must preserve the data message.
    try { stack = diagnostic((error as Error).stack); } catch {}
  }
  const matcher = data(error, 'matcherResult');
  const errorContext = matcher && typeof matcher === 'object' && !types.isProxy(matcher) ? diagnostic(data(matcher, 'ariaSnapshot')) : undefined;
  return { message: message ?? stack ?? 'A non-error object was thrown; no data message was available.', stack, errorContext };
}

/** A user attachment with the fallback name cannot cause an unbounded read or block on a FIFO. */
async function readSnapshot(path: string): Promise<string | undefined> {
  const file = await open(path, filesystemConstants.O_RDONLY | filesystemConstants.O_NONBLOCK);
  try {
    if (!(await file.stat()).isFile()) return undefined;
    const buffer = Buffer.alloc((maximumFailureContextDiagnosticCharacters + 1) * 3);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    return buffer.subarray(0, length).toString('utf8').slice(0, maximumFailureContextDiagnosticCharacters + 1);
  } finally { await file.close(); }
}

async function publishDocument(path: string, body: string): Promise<void> {
  const temporary = path + '.' + randomUUID() + '.tmp';
  try { await writeFile(temporary, body, { flag: 'wx' }); await rename(temporary, path); }
  finally { await rm(temporary, { force: true }); }
}

export async function finishOutput(result: SuiteTestResult, finalize?: (info: IndependentTestInfo) => Promise<void>): Promise<void> {
  const owner = byId.get(result.test.id);
  if (!owner) throw new Error('Missing original attempt output');
  owner.open = false;
  await Promise.allSettled([...owner.pending]);
  const retainedErrors = result.errors.slice(0, maximumFailureContextErrors).map(entry => ({ phase: entry.phase, ...failureDetails(entry.error) }));
  const omittedErrors = Math.max(0, result.errors.length - retainedErrors.length);
  const diagnosticErrors: string[] = [];
  const location = result.test.location ?? { file: result.test.file, line: 0, column: 0 };
  const record = { id: result.test.id, retry: owner.info.retry, location, errors: retainedErrors, omittedErrors, annotations: owner.info.annotations, attachments: owner.info.attachments, steps: owner.steps, attachmentErrors: owner.errors.map(error => failureDetails(error).message), failureContextErrors: diagnosticErrors };
  await mkdir(owner.info.outputDir, { recursive: true });
  if (result.errors.length) {
    try {
      const errors: FailureContextError[] = [...retainedErrors];
      // Keep the pinned last-meaningful-error frame even when earlier details exhaust the display allowance.
      if (omittedErrors) {
        for (let index = result.errors.length - 1; index >= retainedErrors.length; index--) {
          const details = failureDetails(result.errors[index]!.error);
          if (details.message) { errors.push(details); break; }
        }
      }
      const attachment = owner.info.attachments.find(a => a.name === 'page-snapshot');
      let pageSnapshot: string | undefined;
      if (attachment && !errors.some(error => error.errorContext)) {
        try { pageSnapshot = await readSnapshot(attachment.path); }
        catch (error) { diagnosticErrors.push(failureDetails(error).message ?? 'Page snapshot read failed.'); }
      }
      const document = await buildFailureContext({ titlePath: [...result.test.titlePath], location, errors, pageSnapshot });
      if (document) {
        const path = owner.info.outputPath('error-context.md');
        await publishDocument(path, document);
        record.attachments.push({ name: 'error-context', path, contentType: 'text/markdown' });
      }
    } catch (error) { diagnosticErrors.push(failureDetails(error).message ?? 'Failure context publication failed.'); }
  }
  await finalize?.(owner.info);
  await writeFile(owner.info.outputPath('attempt.json'), JSON.stringify(record, null, 2), { flag: 'wx' });
  byId.delete(result.test.id);
  if (owner.errors.length) throw new AggregateError(owner.errors, 'Attachment publication failed');
}
