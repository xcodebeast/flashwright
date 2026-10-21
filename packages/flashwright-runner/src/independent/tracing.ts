import { writeFile } from 'node:fs/promises';
import { AsyncLocalStorage } from 'node:async_hooks';
import { runnerIntegration } from '@flashwright/core/runner-integration';
import { failure } from '@flashwright/core';
import { validateTracePolicy } from '../trace-policy.js';
import { parseFailureContextLocation } from '../failure-context-format.js';
import type { IndependentTestInfo } from './output.js';
import { currentFiniteTestInfo, type FiniteTestInfo, type SuiteTestResult } from './suite-runtime.js';
import type { PlannedTest } from './suite-collector.js';

export type IndependentTraceMode = 'off' | 'on' | 'retain-on-failure' | 'on-first-retry' | 'on-all-retries' | 'retain-on-first-failure' | 'retain-on-failure-and-retries' | 'retry-with-trace';
export type IndependentTracePolicy = IndependentTraceMode | { mode?: IndependentTraceMode; screenshots?: boolean; snapshots?: boolean; sources?: boolean; attachments?: boolean; live?: false };
type Journal = ReturnType<typeof runnerIntegration.beginTraceJournal>;
type Startup = ReturnType<typeof runnerIntegration.beginTraceRecordingWithActions>;
type Started = Awaited<Startup['ready']>;
type Archive = Awaited<ReturnType<Started['chunk']['takeArchive']>>;
type Observer = Parameters<typeof runnerIntegration.installActionObserver>[1];
type Registration = ReturnType<typeof runnerIntegration.installArtifactContextLifecycle>;
interface TraceOptions { mode: IndependentTraceMode; screenshots: boolean; snapshots: boolean; sources: boolean; attachments: boolean }
const attempts = new WeakMap<FiniteTestInfo, IndependentTraceAttempt>();
const stepScope = new AsyncLocalStorage<{ attempt: IndependentTraceAttempt; stepId: string }>();

export async function runIndependentTraceStep<T>(info: FiniteTestInfo, title: string, callback: () => Promise<T> | T): Promise<T> {
  const attempt = attempts.get(info);
  return attempt ? attempt.step(title, callback) : callback();
}

export function independentTraceOptions(value: unknown, retry: number): TraceOptions | undefined {
  validateTracePolicy(value);
  const options = { mode: 'off' as IndependentTraceMode, screenshots: true, snapshots: true, sources: true, attachments: true, ...(typeof value === 'string' ? { mode: value as IndependentTraceMode } : value as object) };
  if (options.mode === 'retry-with-trace') options.mode = 'on-first-retry';
  const capture = options.mode === 'on' || options.mode === 'retain-on-failure' || options.mode === 'retain-on-failure-and-retries' ||
    options.mode === 'on-first-retry' && retry === 1 || options.mode === 'on-all-retries' && retry > 0 || options.mode === 'retain-on-first-failure' && retry === 0;
  return capture ? options : undefined;
}

export function validateIndependentTrace(test: PlannedTest): void {
  const value = test.pool.resolve('trace')?.value ?? 'off';
  if (typeof value === 'function') throw failure('UnsupportedFeatureError', 'independent.use.trace', 'trace must be a declarative option so capture can begin before worker fixtures');
  independentTraceOptions(value, 0);
}

/** Policy admission precedes worker fixtures, hooks and context creation. Off allocates no journal. */
export async function beginIndependentTrace(test: PlannedTest, info: FiniteTestInfo): Promise<void> {
  const options = independentTraceOptions(test.pool.resolve('trace')?.value ?? 'off', info.retry);
  if (!options) return;
  const attempt = new IndependentTraceAttempt(info, options);
  attempts.set(info, attempt);
  await attempt.start();
}

export async function finishIndependentTrace(result: SuiteTestResult, info: IndependentTestInfo): Promise<void> {
  const attempt = attempts.get(info);
  if (!attempt) return;
  try { await attempt.finish(result, info); }
  finally { attempts.delete(info); }
}

/** One native creation and all of its cleanup remain attached to the admitting attempt. */
class Capture {
  private readonly startup: Startup;
  private started: Started | undefined;
  private archive: Archive | undefined;
  private sealing: Promise<void> | undefined;
  private readonly ready: Promise<void>;
  constructor(private readonly owner: IndependentTraceAttempt, private readonly tracing: object) {
    this.startup = runnerIntegration.beginTraceRecordingWithActions(11, tracing, { screenshots: owner.options.screenshots, snapshots: owner.options.snapshots, sources: false }, owner.observer);
    this.ready = this.startup.ready.then(started => { this.started = started; }, error => owner.fail(error));
  }
  async prepare(): Promise<void> { await this.ready; }
  seal(): Promise<void> {
    this.sealing ??= (async () => {
      await this.ready;
      if (!this.started) return;
      try { this.archive = await this.started.chunk.takeArchive(this.owner.signal); }
      catch (error) {
        this.owner.fail(error);
        try { await runnerIntegration.discardTraceChunk(11, this.tracing, this.started.chunk); } catch (cleanup) { this.owner.fail(cleanup); }
      }
      finally { try { await this.started.stop(); } catch (error) { this.owner.fail(error); } }
    })();
    return this.sealing;
  }
  transfer(assembly: ReturnType<typeof runnerIntegration.createTraceArchiveAssembly>): void {
    if (!this.archive) return;
    assembly.addLibrary(this.archive);
    this.archive = undefined;
  }
  async dispose(): Promise<void> {
    await this.seal();
    try { await this.archive?.dispose(); }
    finally { await this.startup.cleanup; }
  }
}

class IndependentTraceAttempt {
  readonly journal: Journal;
  readonly observer: Observer;
  private accepting = true;
  private actionOrdinal = 0;
  private readonly captures: Capture[] = [];
  private readonly byContext = new WeakMap<object, Capture>();
  private readonly errors: unknown[] = [];
  private readonly registrations: Registration[] = [];
  private restoreActions: (() => void) | undefined;
  private enrollingExisting = false;
  private finalSignal: AbortSignal | undefined;
  get signal(): AbortSignal | undefined { return this.finalSignal; }

  constructor(private readonly info: FiniteTestInfo, readonly options: TraceOptions) {
    this.journal = runnerIntegration.beginTraceJournal(6, {
      version: 8, type: 'context-options', origin: 'testRunner', browserName: '', playwrightVersion: '1.60.0', options: {},
      platform: process.platform, wallTime: Date.now(), monotonicTime: performance.now(), sdkLanguage: 'javascript',
    }, { sources: options.sources, attachments: options.attachments });
    this.observer = { begin: metadata => {
      if (!this.accepting) return undefined;
      try { if (currentFiniteTestInfo() !== this.info) return undefined; } catch { return undefined; }
      const stepId = `independent-api@${++this.actionOrdinal}`;
      const parent = stepScope.getStore();
      this.journal.appendBeforeAction({ stepId, parentId: parent?.attempt === this ? parent.stepId : undefined, category: 'pw:api', title: metadata.apiName, params: metadata.parameters, stack: metadata.stack }, performance.now());
      return { stepId, title: metadata.apiName, complete: error => {
        if (this.accepting) this.journal.appendAfterAction(stepId, error === undefined ? undefined : errorRecord(error), undefined, undefined, performance.now());
      } };
    } };
  }

  fail(error: unknown): void { if (this.errors.length < 16) this.errors.push(error); }

  async step<T>(title: string, callback: () => Promise<T> | T): Promise<T> {
    if (!this.accepting) return callback();
    const stepId = `independent-step@${++this.actionOrdinal}`, parent = stepScope.getStore();
    this.journal.appendBeforeAction({ stepId, parentId: parent?.attempt === this ? parent.stepId : undefined, category: 'test.step', title, stack: [] }, performance.now());
    let error: unknown;
    try { return await stepScope.run({ attempt: this, stepId }, callback); }
    catch (cause) { error = errorRecord(cause); throw cause; }
    finally { if (this.accepting) this.journal.appendAfterAction(stepId, error, undefined, undefined, performance.now()); }
  }

  private async capture(context: object, tracing: object): Promise<void> {
    if (!this.accepting || this.byContext.has(context)) return;
    try {
      if (this.captures.length >= 128) throw failure('ResourceLimitError', 'independent.trace', 'trace exceeds 128 contexts per attempt');
      const capture = new Capture(this, tracing);
      this.captures.push(capture);
      this.byContext.set(context, capture);
      await capture.prepare();
    } catch (error) { this.fail(error); }
  }

  async start(): Promise<void> {
    try {
      this.restoreActions = runnerIntegration.installActionObserver(2, this.observer);
      this.enrollingExisting = true;
      this.registrations.push(runnerIntegration.installArtifactContextLifecycle(9, {
        beginContextCreation: () => {
          const admitted = this.ownsCreation();
          return { didCreateContext: context => admitted ? this.capture(context, context.tracing) : Promise.resolve(), complete() {} };
        },
        didCreateUnclaimedContext: () => this.fail(failure('UnsupportedFeatureError', 'independent.trace', 'await context creation before starting a test')),
        willCloseContext: async context => { await this.byContext.get(context)?.seal(); },
      }));
      this.registrations.push(runnerIntegration.installArtifactRequestLifecycle(12, {
        beginRequestCreation: () => {
          const admitted = this.ownsCreation();
          return { didCreateContext: context => admitted ? this.capture(context, runnerIntegration.requestTraceOwner(12, context)) : Promise.resolve(), complete() {} };
        },
        didCreateUnclaimedContext: () => this.fail(failure('UnsupportedFeatureError', 'independent.trace', 'await request context creation before starting a test')),
        willDisposeContext: async context => { await this.byContext.get(context)?.seal(); },
        didCloseContext: async context => { await runnerIntegration.settleClosedTraceCleanup(11, runnerIntegration.requestTraceOwner(12, context)); },
      }));
      this.enrollingExisting = false;
      await Promise.all(this.registrations.map(registration => registration.ready));
    } catch (error) { this.fail(error); }
    finally { this.enrollingExisting = false; }
  }

  private ownsCreation(): boolean {
    if (!this.accepting) return false;
    if (this.enrollingExisting) return true;
    try { return currentFiniteTestInfo() === this.info; } catch { return false; }
  }

  async finish(result: SuiteTestResult, info: IndependentTestInfo): Promise<void> {
    this.accepting = false;
    this.restoreActions?.();
    const cancellation = new AbortController();
    const timer = setTimeout(() => cancellation.abort(failure('TimeoutError', 'independent.trace', 'trace finalization exceeded 30 seconds')), 30000);
    this.finalSignal = cancellation.signal;
    const assembly = runnerIntegration.createTraceArchiveAssembly(4);
    let combined: Archive | undefined;
    const keep = shouldRetain(this.options.mode, info.retry, result.status !== result.expectedStatus);
    const settle = async (work: Promise<unknown>): Promise<void> => { try { await work; } catch (error) { this.fail(error); } };
    try {
      await Promise.all(this.registrations.map(registration => settle(registration.dispose())));
      await Promise.all(this.captures.map(capture => settle(capture.seal())));
      if (keep) {
        for (const capture of this.captures) capture.transfer(assembly);
        for (const item of result.errors) this.journal.appendError(errorRecord(item.error), stack => {
          const location = parseFailureContextLocation(stack);
          const frames = location ? [location] : [];
          this.journal.referenceSources(frames);
          return frames;
        });
        this.journal.appendBeforeAction({ stepId: 'independent-artifacts', category: 'hook', title: 'Test artifacts', stack: [] }, performance.now());
        this.journal.appendAfterAction('independent-artifacts', undefined, info.attachments, info.annotations, performance.now());
        const runner = await this.journal.takeArchive(info.timeout, cancellation.signal);
        try { assembly.addRunner(runner); } catch (error) { await runner.dispose(); throw error; }
        if (this.errors.length) throw this.errors[0];
        combined = assembly.seal();
        const path = info.outputPath('trace.zip');
        await combined.export(path, cancellation.signal);
        info.attachments.push({ name: 'trace', path, contentType: 'application/zip' });
      }
    } catch (error) { this.fail(error); }
    finally {
      clearTimeout(timer);
      await settle(combined?.dispose() ?? Promise.resolve());
      await settle(assembly.dispose());
      await Promise.all(this.captures.map(capture => settle(capture.dispose())));
      await settle(this.journal.dispose());
    }
    if (this.errors.length) {
      const path = info.outputPath('trace-error.txt');
      await writeFile(path, this.errors.map(error => errorRecord(error).stack ?? errorRecord(error).message).join('\n\n').slice(0, 65536), { flag: 'wx' });
      info.attachments.push({ name: 'trace-error', path, contentType: 'text/plain' });
    }
  }
}

export function shouldRetain(mode: IndependentTraceMode, retry: number, unexpected: boolean): boolean {
  if (mode === 'retain-on-failure-and-retries') return unexpected || retry > 0;
  return unexpected || mode !== 'retain-on-failure' && mode !== 'retain-on-first-failure';
}

function errorRecord(error: unknown): { message: string; stack?: string } {
  try {
    if (error instanceof Error) return { message: error.message.slice(0, 32768), ...(typeof error.stack === 'string' ? { stack: error.stack.slice(0, 32768) } : {}) };
    return { message: String(error).slice(0, 32768) };
  } catch { return { message: 'Error could not be formatted' }; }
}
