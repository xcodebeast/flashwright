import { constants } from 'node:fs';
import { open, mkdtemp, rename, rm, type FileHandle } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { failure } from './errors.js';
import { traceStorageBudget, TraceFileCustody, type TraceStorageBudget, type TraceStorageLease } from './trace-storage-budget.js';

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
  private activeLeases = 0;
  private archiveLeases = 0;
  private closing = false;
  private retirement: Promise<void> | undefined;
  private disposal: Promise<void> | undefined;
  private activeDrained: (() => void) | undefined;
  private drained: (() => void) | undefined;
  private readonly files = new TraceFileCustody();

  private constructor(readonly directory: string, readonly storageBudget: TraceStorageBudget, private readonly storage: TraceStorageLease) {}

  static async create(budget = traceStorageBudget): Promise<TraceResources> {
    const storage = budget.acquire();
    try { return new TraceResources(await mkdtemp(join(tmpdir(), 'flashwright-trace-resources-')), budget, storage); }
    catch (error) { storage.release(); throw error; }
  }

  acquire(): () => void {
    if (this.closing || this.files.uncertain) throw failure('TargetClosedError', 'tracing.resources', 'resource recording is closed');
    this.activeLeases++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.activeLeases--;
      this.notifyDrained();
    };
  }

  /** Sealed archives retain bytes without keeping a retired recording's active work alive. */
  acquireArchive(): () => Promise<void> {
    if (this.closing || this.files.uncertain) throw failure('TargetClosedError', 'tracing.resources', 'resource recording is closed');
    this.archiveLeases++;
    let releaseWork: Promise<void> | undefined;
    return () => {
      if (releaseWork) return releaseWork;
      this.archiveLeases--;
      this.notifyDrained();
      releaseWork = this.closing && !this.archiveLeases && !this.activeLeases && !this.ingests
        ? this.disposal! : Promise.resolve();
      return releaseWork;
    };
  }

  owns(resource: TraceResource): boolean { return this.resources.get(resource.contentHash) === resource; }

  /** Private resource readers share the store's original file and byte custody. */
  closeReader(file: FileHandle): Promise<void> { return this.files.close(file); }

  /** Nonblocking open closes the pathname-to-FIFO race; only regular files are read. */
  async captureFile(path: string, signal: AbortSignal, maximumBytes = maximumResourceBytes, encoding?: 'utf8'): Promise<TraceResource | undefined> {
    this.assertCaptureOpen(signal);
    if (this.ingests >= 2) throw failure('ResourceLimitError', 'tracing.resources', 'resource ingestion exceeds two concurrent files');
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0 || maximumBytes > maximumResourceBytes) {
      throw failure('InvalidArgumentError', 'tracing.resources', 'invalid resource byte limit');
    }
    if (encoding !== undefined && encoding !== 'utf8') throw failure('InvalidArgumentError', 'tracing.resources', 'invalid resource text encoding');
    this.ingests++;
    let source: FileHandle | undefined;
    let temporary: FileHandle | undefined;
    let temporaryPath: string | undefined;
    let reservedBytes = 0;
    let failed = false;
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
      this.storage.retain(0, 1);
      temporaryPath = join(this.directory, `${randomUUID()}.tmp`);
      temporary = await open(temporaryPath, 'wx', 0o600);
      const hash = createHash('sha256');
      const buffer = Buffer.alloc(65536);
      const decoder = encoding === 'utf8' ? new StringDecoder('utf8') : undefined;
      let sourceBytes = 0;
      const write = async (bytes: Buffer): Promise<void> => {
        if (reservedBytes + bytes.length > maximumResourceBytes || this.bytes + bytes.length > maximumRecordingBytes) {
          throw failure('ResourceLimitError', 'tracing.resources', 'resource or recording byte limit exceeded');
        }
        this.storage.retain(bytes.length);
        reservedBytes += bytes.length;
        this.bytes += bytes.length;
        hash.update(bytes);
        await temporary!.writeFile(bytes);
      };
      for (;;) {
        this.assertCaptureOpen(signal);
        const { bytesRead } = await source.read(buffer, 0, buffer.length, null);
        this.assertCaptureOpen(signal);
        if (!bytesRead) break;
        if (sourceBytes + bytesRead > maximumBytes) {
          throw failure('ResourceLimitError', 'tracing.resources', 'resource or recording byte limit exceeded');
        }
        sourceBytes += bytesRead;
        const bytes = buffer.subarray(0, bytesRead);
        await write(decoder ? Buffer.from(decoder.write(bytes), 'utf8') : bytes);
      }
      if (decoder) await write(Buffer.from(decoder.end(), 'utf8'));
      const after = await source.stat({ bigint: true });
      if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || BigInt(sourceBytes) !== after.size) {
        throw failure('ProtocolError', 'tracing.resources', 'source file changed while its trace resource was captured');
      }
      await temporary.close();
      temporary = undefined;
      this.assertCaptureOpen(signal);
      const publication = await this.publish(temporaryPath, hash.digest('hex'), reservedBytes, signal);
      if (publication.stored) { temporaryPath = undefined; reservedBytes = 0; }
      this.assertCaptureOpen(signal);
      return publication.resource;
    } catch (error) { failed = true; throw error; }
    finally {
      try { await this.cleanupIngest(temporary, temporaryPath, reservedBytes, source); }
      catch (error) { if (!failed) throw error; }
    }
  }

  /** The internal caller transfers exclusive buffer ownership through this ingest. */
  async captureBytes(bytes: Buffer, signal: AbortSignal): Promise<TraceResource> {
    this.assertCaptureOpen(signal);
    if (this.ingests >= 2) throw failure('ResourceLimitError', 'tracing.resources', 'resource ingestion exceeds two concurrent resources');
    if (bytes.length > maximumResourceBytes || this.bytes + bytes.length > maximumRecordingBytes) {
      throw failure('ResourceLimitError', 'tracing.resources', 'resource or recording byte limit exceeded');
    }
    this.storage.retain(bytes.length, 1);
    this.ingests++;
    this.bytes += bytes.length;
    let reservedBytes = bytes.length;
    let temporaryPath: string | undefined = join(this.directory, `${randomUUID()}.tmp`);
    let temporary: FileHandle | undefined;
    let failed = false;
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
    } catch (error) { failed = true; throw error; }
    finally {
      try { await this.cleanupIngest(temporary, temporaryPath, reservedBytes); }
      catch (error) { if (!failed) throw error; }
    }
  }

  /** A duplicate or failed ingest returns credit only after both handle and pathname custody end. */
  private async cleanupIngest(temporary: FileHandle | undefined, path: string | undefined, bytes: number, source?: FileHandle): Promise<void> {
    let originalFailure: unknown;
    let failed = false;
    const settle = async (work: Promise<unknown>): Promise<boolean> => {
      try { await work; return true; }
      catch (error) { if (!failed) { originalFailure = error; failed = true; } return false; }
    };
    const closed = !temporary || await settle(this.files.close(temporary));
    const removed = path === undefined || await settle(rm(path, { force: true }));
    if (path !== undefined && closed && removed) {
      this.storage.remove(bytes, 1);
      this.bytes -= bytes;
    }
    if (source) await settle(this.files.close(source));
    this.ingests--;
    this.notifyDrained();
    if (failed) throw originalFailure;
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

  /** Retire active capture; a retained archive owns cleanup after this boundary returns. */
  retire(): Promise<void> {
    if (this.retirement) return this.retirement;
    const disposal = this.dispose();
    this.retirement = (async () => {
      if (this.activeLeases || this.ingests) await new Promise<void>(resolve => { this.activeDrained = resolve; });
      if (!this.archiveLeases) await disposal;
    })();
    return this.retirement;
  }

  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.closing = true;
    this.disposal = (async () => {
      if (this.activeLeases || this.archiveLeases || this.ingests) await new Promise<void>(resolve => { this.drained = resolve; });
      await this.files.settle();
      await rm(this.directory, { recursive: true, force: true });
      this.storage.release();
      this.resources.clear();
      this.bytes = 0;
    })();
    return this.disposal;
  }

  private notifyDrained(): void {
    if (!this.activeLeases && !this.ingests) {
      this.activeDrained?.();
      if (!this.archiveLeases) this.drained?.();
    }
  }

  private assertCaptureOpen(signal: AbortSignal): void {
    signal.throwIfAborted();
    if (this.closing || this.files.uncertain) throw failure('TargetClosedError', 'tracing.resources', 'resource recording is closed');
  }
}
