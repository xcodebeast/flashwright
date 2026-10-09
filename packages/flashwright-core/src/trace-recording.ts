import { randomUUID } from 'node:crypto';
import type { EngineClient } from './client.js';
import { failure, FlashwrightError } from './errors.js';
import type { TraceClock } from './trace-filmstrip.js';
import { sampleRecordingClock, type TraceRecordingIdentity } from './trace-snapshots.js';

export interface TraceCutoff { readonly lastEventSequence: number }

/** A recording spans chunk gaps; snapshots and network consumers share its exact native clock and cutoff. */
export class NativeTraceRecording {
  readonly identifier = randomUUID();
  private chunk: NativeTraceChunk | undefined;
  private opening = false;
  private stopped = false;
  private failure: unknown;

  private startRequested = false;

  constructor(private readonly client: EngineClient, readonly context: string, private readonly network = false) {}

  /** The host retains this owner before dispatch, including a start whose reply is uncertain. */
  async start(): Promise<void> {
    if (this.startRequested || this.stopped) throw failure('InvalidArgumentError', 'tracing', 'native recording start has already been requested');
    this.startRequested = true;
    try { await this.client.request('context.trace.recording.start', { context: this.context, recording: this.identifier, ...(this.network ? { network: true } : {}) }, 2000); }
    catch (error) {
      if (error instanceof Error && ['InvalidArgumentError', 'TargetClosedError', 'BrowserDisconnectedError'].includes(error.name)) this.stopped = true;
      throw error;
    }
  }

  async startChunk(identifier: string): Promise<NativeTraceChunk> {
    if (this.stopped || this.opening || this.chunk) throw failure('InvalidArgumentError', 'tracing', 'previous native chunk has not retired');
    if (this.failure) throw this.failure;
    this.opening = true;
    const identity = Object.freeze({ context: this.context, recording: this.identifier, chunk: identifier });
    // Retain identity before dispatch, including an accepted start whose reply was not delivered.
    const chunk = new NativeTraceChunk(this.client, identity);
    this.chunk = chunk;
    try {
      await this.client.request('context.trace.chunk.start', identity, 2000);
      chunk.clock = await sampleRecordingClock(this.client, this.context, this.identifier);
      return chunk;
    } catch (error) {
      this.failure ??= error;
      try { await chunk.seal(); await chunk.waitForSnapshots(); this.chunk = undefined; }
      catch (cleanupError) {
        if (cleanupError instanceof Error && ['InvalidArgumentError', 'TargetClosedError', 'BrowserDisconnectedError'].includes(cleanupError.name)) this.chunk = undefined;
      }
      throw error;
    } finally { this.opening = false; }
  }

  /** Consumers drain their sealed work first; status remains readable even after recording failure. */
  async retireChunk(chunk: NativeTraceChunk, signal?: AbortSignal): Promise<void> {
    if (chunk.identity.recording !== this.identifier || chunk.identity.context !== this.context) throw failure('InvalidArgumentError', 'tracing', 'chunk does not belong to this native owner');
    if (chunk.retired) return;
    if (this.chunk !== chunk) throw failure('InvalidArgumentError', 'tracing', 'chunk is not the current native owner');
    await chunk.seal();
    await chunk.waitForSnapshots(signal);
    chunk.retired = true;
    this.chunk = undefined;
  }

  async stop(signal?: AbortSignal): Promise<void> {
    if (this.stopped) return;
    if (this.chunk || this.opening) throw failure('InvalidArgumentError', 'tracing', 'native chunk must retire before recording stop');
    try {
      if (this.network) {
        const identity = { context: this.context, recording: this.identifier };
        await this.client.request('context.trace.recording.retire', identity, 2000);
        for (;;) {
          signal?.throwIfAborted();
          const status = await this.client.request('context.trace.recording.status', identity, 2000) as { recording?: unknown; networkPending?: unknown };
          if (!status || status.recording !== this.identifier || typeof status.networkPending !== 'boolean') throw failure('ProtocolError', 'tracing.network', 'invalid original recording settlement status');
          if (!status.networkPending) break;
          await new Promise<void>(resolve => setTimeout(resolve, 10));
        }
      }
      await this.client.request('context.trace.recording.stop', { context: this.context, recording: this.identifier }, 2000);
      this.stopped = true;
    } catch (error) {
      if (error instanceof FlashwrightError && error.details.cleanup === 'traceRecordingStopped') this.stopped = true;
      throw error;
    }
  }

  /** Failed setup retains its exact chunk even when start never returned it to the caller. */
  async cleanup(signal?: AbortSignal): Promise<void> {
    if (this.chunk) {
      try { await this.retireChunk(this.chunk, signal); }
      catch (error) {
        if (!(error instanceof Error) || !['InvalidArgumentError', 'TargetClosedError', 'BrowserDisconnectedError'].includes(error.name)) throw error;
        this.chunk = undefined;
      }
    }
    try { await this.stop(signal); }
    catch (error) { if (!this.stopped) throw error; }
  }
}

/** The common owner seals once, then gives both collectors the same complete-event prefix. */
export class NativeTraceChunk {
  retired = false;
  clock: TraceClock | undefined;
  private sealing: Promise<TraceCutoff> | undefined;

  constructor(private readonly client: EngineClient, readonly identity: TraceRecordingIdentity) {}

  seal(): Promise<TraceCutoff> {
    if (!this.sealing) {
      const work = this.client.request('context.trace.chunk.seal', this.identity, 2000).then(value => {
        const cutoff = value as TraceCutoff;
        if (!cutoff || !Number.isSafeInteger(cutoff.lastEventSequence) || cutoff.lastEventSequence < 0) throw failure('ProtocolError', 'tracing', 'invalid recording event cutoff');
        return Object.freeze({ lastEventSequence: cutoff.lastEventSequence });
      }).catch(error => { if (this.sealing === work) this.sealing = undefined; throw error; });
      this.sealing = work;
    }
    return this.sealing;
  }

  /** A failed archive cannot erase outstanding native allocation/byte owners. */
  async waitForSnapshots(signal?: AbortSignal): Promise<void> {
    for (;;) {
      signal?.throwIfAborted();
      const status = await this.client.request('context.trace.chunk.status', this.identity, 2000) as { recording?: unknown; chunk?: unknown; accepting?: unknown; snapshotPending?: unknown };
      if (!status || status.recording !== this.identity.recording || status.chunk !== this.identity.chunk || status.accepting !== false || typeof status.snapshotPending !== 'boolean') throw failure('ProtocolError', 'tracing', 'invalid original chunk retirement status');
      if (!status.snapshotPending) return;
      await new Promise<void>(resolve => setTimeout(resolve, 10));
    }
  }
}
