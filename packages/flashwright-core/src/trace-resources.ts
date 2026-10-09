import { constants } from 'node:fs';
import { open, mkdtemp, rename, rm, type FileHandle } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { failure } from './errors.js';

export const maximumSourceBytes = 8 * 1024 * 1024;
const maximumResourceBytes = 16 * 1024 * 1024;
const maximumRecordingBytes = 256 * 1024 * 1024;
const maximumResources = 8192;

export interface TraceResource {
  readonly path: string;
  readonly contentHash: string;
  readonly byteLength: number;
}

/** Immutable recording resources outlive individual chunks and their archive readers. */
export class TraceResources {
  private readonly resources = new Map<string, TraceResource>();
  private readonly publishing = new Map<string, Promise<TraceResource>>();
  private bytes = 0;
  private ingests = 0;
  private leases = 0;
  private closing = false;
  private disposal: Promise<void> | undefined;
  private drained: (() => void) | undefined;

  private constructor(readonly directory: string) {}

  static async create(): Promise<TraceResources> {
    return new TraceResources(await mkdtemp(join(tmpdir(), 'flashwright-trace-resources-')));
  }

  acquire(): () => void {
    if (this.closing) throw failure('TargetClosedError', 'tracing.resources', 'resource recording is closed');
    this.leases++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.leases--;
      this.notifyDrained();
    };
  }

  owns(resource: TraceResource): boolean { return this.resources.get(resource.contentHash) === resource; }

  /** Nonblocking open closes the pathname-to-FIFO race; only regular files are read. */
  async captureFile(path: string, signal: AbortSignal, maximumBytes = maximumResourceBytes): Promise<TraceResource | undefined> {
    this.assertCaptureOpen(signal);
    if (this.ingests >= 2) throw failure('ResourceLimitError', 'tracing.resources', 'resource ingestion exceeds two concurrent files');
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0 || maximumBytes > maximumResourceBytes) {
      throw failure('InvalidArgumentError', 'tracing.resources', 'invalid resource byte limit');
    }
    this.ingests++;
    let source: FileHandle | undefined;
    let temporary: FileHandle | undefined;
    let temporaryPath: string | undefined;
    let reservedBytes = 0;
    try {
      try { source = await open(path, constants.O_RDONLY | constants.O_NONBLOCK); }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'ELOOP') return undefined;
        throw error;
      }
      this.assertCaptureOpen(signal);
      const before = await source.stat({ bigint: true });
      if (!before.isFile()) return undefined;
      if (before.size > BigInt(maximumBytes)) throw failure('ResourceLimitError', 'tracing.resources', 'resource exceeds its byte limit');
      temporaryPath = join(this.directory, `${randomUUID()}.tmp`);
      temporary = await open(temporaryPath, 'wx', 0o600);
      const hash = createHash('sha256');
      const buffer = Buffer.alloc(65536);
      for (;;) {
        this.assertCaptureOpen(signal);
        const { bytesRead } = await source.read(buffer, 0, buffer.length, null);
        this.assertCaptureOpen(signal);
        if (!bytesRead) break;
        if (reservedBytes + bytesRead > maximumBytes || this.bytes + bytesRead > maximumRecordingBytes) {
          throw failure('ResourceLimitError', 'tracing.resources', 'resource or recording byte limit exceeded');
        }
        reservedBytes += bytesRead;
        this.bytes += bytesRead;
        const bytes = buffer.subarray(0, bytesRead);
        hash.update(bytes);
        await temporary.writeFile(bytes);
      }
      const after = await source.stat({ bigint: true });
      if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || BigInt(reservedBytes) !== after.size) {
        throw failure('ProtocolError', 'tracing.resources', 'source file changed while its trace resource was captured');
      }
      await temporary.close();
      temporary = undefined;
      this.assertCaptureOpen(signal);
      const publication = await this.publish(temporaryPath, hash.digest('hex'), reservedBytes, signal);
      if (publication.stored) { temporaryPath = undefined; reservedBytes = 0; }
      this.assertCaptureOpen(signal);
      return publication.resource;
    } finally {
      try { await temporary?.close(); }
      finally {
        try { if (temporaryPath) await rm(temporaryPath, { force: true }); }
        finally {
          try { await source?.close(); }
          finally { this.bytes -= reservedBytes; this.ingests--; this.notifyDrained(); }
        }
      }
    }
  }

  /** The internal caller transfers exclusive buffer ownership through this ingest. */
  async captureBytes(bytes: Buffer, signal: AbortSignal): Promise<TraceResource> {
    this.assertCaptureOpen(signal);
    if (this.ingests >= 2) throw failure('ResourceLimitError', 'tracing.resources', 'resource ingestion exceeds two concurrent resources');
    if (bytes.length > maximumResourceBytes || this.bytes + bytes.length > maximumRecordingBytes) {
      throw failure('ResourceLimitError', 'tracing.resources', 'resource or recording byte limit exceeded');
    }
    this.ingests++;
    this.bytes += bytes.length;
    let reservedBytes = bytes.length;
    let temporaryPath: string | undefined = join(this.directory, `${randomUUID()}.tmp`);
    let temporary: FileHandle | undefined;
    try {
      const contentHash = createHash('sha256').update(bytes).digest('hex');
      temporary = await open(temporaryPath, 'wx', 0o600);
      this.assertCaptureOpen(signal);
      await temporary.writeFile(bytes);
      await temporary.close();
      temporary = undefined;
      const publication = await this.publish(temporaryPath, contentHash, reservedBytes, signal);
      if (publication.stored) { temporaryPath = undefined; reservedBytes = 0; }
      this.assertCaptureOpen(signal);
      return publication.resource;
    } finally {
      try { await temporary?.close(); }
      finally {
        try { if (temporaryPath) await rm(temporaryPath, { force: true }); }
        finally { this.bytes -= reservedBytes; this.ingests--; this.notifyDrained(); }
      }
    }
  }

  /** Shared publication keeps file and binary ingests from exposing unfinished blobs. */
  private async publish(temporaryPath: string, contentHash: string, byteLength: number, signal: AbortSignal): Promise<{ resource: TraceResource; stored: boolean }> {
    this.assertCaptureOpen(signal);
    const pendingPublication = this.publishing.get(contentHash);
    const existing = pendingPublication ? await pendingPublication : this.resources.get(contentHash);
    this.assertCaptureOpen(signal);
    if (existing) {
      if (existing.byteLength !== byteLength) throw failure('ProtocolError', 'tracing.resources', 'resource content hash collision');
      return { resource: existing, stored: false };
    }
    if (this.resources.size + this.publishing.size >= maximumResources) throw failure('ResourceLimitError', 'tracing.resources', 'recording exceeds 8192 resource blobs');
    const resource = Object.freeze({ path: join(this.directory, contentHash), contentHash, byteLength });
    const publication = rename(temporaryPath, resource.path).then(() => {
      this.resources.set(contentHash, resource);
      return resource;
    });
    this.publishing.set(contentHash, publication);
    try { await publication; }
    finally { this.publishing.delete(contentHash); }
    // The caller transfers its byte reservation before checking closure after commit.
    return { resource, stored: true };
  }

  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.closing = true;
    this.disposal = (async () => {
      if (this.leases || this.ingests) await new Promise<void>(resolve => { this.drained = resolve; });
      await rm(this.directory, { recursive: true, force: true });
      this.resources.clear();
      this.bytes = 0;
    })();
    return this.disposal;
  }

  private notifyDrained(): void {
    if (!this.leases && !this.ingests) this.drained?.();
  }

  private assertCaptureOpen(signal: AbortSignal): void {
    signal.throwIfAborted();
    if (this.closing) throw failure('TargetClosedError', 'tracing.resources', 'resource recording is closed');
  }
}
