import type { EngineClient } from './client.js';
import { failure } from './errors.js';
import { convertNetworkTraceEntry, type NetworkTraceBody, type NetworkTraceHeader } from './trace-network-entry.js';
import type { NativeTraceChunk } from './trace-recording.js';
import type { TraceResource, TraceResources } from './trace-resources.js';
import { tryAcquireTraceTransfer } from './trace-transfers.js';
import type { TraceWriter } from './trace-writer.js';

interface ResourceMetadata { token: string; byteLength: number; formEncoded: boolean }
interface CapturedResource { resource: TraceResource; formParameters?: NetworkTraceHeader[] }
const maximumResourceBytes = 16 * 1024 * 1024;
const protocol = (message: string) => failure('ProtocolError', 'tracing.network', message);
const limited = (message: string) => failure('ResourceLimitError', 'tracing.network', message);
const idle = () => new Promise<void>(resolve => setTimeout(resolve, 10));

/** One recording collects resources continuously, including gaps between immutable chunk exports. */
export class TraceNetworkChannel {
  private readonly identity: { readonly context: string; readonly recording: string };
  private readonly cancellation = new AbortController();
  private readonly captured = new Map<string, CapturedResource>();
  private readonly releaseResources: () => void;
  private metadataBytes = 0;
  private pending: ResourceMetadata[] = [];
  private polling: Promise<'progress' | 'waiting' | 'settled'> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private failure: unknown;
  private failureWork: Promise<void> | undefined;
  private stopWork: Promise<void> | undefined;
  private stopping = false;
  private closed = false;

  constructor(private readonly client: EngineClient, context: string, recording: string, private readonly resources: TraceResources, private readonly onFailure: (error: unknown) => void) {
    this.identity = Object.freeze({ context, recording });
    this.releaseResources = resources.acquire();
    this.schedule();
  }

  private schedule(): void {
    if (this.stopping || this.failure || this.closed) return;
    this.timer = setTimeout(() => { void this.pollOnce().catch(error => this.fail(error)).finally(() => this.schedule()); }, 10);
    this.timer.unref();
  }

  private pollOnce(): Promise<'progress' | 'waiting' | 'settled'> {
    this.polling ??= this.drain().finally(() => { this.polling = undefined; });
    return this.polling;
  }

  /** The shared transfer lease covers byte ingestion and native ACK, not just the IPC read. */
  private async drain(): Promise<'progress' | 'waiting' | 'settled'> {
    this.cancellation.signal.throwIfAborted();
    if (this.failure) throw this.failure;
    const release = tryAcquireTraceTransfer(this.client, this.identity.context);
    if (!release) return 'waiting';
    try {
      if (!this.pending.length) {
        const reply = await this.client.request('context.trace.network.pull', this.identity, 2000) as { recording?: unknown; resources?: unknown; pending?: unknown };
        this.cancellation.signal.throwIfAborted();
        if (!reply || reply.recording !== this.identity.recording || typeof reply.pending !== 'boolean' || !Array.isArray(reply.resources) || reply.resources.length > 64) throw protocol('invalid original network resource batch');
        const tokens = new Set<string>();
        this.pending = reply.resources.map((value: ResourceMetadata) => {
          if (!value || Object.keys(value).length !== 3 || typeof value.token !== 'string' || !/^network-resource-[a-f0-9]{16}$/.test(value.token)
            || tokens.has(value.token) || this.captured.has(value.token) || typeof value.formEncoded !== 'boolean'
            || !Number.isSafeInteger(value.byteLength) || value.byteLength < 0 || value.byteLength > maximumResourceBytes) throw protocol('invalid original network resource metadata');
          tokens.add(value.token); return value;
        });
        if (!this.pending.length) return reply.pending ? 'waiting' : 'settled';
      }
      const metadata = this.pending.shift()!;
      const parameters = { ...this.identity, token: metadata.token };
      const bytes = await this.client.requestBinary('context.trace.network.take', parameters, 2000, metadata.byteLength);
      this.cancellation.signal.throwIfAborted();
      if (!Buffer.isBuffer(bytes) || bytes.length !== metadata.byteLength) throw protocol('network resource length changed');
      const formParameters = metadata.formEncoded ? parseForm(bytes) : undefined;
      const retainedBytes = 512 + (formParameters ? Buffer.byteLength(JSON.stringify(formParameters)) : 0);
      if (this.captured.size >= 32768 || this.metadataBytes + retainedBytes > 16 * 1024 * 1024) throw limited('network resource metadata allowance exhausted');
      const resource = await this.resources.captureBytes(bytes, this.cancellation.signal);
      this.cancellation.signal.throwIfAborted();
      this.metadataBytes += retainedBytes;
      this.captured.set(metadata.token, { resource, ...(formParameters ? { formParameters } : {}) });
      await this.client.request('context.trace.network.ingested', parameters, 2000);
      return 'progress';
    } finally { release(); }
  }

  /** Read exactly one sealed prefix; later completion can settle only its already-admitted body cells. */
  async exportChunk(chunk: NativeTraceChunk, writer: TraceWriter, pageIdentity: (page: string) => string, signal?: AbortSignal): Promise<void> {
    const abort = () => this.fail(signal!.reason);
    if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
    try {
      if (chunk.identity.context !== this.identity.context || chunk.identity.recording !== this.identity.recording || !chunk.clock) throw protocol('network chunk does not belong to its original recording');
      await chunk.seal();
      for (let index = 0; index <= 65536; index++) {
        let entry: { done?: unknown; ready?: unknown; index?: unknown; count?: unknown; metadata?: unknown; body?: unknown };
        for (;;) {
          this.cancellation.signal.throwIfAborted();
          if (this.failure) throw this.failure;
          entry = await this.client.request('context.trace.network.entry', { ...chunk.identity, index }, 2000) as typeof entry;
          if (entry?.done === true) {
            if (entry.count !== index) throw protocol('sealed network prefix count changed');
            return;
          }
          if (!entry || entry.index !== index || typeof entry.ready !== 'boolean') throw protocol('invalid sealed network entry');
          if (entry.ready) break;
          if (await this.pollOnce() !== 'progress') await idle();
        }
        if (index === 65536) throw limited('sealed network prefix exceeds its version allowance');
        const metadata = entry.metadata as { page?: unknown; nativeTime?: unknown; responseHeadersWallTime?: unknown; requestPostData?: { token?: unknown } };
        const body = entry.body as NetworkTraceBody;
        if (!metadata || typeof metadata.page !== 'string' || typeof metadata.nativeTime !== 'number' || !Number.isFinite(metadata.nativeTime)
          || typeof metadata.responseHeadersWallTime !== 'number' || !Number.isFinite(metadata.responseHeadersWallTime) || !body) throw protocol('invalid original network clock or page identity');
        const tokens = [metadata.requestPostData?.token, body.kind === 'resource' ? body.token : undefined].filter(token => token !== undefined);
        for (const token of tokens) {
          if (typeof token !== 'string') throw protocol('invalid original network token');
          while (!this.captured.has(token)) {
            const progress = await this.pollOnce();
            if (progress === 'settled') throw protocol('sealed entry references an unavailable original resource');
            if (progress === 'waiting') await idle();
          }
        }
        const converted = convertNetworkTraceEntry(metadata, body, {
          pageReference: pageIdentity(metadata.page), monotonicTime: metadata.nativeTime + chunk.clock.offset, cookieWallTime: metadata.responseHeadersWallTime,
          resolveResource: token => {
            const captured = this.captured.get(token);
            if (!captured) throw protocol('original network resource is not ingested');
            writer.addResource(`resources/${captured.resource.contentHash}`, captured.resource);
            return { alias: captured.resource.contentHash, byteLength: captured.resource.byteLength, ...(captured.formParameters ? { formParameters: captured.formParameters } : {}) };
          },
        });
        await writer.appendNetwork({ type: 'resource-snapshot', snapshot: converted }, this.cancellation.signal);
      }
    } catch (error) { this.fail(error); writer.fail(error); throw error; }
    finally { signal?.removeEventListener('abort', abort); }
  }

  fail(error: unknown): void {
    if (this.failure) return;
    this.failure = error;
    this.cancellation.abort(error);
    clearTimeout(this.timer);
    this.onFailure(error);
    if (!this.closed) this.failureWork = this.client.request('context.trace.recording.fail', { ...this.identity, message: 'host network collection failed' }, 2000).then(() => {}, () => {});
  }

  stop(): Promise<void> {
    if (!this.stopWork) {
      this.stopping = true;
      clearTimeout(this.timer);
      this.stopWork = (async () => {
        try { await this.polling; } catch (error) { this.fail(error); }
        finally { await this.failureWork; this.pending = []; this.captured.clear(); this.releaseResources(); }
      })();
    }
    return this.stopWork;
  }

  ownerClosed(): void {
    this.closed = true;
    this.cancellation.abort(failure('TargetClosedError', 'tracing.network', 'context closed'));
    void this.stop();
  }
}

function parseForm(bytes: Buffer): NetworkTraceHeader[] {
  if (bytes.length > 256 * 1024) throw limited('form parameter data exceeds 256 KiB');
  let separators = 0;
  for (const byte of bytes) if (byte === 38 && ++separators >= 2048) throw limited('form parameter count exceeds 2048');
  return [...new URLSearchParams(bytes.toString())].map(([name, value]) => ({ name, value }));
}
