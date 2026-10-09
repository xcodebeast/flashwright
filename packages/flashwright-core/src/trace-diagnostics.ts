import type { EngineClient } from './client.js';
import { failure } from './errors.js';

export interface TraceDiagnostic { page: string; kind: 'console-api' | 'console-log' | 'pageerror'; raw: string }
interface DrainReply { generation: string; events: TraceDiagnostic[] }
interface Fence { sequence: number; resolve: () => void }

/** A single pull owner coalesces concurrent fences without accepting stale generations. */
export class TraceDiagnosticChannel {
  private requested = 0;
  private completed = 0;
  private readonly fences: Fence[] = [];
  private pulling: Promise<void> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopping = false;
  private stopWork: Promise<void> | undefined;
  private closed = false;
  private failed = false;
  private constructor(
    private readonly client: EngineClient,
    private readonly context: string,
    readonly generation: string,
    private readonly accept: (diagnostic: TraceDiagnostic) => void,
    private readonly fail: (error: unknown) => void,
  ) {}
  static async start(client: EngineClient, context: string, generation: string, accept: (diagnostic: TraceDiagnostic) => void, fail: (error: unknown) => void): Promise<TraceDiagnosticChannel> {
    const channel = new TraceDiagnosticChannel(client, context, generation, accept, fail);
    try { await client.request('context.trace.start', { context, generation }, 2000); }
    catch (error) {
      // A timed-out reply does not prove that driver acceptance never happened.
      // The same generation's stop follows the start in the transport FIFO.
      try { await client.request('context.trace.stop', { context, generation }, 2000); }
      catch (cleanupError) {
        if (!(cleanupError instanceof Error) || !['TargetClosedError', 'BrowserDisconnectedError', 'InvalidArgumentError'].includes(cleanupError.name)) fail(cleanupError);
      }
      throw error;
    }
    channel.schedule();
    return channel;
  }
  private schedule(): void {
    if (this.stopping || this.closed || this.failed) return;
    this.timer = setTimeout(() => { void this.fence().then(() => this.schedule()); }, 250);
    this.timer.unref();
  }
  fence(): Promise<void> {
    if (this.stopping || this.closed || this.failed) return Promise.resolve();
    if (this.fences.length >= 1024) {
      this.captureFailure(failure('ResourceLimitError', 'tracing', 'trace exceeds 1024 pending diagnostic fences'));
      return Promise.resolve();
    }
    const sequence = ++this.requested;
    const result = new Promise<void>(resolve => this.fences.push({ sequence, resolve }));
    this.pulling ??= this.pull();
    return result;
  }
  private async pull(): Promise<void> {
    try {
      while (!this.closed && !this.failed && this.completed < this.requested) {
        const sequence = this.requested;
        try { this.receive(await this.client.request('context.trace.pull', { context: this.context, generation: this.generation }, 2000)); }
        catch (error) { if (!this.closed) this.captureFailure(error); }
        this.completed = sequence;
        this.settleFences(sequence);
      }
    } finally { this.pulling = undefined; }
  }
  private receive(reply: unknown): void {
    if (this.closed || this.failed) return;
    const result = reply as DrainReply;
    if (!result || result.generation !== this.generation || !Array.isArray(result.events) || result.events.length > 1024) {
      throw failure('ProtocolError', 'tracing', 'driver returned invalid diagnostic generation or events');
    }
    for (const diagnostic of result.events) {
      if (typeof diagnostic.page !== 'string' || typeof diagnostic.raw !== 'string' || !['console-api', 'console-log', 'pageerror'].includes(diagnostic.kind)) throw failure('ProtocolError', 'tracing', 'driver returned invalid diagnostic metadata');
      this.accept(diagnostic);
    }
  }
  private settleFences(sequence = Infinity): void {
    while (this.fences[0] && this.fences[0].sequence <= sequence) this.fences.shift()!.resolve();
  }
  private captureFailure(error: unknown): void {
    if (this.failed) return;
    this.failed = true;
    clearTimeout(this.timer);
    this.fail(error);
    this.settleFences();
  }
  /** Seal after the outstanding pull, then drain and disable capture in driver acceptance order. */
  stop(): Promise<void> { return this.stopWork ??= this.finish(); }
  private async finish(): Promise<void> {
    this.stopping = true;
    clearTimeout(this.timer);
    await this.pulling;
    if (!this.closed) {
      try { this.receive(await this.client.request('context.trace.stop', { context: this.context, generation: this.generation }, 2000)); }
      catch (error) { if (!this.closed) this.captureFailure(error); }
    }
    this.settleFences();
  }
  ownerClosed(): void {
    this.closed = true;
    clearTimeout(this.timer);
    this.settleFences();
  }
}
