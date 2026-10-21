import { spawn, type ChildProcess } from 'node:child_process';
import { join, resolve } from 'node:path';
import { failure, type ProcessFailure, type ProcessPlan, type ProcessTestResult, type RunRequest } from './process-protocol.js';

export interface ProcessRunnerOptions {
  modulePath: string;
  workers: number;
  retries?: number;
  testWatchdogMs?: number;
  startupTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  killGraceMs?: number;
  env?: NodeJS.ProcessEnv;
}
export interface ProcessWorkerRecord {
  workerIndex: number; parallelIndex: number; pid: number | undefined;
  exitCode: number | null; signal: NodeJS.Signals | null; forcedTermination: boolean;
  stdout: string; stderr: string; outputTruncated: boolean;
}
export interface ProcessSuiteResult {
  status: 'passed' | 'failed'; plan: ProcessPlan | undefined;
  results: ProcessTestResult[]; workerErrors: ProcessFailure[];
  workers: ProcessWorkerRecord[];
}
interface Task { group: number; attempts: { id: string; retry: number }[] }
interface Done { workerStopped: boolean; pending: string[]; skipIds: string[] }
interface Deferred<T> { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void }
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  void promise.catch(() => {});
  return { promise, resolve, reject };
}
function check(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function validatePlan(value: ProcessPlan): void {
  check(value && Array.isArray(value.tests) && Array.isArray(value.groups), 'Invalid worker collection');
  const ids = new Set<string>();
  for (const test of value.tests) {
    check(typeof test.id === 'string' && typeof test.title === 'string' && typeof test.file === 'string' && ['passed', 'failed', 'skipped'].includes(test.expectedStatus) && /^[a-f0-9]{64}$/.test(test.callbackHash), 'Invalid collected test');
    check(!ids.has(test.id), 'Duplicate collected test'); ids.add(test.id);
  }
  const grouped = new Set<string>();
  for (const [index, group] of value.groups.entries()) {
    check(group.id === index && Number.isSafeInteger(group.workerKey) && group.workerKey >= 0 && Array.isArray(group.tests) && group.tests.length, 'Invalid collected group');
    for (const id of group.tests) { check(ids.has(id) && !grouped.has(id), 'Duplicate or unknown grouped test'); grouped.add(id); }
  }
  check(ids.size === grouped.size, 'Collection omitted tests from groups');
}
function unexpected(result: ProcessTestResult): boolean { return result.status !== 'skipped' && result.status !== result.expectedStatus; }
const outputLimit = 1024 * 1024;

class ProcessWorker {
  readonly record: ProcessWorkerRecord;
  readonly ready = deferred<ProcessPlan>();
  readonly exited = deferred<void>();
  readonly child: ChildProcess;
  readonly options: Required<Omit<ProcessRunnerOptions, 'env'>>;
  plan: ProcessPlan | undefined;
  workerKey: number | undefined;
  active: { id: string; retry: number } | undefined;
  runResults: ProcessTestResult[] = [];
  watchdogExpired = false;
  #pending: { token: number; task: Task; done: Deferred<Done> } | undefined;
  #closed = deferred<ProcessFailure[]>();
  #hasClosed = false;
  #ended = false;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #termination: Promise<void> | undefined;
  #fatal: unknown;
  #failureAccounted = false;
  #sequence = 0;
  #closePromise: Promise<ProcessFailure[]> | undefined;

  constructor(options: Required<Omit<ProcessRunnerOptions, 'env'>>, env: NodeJS.ProcessEnv, workerIndex: number, parallelIndex: number) {
    this.options = options;
    this.record = { workerIndex, parallelIndex, pid: undefined, exitCode: null, signal: null, forcedTermination: false, stdout: '', stderr: '', outputTruncated: false };
    this.child = spawn(process.execPath, [join(__dirname, 'process-worker.js'), options.modulePath, String(options.workers), String(workerIndex), String(parallelIndex)], {
      detached: true, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    this.record.pid = this.child.pid;
    for (const key of ['stdout', 'stderr'] as const) this.child[key]!.on('data', (bytes: Buffer) => {
      this.record[key] += bytes.toString();
      if (this.record[key].length > outputLimit) { this.record[key] = this.record[key].slice(-outputLimit); this.record.outputTruncated = true; }
    });
    this.child.on('message', message => { try { this.message(message); } catch (error) { this.fail(error); } });
    this.child.once('error', error => this.fail(error));
    this.child.once('close', (code, signal) => {
      this.#ended = true; clearTimeout(this.#timer);
      this.record.exitCode = code; this.record.signal = signal;
      const error = this.#fatal ?? new Error(`Worker ${workerIndex} exited before completing its command (${code ?? signal})`);
      if (!this.#hasClosed || code !== 0 || signal !== null) { this.#fatal ??= error; this.terminate(); }
      this.ready.reject(error); this.#pending?.done.reject(error);
      if (!this.#hasClosed) this.#closed.reject(error);
      this.exited.resolve();
    });
    this.arm(options.startupTimeoutMs, 'Worker collection timed out');
  }
  private arm(ms: number, reason: string): void {
    clearTimeout(this.#timer);
    if (ms) this.#timer = setTimeout(() => { this.watchdogExpired = true; this.fail(new Error(reason)); }, ms);
  }
  private fail(error: unknown): void {
    this.#fatal ??= error;
    this.ready.reject(error); this.#pending?.done.reject(error); this.#closed.reject(error);
    this.terminate();
  }
  private signal(signal: NodeJS.Signals): void {
    if (!this.child.pid) return;
    try { process.kill(-this.child.pid, signal); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') this.#fatal ??= error; }
  }
  private terminate(): void {
    if (this.#termination) return;
    this.record.forcedTermination = true;
    clearTimeout(this.#timer); this.signal('SIGTERM');
    // The leader can exit while a TERM-resistant descendant still owns this
    // process group. Retain escalation even after observing the leader's close.
    this.#termination = new Promise(resolve => setTimeout(() => { this.signal('SIGKILL'); resolve(); }, this.options.killGraceMs));
  }
  // IPC is private to the runner, but contradictory receipts must still fail
  // instead of silently omitting an attempt or accepting duplicate completion.
  private message(message: unknown): void {
    const value = message as Record<string, any>;
    check(value && typeof value === 'object', 'Invalid worker message');
    if (value.type === 'ready') {
      check(!this.plan, 'Duplicate worker collection'); validatePlan(value.plan);
      this.plan = value.plan; clearTimeout(this.#timer); this.ready.resolve(value.plan); return;
    }
    if (value.type === 'fatal') { this.fail(new Error(String(value.error?.message ?? 'Worker failed'))); return; }
    if (value.type === 'closed') {
      check(this.#closePromise && !this.#pending && !this.#hasClosed && Array.isArray(value.errors), 'Unexpected worker shutdown receipt');
      this.#hasClosed = true; this.#closed.resolve(value.errors); return;
    }
    const pending = this.#pending;
    check(pending && value.token === pending.token, 'Stale worker command receipt');
    if (value.type === 'begin') {
      check(!this.active && pending.task.attempts.some(a => a.id === value.id && a.retry === value.retry) && !this.runResults.some(r => r.id === value.id), 'Invalid test start receipt');
      this.active = { id: value.id, retry: value.retry };
      this.arm(this.options.testWatchdogMs, `Worker watchdog exceeded ${this.options.testWatchdogMs} ms for ${value.id}`); return;
    }
    if (value.type === 'result') {
      const result = value.result as ProcessTestResult;
      const planned = this.plan!.tests.find(t => t.id === result?.id);
      check(this.active && result.id === this.active.id && result.retry === this.active.retry && planned && result.expectedStatus === planned.expectedStatus && result.workerIndex === this.record.workerIndex && result.parallelIndex === this.record.parallelIndex && ['passed', 'failed', 'skipped'].includes(result.status) && Array.isArray(result.errors) && Number.isFinite(result.duration), 'Invalid test result receipt');
      this.runResults.push(result); this.active = undefined;
      this.arm(this.options.testWatchdogMs, 'Worker stalled between test results'); return;
    }
    if (value.type === 'done') {
      check(!this.active && typeof value.workerStopped === 'boolean' && Array.isArray(value.pending) && Array.isArray(value.skipIds), 'Invalid group completion');
      const missing = pending.task.attempts.filter(a => !this.runResults.some(r => r.id === a.id)).map(a => a.id).sort();
      check(JSON.stringify([...value.pending].sort()) === JSON.stringify(missing), 'Group completion omitted or duplicated pending tests');
      check(!value.pending.length || value.workerStopped, 'Successful group omitted tests');
      check(new Set(value.skipIds).size === value.skipIds.length && value.skipIds.every((id: string) => missing.includes(id)), 'Invalid setup skip list');
      clearTimeout(this.#timer); pending.done.resolve(value as unknown as Done); return;
    }
    throw new Error('Unknown worker receipt');
  }
  async run(task: Task): Promise<Done> {
    check(!this.#pending && !this.#fatal && !this.#ended && !this.#closePromise, 'Worker cannot accept a group');
    this.active = undefined; this.runResults = []; this.watchdogExpired = false;
    const token = ++this.#sequence, done = deferred<Done>();
    this.#pending = { token, task, done };
    this.arm(this.options.testWatchdogMs, 'Worker did not start its group');
    const command: RunRequest = { type: 'run', token, ...task };
    this.child.send(command, error => { if (error) this.fail(error); });
    try { return await done.promise; }
    catch (error) { this.#failureAccounted = true; throw error; }
    finally { clearTimeout(this.#timer); this.#pending = undefined; }
  }
  close(): Promise<ProcessFailure[]> {
    if (!this.#closePromise) this.#closePromise = this.finish();
    return this.#closePromise;
  }
  private async finish(): Promise<ProcessFailure[]> {
    let errors: ProcessFailure[] = [];
    if (this.#fatal || this.#ended) this.terminate();
    else {
      this.arm(this.options.shutdownTimeoutMs, 'Worker shutdown timed out');
      this.child.send({ type: 'close' }, error => { if (error) this.fail(error); });
      try { errors = await this.#closed.promise; }
      catch (error) { this.#fatal ??= error; }
    }
    await this.exited.promise;
    await this.#termination;
    if (this.#fatal && !this.#failureAccounted) errors.push(failure(this.#fatal, 'workerShutdown'));
    return errors;
  }
}

/** Internal Unix process dispatcher. Watchdog termination is a liveness guard,
 * not compatible Playwright test-timeout cleanup or descendant-exit admission. */
export async function runProcessSuite(input: ProcessRunnerOptions): Promise<ProcessSuiteResult> {
  check(process.platform !== 'win32', 'Independent process runner currently requires Unix process groups');
  const options = { modulePath: resolve(input.modulePath), workers: input.workers, retries: input.retries ?? 0, testWatchdogMs: input.testWatchdogMs ?? 30000, startupTimeoutMs: input.startupTimeoutMs ?? 30000, shutdownTimeoutMs: input.shutdownTimeoutMs ?? 5000, killGraceMs: input.killGraceMs ?? 250 };
  for (const [name, value] of Object.entries(options)) if (name !== 'modulePath') check(Number.isSafeInteger(value) && Number(value) >= (['workers', 'startupTimeoutMs', 'shutdownTimeoutMs', 'killGraceMs'].includes(name) ? 1 : 0), `Invalid ${name}`);
  const all: ProcessWorker[] = [], results: ProcessTestResult[] = [], workerErrors: ProcessFailure[] = [];
  let plan: ProcessPlan | undefined, nextWorker = 0;
  const start = async (slot: number): Promise<ProcessWorker> => {
    const worker = new ProcessWorker(options, input.env ?? {}, nextWorker++, slot); all.push(worker);
    const received = await worker.ready.promise;
    if (plan) check(JSON.stringify(received) === JSON.stringify(plan), 'Worker collection changed between processes');
    else plan = received;
    return worker;
  };
  const retire = async (worker: ProcessWorker): Promise<void> => { workerErrors.push(...await worker.close()); };
  try {
    const initial = await start(0), queue: Task[] = plan!.groups.map(g => ({ group: g.id, attempts: g.tests.map(id => ({ id, retry: 0 })) }));
    const slots = Math.min(options.workers, queue.length);
    const dispatch = async (slot: number): Promise<void> => {
      let worker: ProcessWorker | undefined = slot === 0 ? initial : undefined;
      try {
        while (queue.length) {
          const task = queue.shift()!;
          const workerKey = plan!.groups[task.group]!.workerKey;
          if (worker && worker.workerKey !== undefined && worker.workerKey !== workerKey) { await retire(worker); worker = undefined; }
          worker ??= await start(slot); worker.workerKey = workerKey;
          let done: Done;
          try { done = await worker.run(task); }
          catch (error) {
            if (worker.active) {
              const test = plan!.tests.find(t => t.id === worker!.active!.id)!;
              worker.runResults.push({ ...worker.active, expectedStatus: test.expectedStatus, status: worker.watchdogExpired ? 'timedOut' : 'crashed', workerIndex: worker.record.workerIndex, parallelIndex: slot, duration: 0, errors: [failure(error, worker.watchdogExpired ? 'watchdog' : 'process')] });
            } else workerErrors.push(failure(error, 'worker'));
            done = { workerStopped: true, pending: task.attempts.filter(a => !worker!.runResults.some(r => r.id === a.id)).map(a => a.id), skipIds: [] };
            // No test ever began: do not spin replacing an infrastructure failure.
            if (!worker.runResults.length) { queue.length = 0; done.pending = []; }
          }
          results.push(...worker.runResults);
          const pending = new Map(task.attempts.filter(a => done.pending.includes(a.id)).map(a => [a.id, a.retry]));
          const retry = new Map(worker.runResults.filter(r => unexpected(r) && r.retry < options.retries).map(r => [r.id, r.retry + 1]));
          for (const id of done.skipIds) {
            const attempt = task.attempts.find(a => a.id === id)!, test = plan!.tests.find(t => t.id === id)!;
            results.push({ ...attempt, status: 'skipped', expectedStatus: test.expectedStatus, workerIndex: worker.record.workerIndex, parallelIndex: slot, errors: [], duration: 0 });
            pending.delete(id); if (attempt.retry < options.retries) retry.set(id, attempt.retry + 1);
          }
          for (const [id, count] of retry) pending.set(id, count);
          if (pending.size) queue.unshift({ group: task.group, attempts: plan!.groups[task.group]!.tests.filter(id => pending.has(id)).map(id => ({ id, retry: pending.get(id)! })) });
          if (done.workerStopped) { await retire(worker); worker = undefined; }
        }
      } finally { if (worker) await retire(worker); }
    };
    const settled = await Promise.allSettled(Array.from({ length: slots }, (_, slot) => dispatch(slot)));
    for (const result of settled) if (result.status === 'rejected') workerErrors.push(failure(result.reason, 'dispatch'));
  } catch (error) { workerErrors.push(failure(error, 'collection')); }
  finally { for (const worker of all) workerErrors.push(...await worker.close()); }
  // close() is idempotent; its errors are collected once per original worker.
  const uniqueErrors = [...new Set(workerErrors)];
  const complete = plan && plan.tests.every(t => results.some(r => r.id === t.id));
  const last = new Map(results.map(r => [r.id, r]));
  const passed = complete && !uniqueErrors.length && [...last.values()].every(r => !unexpected(r));
  return { status: passed ? 'passed' : 'failed', plan, results, workerErrors: uniqueErrors, workers: all.map(w => w.record) };
}
