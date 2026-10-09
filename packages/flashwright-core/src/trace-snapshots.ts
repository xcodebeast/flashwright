import { performance } from 'node:perf_hooks';
import type { EngineClient } from './client.js';
import { failure } from './errors.js';
import type { TraceClock } from './trace-filmstrip.js';
import type { TraceResources } from './trace-resources.js';
import { tryAcquireTraceTransfer } from './trace-transfers.js';
import type { TraceWriter } from './trace-writer.js';

const maximumDataBytes = 4 * 1024 * 1024 - 64 * 1024;
export interface TraceRecordingIdentity { readonly context: string; readonly recording: string; readonly chunk: string }
interface SnapshotMetadata {
  capture: string; call: string; phase: 'before' | 'input' | 'after'; page: string; frame: string;
  isMainFrame: boolean; snapshotNumber: number; nativeTime: number; byteLength: number;
}

/** The shared native recording clock exists independently of screenshot capture. */
export async function sampleRecordingClock(client: EngineClient, context: string, recording: string): Promise<TraceClock> {
  let best: TraceClock | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    const hostBefore = performance.now();
    const reply = await client.request('context.trace.recording.clock', { context, recording }, 2000) as { nativeTime?: unknown };
    const hostAfter = performance.now();
    if (!reply || typeof reply.nativeTime !== 'number' || !Number.isFinite(reply.nativeTime)) throw protocol('invalid native recording clock');
    const uncertainty = (hostAfter - hostBefore) / 2;
    const sample = { nativeTime: reply.nativeTime, hostBefore, hostAfter, offset: (hostBefore + hostAfter) / 2 - reply.nativeTime, uncertainty };
    if (!best || uncertainty < best.uncertainty) best = sample;
  }
  return best!;
}

/** The common recording owner starts/seals native admission; this collector owns DATA through write and ACK. */
export class TraceSnapshotChannel {
  private readonly cancellation = new AbortController();
  private readonly releaseResources: () => void;
  private pending: SnapshotMetadata[] = [];
  private readonly inputCalls = new Set<string>();
  private nativePending = true;
  private polling: Promise<void> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopping = false;
  private closed = false;
  private failed = false;
  private failureWork: Promise<void> | undefined;
  private stopWork: Promise<void> | undefined;

  constructor(
    private readonly client: EngineClient,
    private readonly identity: TraceRecordingIdentity,
    private readonly clock: TraceClock,
    private readonly resources: TraceResources,
    private readonly writer: TraceWriter,
    private readonly pageIdentity: (page: string) => string,
    private readonly onInput?: (call: string) => void,
  ) {
    this.identity = Object.freeze({ ...identity });
    this.releaseResources = resources.acquire();
    this.schedule();
  }

  private schedule(): void {
    if (this.stopping || this.closed || this.failed) return;
    this.timer = setTimeout(() => {
      this.polling = this.poll().finally(() => { this.polling = undefined; this.schedule(); });
    }, 25);
    this.timer.unref();
  }

  private async poll(): Promise<void> {
    try {
      for (let consumed = 0; consumed < 64 && !this.stopping && !this.closed && !this.failed; consumed++) {
        if (await this.drain() !== 'progress') break;
      }
    } catch (error) { this.captureFailure(error); }
  }

  private async drain(): Promise<'progress' | 'waiting' | 'settled'> {
    this.cancellation.signal.throwIfAborted();
    const releaseTransfer = tryAcquireTraceTransfer(this.client, this.identity.context);
    if (!releaseTransfer) return 'waiting';
    try {
      if (!this.pending.length) {
        const reply = await this.client.request('context.trace.snapshot.pull', this.identity, 2000);
        this.cancellation.signal.throwIfAborted();
        this.acceptMetadata(reply);
        if (!this.pending.length) return this.nativePending ? 'waiting' : 'settled';
      }
      const metadata = this.pending.shift()!;
      const parameters = { ...this.identity, capture: metadata.capture };
      const bytes = await this.client.requestTraceAttachment('context.trace.snapshot.take', parameters, 2000, metadata.byteLength, this.cancellation.signal);
      this.cancellation.signal.throwIfAborted();
      if (!Buffer.isBuffer(bytes) || bytes.length !== metadata.byteLength || bytes.length > maximumDataBytes) throw protocol('snapshot attachment length changed');
      const snapshot = await this.prepare(bytes, metadata);
      if (metadata.phase === 'input' && !this.inputCalls.has(metadata.call)) {
        if (this.inputCalls.size >= 4096) throw failure('ResourceLimitError', 'tracing.snapshot', 'snapshot input journal exceeds 4096 calls');
        this.onInput?.(metadata.call);
        this.inputCalls.add(metadata.call);
      }
      await this.writer.appendSnapshot({ type: 'frame-snapshot', snapshot }, this.cancellation.signal);
      this.cancellation.signal.throwIfAborted();
      await this.client.request('context.trace.snapshot.ingested', { ...parameters, success: true }, 2000);
      return 'progress';
    } finally {
      // CSS blobs and streamed JSONL must be immutable before this lease can serve a successor.
      releaseTransfer();
    }
  }

  private acceptMetadata(reply: unknown): void {
    const batch = reply as { recording?: unknown; chunk?: unknown; snapshots?: unknown; pending?: unknown };
    if (!batch || batch.recording !== this.identity.recording || batch.chunk !== this.identity.chunk || typeof batch.pending !== 'boolean'
      || !Array.isArray(batch.snapshots) || batch.snapshots.length > 64) throw protocol('invalid original snapshot batch');
    const captures = new Set<string>();
    const metadata: SnapshotMetadata[] = [];
    for (const value of batch.snapshots) {
      const entry = value as SnapshotMetadata;
      if (!entry || Object.keys(entry).length !== 9 || Object.keys(entry).some(key => !['capture', 'call', 'phase', 'page', 'frame', 'isMainFrame', 'snapshotNumber', 'nativeTime', 'byteLength'].includes(key))
        || !identifier(entry.capture, 128) || captures.has(entry.capture) || !identifier(entry.call, 64)
        || !identifier(entry.page, 64) || !identifier(entry.frame, 256) || !['before', 'input', 'after'].includes(entry.phase)
        || typeof entry.isMainFrame !== 'boolean' || !Number.isSafeInteger(entry.snapshotNumber) || entry.snapshotNumber < 1
        || !Number.isFinite(entry.nativeTime) || !Number.isSafeInteger(entry.byteLength) || entry.byteLength < 1 || entry.byteLength > maximumDataBytes) throw protocol('invalid snapshot capture metadata');
      captures.add(entry.capture);
      metadata.push(entry);
    }
    this.pending = metadata;
    this.nativePending = batch.pending;
  }

  private async prepare(bytes: Buffer, metadata: SnapshotMetadata): Promise<Record<string, unknown>> {
    const data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as Record<string, unknown>;
    if (!data || Array.isArray(data) || typeof data !== 'object'
      || Object.keys(data).length !== 7 || Object.keys(data).some(key => !['html', 'url', 'doctype', 'viewport', 'wallTime', 'collectionTime', 'resourceOverrides'].includes(key))
      || typeof data.url !== 'string' || !Array.isArray(data.resourceOverrides) || data.resourceOverrides.length > 1024) throw protocol('invalid snapshot DATA envelope');
    const overrides: { url: string; sha1?: string; ref?: number }[] = [];
    for (const entry of data.resourceOverrides) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry) || typeof entry.url !== 'string') throw protocol('invalid snapshot stylesheet override');
      if (Object.hasOwn(entry, 'content')) {
        if (Object.keys(entry).length !== 3 || typeof entry.content !== 'string' || entry.contentType !== 'text/css') throw protocol('invalid snapshot stylesheet content');
        this.cancellation.signal.throwIfAborted();
        const resource = await this.resources.captureBytes(Buffer.from(entry.content), this.cancellation.signal);
        this.cancellation.signal.throwIfAborted();
        const alias = `${resource.contentHash}.css`;
        this.writer.addResource(`resources/${alias}`, resource);
        if (this.writer.failure) throw this.writer.failure;
        overrides.push({ url: entry.url, sha1: alias });
      } else {
        if (Object.keys(entry).length !== 2 || !Number.isSafeInteger(entry.ref) || entry.ref <= 0) throw protocol('invalid snapshot stylesheet reference');
        overrides.push({ url: entry.url, ref: entry.ref });
      }
    }
    const { url, resourceOverrides: _resources, ...snapshot } = data;
    return { ...snapshot, frameUrl: url, resourceOverrides: overrides, pageId: this.pageIdentity(metadata.page), frameId: metadata.frame,
      callId: metadata.call, snapshotName: `${metadata.phase}@${metadata.call}`, timestamp: metadata.nativeTime + this.clock.offset, isMainFrame: metadata.isMainFrame };
  }

  fail(error: unknown): void { this.captureFailure(error); }

  private captureFailure(error: unknown): void {
    if (this.failed) return;
    this.failed = true;
    this.writer.fail(error);
    this.cancellation.abort(error);
    this.pending = [];
    clearTimeout(this.timer);
    if (!this.closed) {
      const { context, recording } = this.identity;
      this.failureWork = this.client.request('context.trace.recording.fail', { context, recording, message: 'host snapshot collection failed' }, 2000)
        .then(() => {}, error => { this.writer.fail(error); });
    }
  }

  /** Call only after the common owner seals native admission; one bounded loop drains retiring work. */
  stop(signal?: AbortSignal): Promise<void> {
    if (!this.stopWork) {
      this.stopping = true;
      clearTimeout(this.timer);
      const abort = () => this.captureFailure(signal!.reason);
      if (signal?.aborted) abort();
      else signal?.addEventListener('abort', abort, { once: true });
      this.stopWork = this.finish().finally(() => { signal?.removeEventListener('abort', abort); this.releaseResources(); });
    }
    return this.stopWork;
  }

  private async finish(): Promise<void> {
    try {
      await this.polling;
      while (!this.closed && !this.failed) {
        const result = await this.drain();
        if (result === 'settled') break;
        if (result === 'waiting') await new Promise<void>(resolve => setTimeout(resolve, 10));
      }
    } catch (error) { this.captureFailure(error); }
    finally { await this.polling; await this.failureWork; this.pending = []; }
  }

  ownerClosed(): void {
    this.closed = true;
    this.cancellation.abort(failure('TargetClosedError', 'tracing.snapshot', 'context closed'));
    void this.stop();
  }
}

function identifier(value: unknown, limit: number): value is string { return typeof value === 'string' && value.length > 0 && value.length <= limit && /^[\x00-\x7f]+$/.test(value); }
function protocol(message: string): Error { return failure('ProtocolError', 'tracing.snapshot', message); }
