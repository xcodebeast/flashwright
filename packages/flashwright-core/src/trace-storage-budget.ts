import { failure } from './errors.js';
import type { FileHandle } from 'node:fs/promises';

interface TraceStorageLimits {
  readonly bytes: number;
  readonly files: number;
  readonly owners: number;
  readonly queuedBytes: number;
}

const defaultLimits: TraceStorageLimits = {
  bytes: 1024 * 1024 * 1024, files: 32768, owners: 256, queuedBytes: 64 * 1024 * 1024,
};

/** Shared physical custody survives test boundaries and failed filesystem cleanup. */
export class TraceStorageBudget {
  private bytes = 0;
  private files = 0;
  private owners = 0;
  private queuedBytes = 0;

  constructor(private readonly limits: TraceStorageLimits = defaultLimits) {}

  acquire(files = 0): TraceStorageLease {
    if (this.owners >= this.limits.owners) throw this.exceeded();
    this.retain(0, files);
    this.owners++;
    return new TraceStorageLease(this, files);
  }

  retain(bytes: number, files: number): void {
    if (this.bytes + bytes > this.limits.bytes || this.files + files > this.limits.files) throw this.exceeded();
    this.bytes += bytes;
    this.files += files;
  }

  release(bytes: number, files: number, owner = false): void {
    this.bytes -= bytes;
    this.files -= files;
    if (owner) this.owners--;
  }

  /** Queue custody ends only after the original write or body ingestion settles. */
  queue(bytes: number): () => void {
    if (this.queuedBytes + bytes > this.limits.queuedBytes) throw this.exceeded();
    this.queuedBytes += bytes;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.queuedBytes -= bytes;
    };
  }

  private exceeded(): Error {
    return failure('ResourceLimitError', 'tracing.storage', 'shared trace storage or queued capture allowance exceeded');
  }
}

/** One private directory or output file owns its reservations through definitive cleanup. */
export class TraceStorageLease {
  private bytes = 0;
  private released = false;

  constructor(private readonly budget: TraceStorageBudget, private files: number) {}

  retain(bytes: number, files = 0): void {
    if (this.released) throw failure('TargetClosedError', 'tracing.storage', 'trace storage owner is closed');
    this.budget.retain(bytes, files);
    this.bytes += bytes;
    this.files += files;
  }

  /** Neither queued memory nor future file bytes become owned when the other limit rejects. */
  reserveWrite(bytes: number): () => void {
    const releaseQueue = this.budget.queue(bytes);
    try { this.retain(bytes); }
    catch (error) { releaseQueue(); throw error; }
    return releaseQueue;
  }

  remove(bytes: number, files = 0): void {
    this.budget.release(bytes, files);
    this.bytes -= bytes;
    this.files -= files;
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    this.budget.release(this.bytes, this.files, true);
    this.bytes = 0;
    this.files = 0;
  }
}

export const traceStorageBudget = new TraceStorageBudget();

/** A failed close retains the exact handle until its original owner can confirm closure. */
export class TraceFileCustody {
  private readonly unclosed = new Set<FileHandle>();

  get uncertain(): boolean { return this.unclosed.size !== 0; }

  async close(file: FileHandle): Promise<void> {
    try { await file.close(); this.unclosed.delete(file); }
    catch (error) { this.unclosed.add(file); throw error; }
  }

  async settle(): Promise<void> {
    const results = await Promise.allSettled([...this.unclosed].map(file => this.close(file)));
    for (const result of results) if (result.status === 'rejected') throw result.reason;
  }
}
