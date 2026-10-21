import { AsyncLocalStorage } from 'node:async_hooks';

export interface TimeSlot { timeout: number; elapsed: number }
export interface PhaseBudget { slot: TimeSlot; phase: string }
export class RunnerTimeoutError extends Error {
  constructor(readonly phase: string, readonly timeout: number) {
    super(`${phase} exceeded its ${timeout}ms timeout`); this.name = 'RunnerTimeoutError';
  }
}
export function timeoutValue(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error('Timeout must be a finite nonnegative number');
  return value;
}
export function timeSlot(timeout: number): TimeSlot { return { timeout: timeoutValue(timeout), elapsed: 0 }; }
export function exhausted(slot: TimeSlot): boolean { return slot.timeout !== 0 && slot.elapsed >= slot.timeout - 1; }
export function cleanupTimeout(project: number, test: number): number { return project === 0 || test === 0 ? 0 : Math.max(project, test); }

const invocation = new AsyncLocalStorage<() => DeadlineRun | undefined>();
export type DeadlineNotice = { active: false } | { active: true; remaining: number | null; phase: string };
let observer: ((notice: DeadlineNotice) => void) | undefined;
export function observeDeadlines(callback: (notice: DeadlineNotice) => void): void {
  if (observer) throw new Error('Deadline observer is already installed');
  observer = callback;
}
export function inDeadlineContext<T>(owner: () => DeadlineRun | undefined, callback: () => T): T { return invocation.run(owner, callback); }
export function currentDeadlineRun(): DeadlineRun {
  const run = invocation.getStore()?.();
  if (!run?.active) throw new Error('The original runner deadline scope has ended');
  return run;
}

/** One fixture or callback invocation, charging its selected persistent slot. */
export class DeadlineRun {
  #slot: TimeSlot;
  #phase: string;
  #started = performance.now();
  #timer: ReturnType<typeof setTimeout> | undefined;
  #active = true;
  #expired: RunnerTimeoutError | undefined;
  #reject!: (error: RunnerTimeoutError) => void;
  readonly #expiration = new Promise<never>((_resolve, reject) => { this.#reject = reject; });
  constructor(slot: TimeSlot, phase: string) {
    this.#slot = slot; this.#phase = phase;
    void this.#expiration.catch(() => {});
    this.schedule();
  }
  get active(): boolean { return this.#active && !this.#expired; }
  check(): void { if (!this.active) throw this.#expired ?? new Error('Runner invocation has ended'); }
  setTimeout(timeout: number): void { this.check(); this.account(); this.#slot.timeout = timeoutValue(timeout); this.schedule(); }
  slow(): void { this.setTimeout(this.#slot.timeout * 3); }
  async wait<T>(operation: PromiseLike<T>): Promise<T> {
    this.check();
    return Promise.race([operation, this.#expiration]);
  }
  finish(): void { this.account(); this.#active = false; clearTimeout(this.#timer); observer?.({ active: false }); }
  private account(): void {
    const now = performance.now();
    if (this.active) this.#slot.elapsed += now - this.#started;
    this.#started = now;
  }
  private schedule(): void {
    clearTimeout(this.#timer);
    if (!this.active) return;
    observer?.({ active: true, phase: this.#phase, remaining: this.#slot.timeout === 0 ? null : Math.max(0, this.#slot.timeout - this.#slot.elapsed) });
    if (this.#slot.timeout === 0) return;
    const remaining = this.#slot.timeout - this.#slot.elapsed;
    if (remaining <= 0) {
      this.#expired = new RunnerTimeoutError(this.#phase, this.#slot.timeout);
      this.#reject(this.#expired); return;
    }
    this.#timer = setTimeout(() => {
      this.account();
      if (this.#slot.elapsed < this.#slot.timeout) { this.schedule(); return; }
      this.#expired = new RunnerTimeoutError(this.#phase, this.#slot.timeout);
      this.#reject(this.#expired);
    }, Math.min(2 ** 31 - 1, Math.max(0, remaining)));
  }
}

export async function withDeadline<T>(slot: TimeSlot, phase: string, callback: (run: DeadlineRun) => Promise<T>): Promise<T> {
  const run = new DeadlineRun(slot, phase);
  try { run.check(); return await inDeadlineContext(() => run, () => run.wait(Promise.resolve().then(() => { run.check(); return callback(run); }))); }
  finally { run.finish(); }
}
