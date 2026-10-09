import { performance } from 'node:perf_hooks';
import { failure } from './errors.js';

export type TraceAdmissionKind = 'ordinary' | 'trace' | 'collection' | 'recovery';
interface PendingCounts { total: number; trace: number; collection: number }
interface Waiter {
  kind: TraceAdmissionKind;
  method: string;
  deadline: number | undefined;
  dispatch(): Promise<unknown>;
  resolve(value: unknown): void;
  reject(error: unknown): void;
  timeout: ReturnType<typeof setTimeout> | undefined;
}

/** Bounded optional work waits behind public calls without spending their ordinary caller quota. */
export class TraceAdmission {
  private readonly recoveryWaiters = new Set<Waiter>();
  private readonly ordinaryWaiters = new Set<Waiter>();
  private readonly collectionWaiters = new Set<Waiter>();
  private readonly traceWaiters = new Set<Waiter>();
  private dispatching = false;
  private closed: Error | undefined;

  constructor(
    private readonly totalLimit: number,
    private readonly ordinaryLimit: number,
    private readonly traceLimit: number,
    private readonly pendingCount: () => number,
    private readonly pendingCounts: () => PendingCounts,
  ) {}

  /** Dispatch installs pending custody and its FIFO write synchronously, before any caller wakes. */
  run(kind: TraceAdmissionKind, method: string, deadline: number | undefined, dispatch: () => Promise<unknown>): Promise<unknown> {
    if (this.closed) throw this.closed;
    const pending = this.pendingCount();
    const limit = this.limit(kind);
    if (kind === 'trace' || kind === 'collection') {
      const retained = this.pendingCounts().trace + this.traceWaiters.size + this.collectionWaiters.size;
      if (retained >= this.traceLimit) throw failure('ResourceLimitError', method, 'trace admission queue is full');
    }
    if (pending < limit) {
      this.checkDeadline(method, deadline);
      return dispatch();
    }
    if (kind === 'ordinary' || kind === 'recovery') {
      const counts = this.pendingCounts();
      const foreground = counts.total - counts.trace + this.ordinaryWaiters.size + this.recoveryWaiters.size;
      const blockedByTrace = kind === 'recovery' ? this.recoveryWaiters.size < counts.collection : counts.trace > 0;
      if (foreground >= limit || !blockedByTrace) {
        throw failure('ResourceLimitError', method, 'pending operation capacity is exhausted or reserved for recovery');
      }
    }
    this.checkDeadline(method, deadline);
    const waiters = this.waiters(kind);
    return new Promise((resolve, reject) => {
      const waiter: Waiter = { kind, method, deadline, dispatch, resolve, reject, timeout: undefined };
      waiters.add(waiter);
      if (deadline !== undefined) waiter.timeout = setTimeout(() => {
        if (!waiters.delete(waiter)) return;
        reject(failure('TimeoutError', method, 'deadline exceeded while waiting for trace admission'));
      }, Math.max(0, deadline - performance.now()));
    });
  }

  /** Public waiters win over earlier optional work; callbacks cannot yield before insertion. */
  capacityChanged(): void {
    if (this.closed || this.dispatching) return;
    this.dispatching = true;
    try {
      while (!this.closed) {
        const pending = this.pendingCount();
        const waiter = (['recovery', 'ordinary', 'collection', 'trace'] as const)
          .filter(kind => pending < this.limit(kind))
          .map(kind => this.waiters(kind).values().next().value).find(waiter => waiter !== undefined);
        if (!waiter) return;
        this.waiters(waiter.kind).delete(waiter);
        clearTimeout(waiter.timeout);
        try {
          this.checkDeadline(waiter.method, waiter.deadline);
          waiter.resolve(waiter.dispatch());
        } catch (error) { waiter.reject(error); }
      }
    } finally { this.dispatching = false; }
  }

  private limit(kind: TraceAdmissionKind): number {
    return kind === 'recovery' || kind === 'collection' ? this.totalLimit : this.ordinaryLimit;
  }

  private waiters(kind: TraceAdmissionKind): Set<Waiter> {
    return kind === 'recovery' ? this.recoveryWaiters : kind === 'ordinary' ? this.ordinaryWaiters
      : kind === 'collection' ? this.collectionWaiters : this.traceWaiters;
  }

  private checkDeadline(method: string, deadline: number | undefined): void {
    if (deadline !== undefined && performance.now() >= deadline) throw failure('TimeoutError', method, 'deadline exceeded before driver acceptance');
  }

  /** Disconnection rejects queued callers; dispatched requests retain their existing cleanup. */
  close(error: Error): void {
    if (this.closed) return;
    this.closed = error;
    for (const waiter of [...this.recoveryWaiters, ...this.ordinaryWaiters, ...this.collectionWaiters, ...this.traceWaiters]) {
      clearTimeout(waiter.timeout);
      waiter.reject(error);
    }
    this.ordinaryWaiters.clear();
    this.recoveryWaiters.clear();
    this.collectionWaiters.clear();
    this.traceWaiters.clear();
  }
}
