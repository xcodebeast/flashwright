import { once } from 'node:events';
import { createReadStream } from 'node:fs';
import { resolve } from 'node:path';
import type { Readable } from 'node:stream';
import type { EngineClient } from './client.js';
import { failure, type FlashwrightError } from './errors.js';
import type { BrowserContext, Page } from './index.js';
import { instrumentTraceMethods } from './trace-hooks.js';
import type { Tracing } from './tracing.js';

/** A download belongs to its original context, even after its initiating page closes. */
export class Download {
  static {
    instrumentTraceMethods(this.prototype, 'Download', download => ({ tracing: download.contextTracing(), pageId: download.pageIdentifier }), {
      cancel: { capture: 'metadata-only' }, createReadStream: { capture: 'metadata-only' },
      delete: { capture: 'metadata-only' }, failure: { capture: 'metadata-only' },
      path: { capture: 'metadata-only' }, saveAs: { parameters: ['path'], capture: 'metadata-only' },
    });
  }
  private readonly contextOwner: BrowserContext;
  private readonly activeStreams = new Set<Readable>();
  private deleted = false;
  private readonly contextClosed = () => this.destroyStreams('download context has been closed');
  constructor(
    private readonly owner: Page,
    private readonly client: EngineClient,
    private readonly pageIdentifier: string,
    private readonly contextIdentifier: string,
    private readonly identifier: string,
    private readonly downloadURL: string,
    private readonly filename: string,
    private readonly contextTracing: () => Tracing,
    private readonly isContextClosed: () => boolean,
  ) { this.contextOwner = owner.context(); }
  page(): Page { return this.owner; }
  url(): string { return this.downloadURL; }
  suggestedFilename(): string { return this.filename; }
  async path(): Promise<string> {
    const path = await this.request('download.path');
    if (typeof path !== 'string') throw failure('ProtocolError', 'download.path', 'driver omitted completed download path');
    return path;
  }
  async failure(): Promise<string | null> {
    const result = await this.request('download.failure');
    if (result !== null && typeof result !== 'string') throw failure('ProtocolError', 'download.failure', 'driver omitted download failure outcome');
    return result;
  }
  async saveAs(path: string): Promise<void> {
    if (typeof path !== 'string') throw failure('InvalidArgumentError', 'download.saveAs', 'path must be a string');
    await this.request('download.saveAs', resolve(path));
  }
  async cancel(): Promise<void> { await this.request('download.cancel'); }
  async delete(): Promise<void> {
    await this.request('download.delete');
    this.deleted = true;
    this.destroyStreams('download has been deleted');
  }
  async createReadStream(): Promise<Readable> {
    const path = await this.path();
    const ownershipError = this.streamOwnershipError();
    if (ownershipError) throw ownershipError;
    const stream = createReadStream(path);
    // Teardown can precede the caller's first read; retain the error on the stream without an unhandled event.
    stream.once('error', () => {});
    this.trackStream(stream);
    try {
      await once(stream, 'open');
      const ownershipError = this.streamOwnershipError();
      if (ownershipError) { stream.destroy(ownershipError); throw ownershipError; }
    } catch (error) {
      stream.destroy();
      throw this.streamOwnershipError() ?? error;
    }
    return stream;
  }
  /** Only open or opening streams retain a context listener; completed streams release their owner. */
  private trackStream(stream: Readable): void {
    if (!this.activeStreams.size) this.contextOwner.on('close', this.contextClosed);
    this.activeStreams.add(stream);
    stream.once('close', () => {
      this.activeStreams.delete(stream);
      if (!this.activeStreams.size) this.contextOwner.off('close', this.contextClosed);
    });
  }
  private streamOwnershipError(): FlashwrightError | undefined {
    if (this.isContextClosed()) return failure('TargetClosedError', 'download.createReadStream', 'download context has been closed');
    if (this.deleted) return failure('TargetClosedError', 'download.createReadStream', 'download has been deleted');
    return undefined;
  }
  private destroyStreams(message: string): void {
    for (const stream of this.activeStreams) stream.destroy(failure('TargetClosedError', 'download.createReadStream', message));
  }
  private request(method: string, path?: string): Promise<unknown> {
    return this.client.request(method, { context: this.contextIdentifier, download: this.identifier, ...(path === undefined ? {} : { path }) });
  }
}

/** Raw browser metadata preserves exact strings while envelope identity fixes native ownership. */
export function receivedDownload(owner: Page, client: EngineClient, pageIdentifier: string, contextIdentifier: string, parameters: unknown, contextTracing: () => Tracing, isContextClosed: () => boolean): Download {
  const payload = parameters as { context?: unknown; download?: unknown; downloadJson?: unknown } | null;
  if (!payload || payload.context !== contextIdentifier || typeof payload.download !== 'string' || typeof payload.downloadJson !== 'string') throw failure('ProtocolError', 'download', 'driver omitted original download ownership');
  let metadata: unknown;
  try { metadata = JSON.parse(payload.downloadJson); }
  catch { throw failure('ProtocolError', 'download', 'driver supplied invalid download metadata'); }
  const details = metadata as { guid?: unknown; url?: unknown; suggestedFilename?: unknown } | null;
  if (!details || details.guid !== payload.download || typeof details.url !== 'string' || typeof details.suggestedFilename !== 'string') throw failure('ProtocolError', 'download', 'driver omitted download metadata or changed its identity');
  return new Download(owner, client, pageIdentifier, contextIdentifier, payload.download, details.url, details.suggestedFilename, contextTracing, isContextClosed);
}
