import { performance } from 'node:perf_hooks';
import type { EngineClient } from './client.js';
import { failure } from './errors.js';
import type { TraceResources } from './trace-resources.js';
import type { TraceWriter } from './trace-writer.js';
import { traceTransferAvailable, tryAcquireTraceTransfer } from './trace-transfers.js';

const maximumFrameBytes = 4 * 1024 * 1024;
export interface TraceClock { nativeTime: number; hostBefore: number; hostAfter: number; offset: number; uncertainty: number }
interface FrameMetadata { token: number; page: string; width: number; height: number; timestamp: number; frameSwapWallTime: number; byteLength: number }

/** A bounded request/response interval maps native arrival time into the host action clock. */
export async function sampleTraceClock(client: EngineClient, context: string): Promise<TraceClock> {
  let best: TraceClock | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    const hostBefore = performance.now();
    const reply = await client.request('context.trace.filmstrip.clock', { context }, 2000) as { monotonicTime?: unknown };
    const hostAfter = performance.now();
    if (!reply || typeof reply.monotonicTime !== 'number' || !Number.isFinite(reply.monotonicTime) || reply.monotonicTime < 0) throw protocol('invalid native clock sample');
    const uncertainty = (hostAfter - hostBefore) / 2;
    const sample = { nativeTime: reply.monotonicTime, hostBefore, hostAfter, offset: (hostBefore + hostAfter) / 2 - reply.monotonicTime, uncertainty };
    if (!best || sample.uncertainty < best.uncertainty) best = sample;
  }
  return best!;
}

/** One context collector retains its engine transfer slot through immutable resource ingestion. */
export class TraceFilmstripChannel {
  private readonly cancellation = new AbortController();
  private readonly releaseResources: () => void;
  private pending: FrameMetadata[] = [];
  private polling: Promise<void> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopping = false;
  private closed = false;
  private failed = false;
  private stopWork: Promise<void> | undefined;
  private readonly activityPages = new Set<string>();
  private activityWork: Promise<void> | undefined;

  private constructor(
    private readonly client: EngineClient,
    private readonly context: string,
    private readonly generation: string,
    private readonly clock: TraceClock,
    private readonly resources: TraceResources,
    private readonly writer: TraceWriter,
    private readonly pageIdentity: (page: string) => string,
  ) {
    this.releaseResources = resources.acquire();
  }

  static async start(client: EngineClient, context: string, generation: string, clock: TraceClock, resources: TraceResources, writer: TraceWriter, pageIdentity: (page: string) => string): Promise<TraceFilmstripChannel> {
    const channel = new TraceFilmstripChannel(client, context, generation, clock, resources, writer, pageIdentity);
    try {
      await client.request('context.trace.filmstrip.start', { context, generation }, 2000);
      channel.schedule();
      return channel;
    } catch (error) {
      // A start failure is reported directly; only failed cleanup quarantines future recordings.
      channel.failed = true;
      channel.cancellation.abort(error);
      await channel.stop();
      throw error;
    }
  }

  private schedule(): void {
    if (this.stopping || this.closed || this.failed) return;
    this.timer = setTimeout(() => {
      this.polling = this.poll().finally(() => { this.polling = undefined; this.schedule(); });
    }, 50);
    this.timer.unref();
  }

  private async poll(): Promise<void> {
    try {
      for (let consumed = 0; consumed < 128 && !this.stopping && traceTransferAvailable(this.client, this.context); consumed++) {
        if (await this.drain()) break;
      }
    }
    catch (error) { if (!this.closed) this.captureFailure(error); }
  }

  /** No transfer waiter list: a busy engine leaves frames in the bounded native queue. */
  private async drain(): Promise<boolean> {
    if (this.closed || this.failed || this.cancellation.signal.aborted) return true;
    const releaseTransfer = tryAcquireTraceTransfer(this.client, this.context);
    if (!releaseTransfer) return false;
    try {
      if (!this.pending.length) {
        const reply = await this.client.request('context.trace.filmstrip.pull', this.parameters(), 2000);
        if (this.closed || this.failed) return true;
        this.pending = this.validateFrames(reply);
        if (!this.pending.length) return true;
      }
      // One page resource at a time per context; metadata never implies released native bytes.
      const frame = this.pending.shift()!;
      const bytes = await this.client.requestBinary('context.trace.filmstrip.take', { ...this.parameters(), token: frame.token }, 2000, frame.byteLength);
      this.cancellation.signal.throwIfAborted();
      if (!Buffer.isBuffer(bytes) || bytes.length !== frame.byteLength || bytes.length > maximumFrameBytes || bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) throw protocol('invalid JPEG attachment or frame length');
      const resource = await this.resources.captureBytes(bytes, this.cancellation.signal);
      this.cancellation.signal.throwIfAborted();
      const name = `${resource.contentHash}.jpeg`;
      this.writer.addResource(`resources/${name}`, resource);
      this.writer.append({ type: 'screencast-frame', pageId: this.pageIdentity(frame.page), sha1: name, width: frame.width, height: frame.height, timestamp: frame.timestamp + this.clock.offset, frameSwapWallTime: frame.frameSwapWallTime });
      if (this.writer.failure) throw this.writer.failure;
      return false;
    } finally { releaseTransfer(); }
  }

  private validateFrames(reply: unknown): FrameMetadata[] {
    const result = reply as { generation?: unknown; frames?: unknown };
    if (!result || result.generation !== this.generation || !Array.isArray(result.frames) || result.frames.length > 128) throw protocol('invalid frame generation or metadata batch');
    const frames: FrameMetadata[] = [];
    const tokens = new Set<number>();
    for (const value of result.frames) {
      const frame = value as FrameMetadata;
      if (!frame || !Number.isSafeInteger(frame.token) || frame.token <= 0 || tokens.has(frame.token) || typeof frame.page !== 'string' || !frame.page.length || Buffer.byteLength(frame.page) > 64
        || ![frame.width, frame.height].every(dimension => Number.isFinite(dimension) && dimension > 0 && dimension <= 0xffffffff)
        || !Number.isFinite(frame.timestamp) || frame.timestamp < 0 || !Number.isFinite(frame.frameSwapWallTime) || frame.frameSwapWallTime < 0
        || !Number.isSafeInteger(frame.byteLength) || frame.byteLength < 4 || frame.byteLength > maximumFrameBytes) throw protocol('invalid frame metadata');
      tokens.add(frame.token);
      frames.push(frame);
    }
    return frames;
  }

  /** Coalesce only activity for the same original chunk, without delaying public calls. */
  activity(page: string | undefined): void {
    if (page === undefined || this.stopping || this.closed || this.failed) return;
    if (!this.activityPages.has(page) && this.activityPages.size >= 128) { this.captureFailure(failure('ResourceLimitError', 'tracing.filmstrip', 'activity exceeds 128 pending pages')); return; }
    this.activityPages.add(page);
    this.activityWork ??= this.sendActivity();
  }

  private async sendActivity(): Promise<void> {
    try {
      while (!this.stopping && !this.closed && !this.failed && this.activityPages.size) {
        const page = this.activityPages.values().next().value!;
        this.activityPages.delete(page);
        await this.client.request('context.trace.filmstrip.activity', { ...this.parameters(), page }, 2000);
      }
    } catch (error) { if (!this.closed) this.captureFailure(error); }
    finally { this.activityWork = undefined; }
  }

  private parameters(): { context: string; generation: string } { return { context: this.context, generation: this.generation }; }
  private captureFailure(error: unknown): void {
    if (this.failed) return;
    this.failed = true;
    this.writer.fail(error);
    this.cancellation.abort(error);
    clearTimeout(this.timer);
    this.pending = [];
    this.activityPages.clear();
    // Capture failure owns cleanup even if the user never explicitly stops tracing.
    void this.stop();
  }

  stop(signal?: AbortSignal): Promise<void> {
    if (!this.stopWork) {
      const abort = () => this.cancellation.abort(signal!.reason);
      if (signal?.aborted) abort();
      else signal?.addEventListener('abort', abort, { once: true });
      this.stopWork = this.finish().finally(() => { signal?.removeEventListener('abort', abort); this.releaseResources(); });
    }
    return this.stopWork;
  }

  private async finish(): Promise<void> {
    this.stopping = true;
    clearTimeout(this.timer);
    this.activityPages.clear();
    try {
      await this.activityWork;
      if (!this.closed && !this.failed) await this.client.request('context.trace.filmstrip.seal', this.parameters(), 2000);
      await this.polling;
      while (!this.closed && !this.failed && !this.cancellation.signal.aborted && !await this.drain()) {
        // A single bounded owner retries; no promise queue grows behind shared transfer slots.
        await new Promise<void>(resolve => setTimeout(resolve, 10));
      }
    } catch (error) { if (!this.closed) { this.failed = true; this.writer.fail(error); this.cancellation.abort(error); } }
    finally {
      // Outstanding ingestion retains its lease until it settles, including cancellation.
      await this.polling;
      this.pending = [];
      if (!this.closed) {
        try { await this.client.request('context.trace.filmstrip.dispose', this.parameters(), 2000); }
        catch (error) {
          if (!(error instanceof Error) || !['TargetClosedError', 'BrowserDisconnectedError', 'InvalidArgumentError'].includes(error.name)) this.writer.fail(error);
        }
      }
    }
  }

  ownerClosed(): void {
    this.closed = true;
    clearTimeout(this.timer);
    this.activityPages.clear();
    this.cancellation.abort(failure('TargetClosedError', 'tracing.filmstrip', 'context closed'));
    void this.stop();
  }
}

function protocol(message: string): Error { return failure('ProtocolError', 'tracing.filmstrip', message); }
