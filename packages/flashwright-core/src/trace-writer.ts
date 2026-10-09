import { open, mkdtemp, rm, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { failure } from './errors.js';
import { TraceResources, maximumSourceBytes, type TraceResource } from './trace-resources.js';
import { prepareSnapshotRecord } from './trace-snapshot-record.js';
import { SealedTraceArchive, type TraceArchiveEntry } from './trace-archive.js';

const maximumEvents = 100000;
const maximumBytes = 64 * 1024 * 1024;
const maximumQueuedBytes = 4 * 1024 * 1024;
const maximumEventBytes = 256 * 1024;
const maximumAliases = 8192;

/** One chunk owns its stream and every pending write until cleanup settles. */
export class TraceWriter {
  failure: unknown;
  private events = 0;
  private bytes = 0;
  private networkBytes = 0;
  private networkFile: FileHandle | undefined;
  private queuedBytes = 0;
  private snapshotPending = false;
  private writes: Promise<void> = Promise.resolve();
  private readonly streamHash = createHash('sha256');
  private readonly networkHash = createHash('sha256');
  private preparingArchive: Promise<SealedTraceArchive> | undefined;
  private transferred = false;
  private releaseArchiveResources: (() => Promise<void>) | undefined;
  private removingFiles: Promise<void> | undefined;
  private readonly sourcePaths = new Set<string>();
  private readonly aliases = new Map<string, TraceResource>();
  private sourcePathBytes = 0;
  private sealed = false;
  private disposal: Promise<void> | undefined;
  private constructor(readonly directory: string, private readonly file: FileHandle, private readonly resources: TraceResources, private readonly releaseResources: () => void) {}
  static async create(resources: TraceResources): Promise<TraceWriter> {
    const release = resources.acquire();
    let directory: string | undefined;
    try {
      directory = await mkdtemp(join(tmpdir(), 'flashwright-trace-'));
      return new TraceWriter(directory, await open(join(directory, 'trace.trace'), 'wx', 0o600), resources, release);
    } catch (error) {
      try { if (directory) await rm(directory, { recursive: true, force: true }); }
      finally { release(); }
      throw error;
    }
  }
  referenceSources(locations: readonly { file: string }[]): void {
    if (this.failure || this.sealed) return;
    for (const { file } of locations) {
      if (this.sourcePaths.has(file)) continue;
      const bytes = Buffer.byteLength(file);
      if (file.length > 32768 || this.sourcePaths.size >= 4096 || this.sourcePathBytes + bytes > 1024 * 1024) {
        this.fail(failure('ResourceLimitError', 'tracing.sources', 'source path count or metadata limit exceeded'));
        return;
      }
      this.sourcePaths.add(file);
      this.sourcePathBytes += bytes;
    }
  }
  addResource(name: string, resource: TraceResource): void {
    if (this.sealed) throw failure('ProtocolError', 'tracing.resources', 'chunk resource manifest is sealed');
    this.addAlias(name, resource);
  }
  private addAlias(name: string, resource: TraceResource): void {
    if (!/^resources\/(?:src@[a-f0-9]{40}\.txt|[a-f0-9]{40,64}(?:\.[a-z0-9]{1,8})?)$/.test(name) || !this.resources.owns(resource)) {
      throw failure('ProtocolError', 'tracing.resources', 'invalid resource alias or ownership');
    }
    const previous = this.aliases.get(name);
    if (previous && previous !== resource) throw failure('ProtocolError', 'tracing.resources', 'resource alias has conflicting content');
    if (!previous && this.aliases.size >= maximumAliases) throw failure('ResourceLimitError', 'tracing.resources', 'chunk exceeds 8192 resource aliases');
    this.aliases.set(name, resource);
  }
  append(event: unknown): void {
    if (this.failure) return;
    if (this.sealed) { this.fail(failure('ProtocolError', 'tracing', 'chunk event stream is sealed')); return; }
    try {
      const encoded = Buffer.from(JSON.stringify(event) + '\n');
      if (++this.events > maximumEvents || encoded.length > maximumEventBytes || this.bytes + this.networkBytes + encoded.length > maximumBytes || this.queuedBytes + encoded.length > maximumQueuedBytes) {
        throw failure('ResourceLimitError', 'tracing', 'trace exceeds its event, stream or pending-write limit');
      }
      this.bytes += encoded.length;
      this.queuedBytes += encoded.length;
      this.writes = this.writes.then(async () => {
        try { if (!this.failure) { await this.file.writeFile(encoded); this.streamHash.update(encoded); } }
        catch (error) { this.fail(error); }
        finally { this.queuedBytes -= encoded.length; }
      });
    } catch (error) { this.fail(error); }
  }
  /** Serialize one admitted snapshot in event order; partial lines quarantine the whole chunk. */
  appendSnapshot(event: unknown, signal: AbortSignal): Promise<void> {
    try {
      if (this.failure) throw this.failure;
      if (this.sealed) throw failure('ProtocolError', 'tracing.snapshot', 'chunk event stream is sealed');
      if (this.snapshotPending) throw failure('ResourceLimitError', 'tracing.snapshot', 'one snapshot record is already pending');
      signal.throwIfAborted();
      const record = prepareSnapshotRecord(event);
      if (this.events + 1 > maximumEvents || this.bytes + this.networkBytes + record.byteLength > maximumBytes) throw failure('ResourceLimitError', 'tracing.snapshot', 'trace exceeds its event or stream limit');
      this.events++;
      this.bytes += record.byteLength;
      this.snapshotPending = true;
      this.writes = this.writes.then(async () => {
        try {
          if (this.failure) throw this.failure;
          let written = 0;
          for (const bytes of record.chunks()) {
            if (this.failure) throw this.failure;
            signal.throwIfAborted();
            await this.file.writeFile(bytes);
            this.streamHash.update(bytes);
            written += bytes.length;
          }
          signal.throwIfAborted();
          if (written !== record.byteLength) throw failure('ProtocolError', 'tracing.snapshot', 'snapshot length changed after admission');
        } catch (error) { this.fail(error); }
        finally { this.snapshotPending = false; }
      });
      return this.writes.then(() => { if (this.failure) throw this.failure; });
    } catch (error) { this.fail(error); return Promise.reject(error); }
  }
  /** Network and action records share the aggregate archive stream budget and ordered write queue. */
  appendNetwork(event: unknown, signal: AbortSignal): Promise<void> {
    try {
      if (this.failure) throw this.failure;
      if (this.sealed) throw failure('ProtocolError', 'tracing.network', 'chunk event stream is sealed');
      signal.throwIfAborted();
      const encoded = Buffer.from(JSON.stringify(event) + '\n');
      if (this.events + 1 > maximumEvents || encoded.length > 2 * 1024 * 1024 || this.bytes + this.networkBytes + encoded.length > maximumBytes || this.queuedBytes + encoded.length > maximumQueuedBytes) throw failure('ResourceLimitError', 'tracing.network', 'network record exceeds the trace stream or queued-write allowance');
      this.events++; this.networkBytes += encoded.length; this.queuedBytes += encoded.length;
      this.writes = this.writes.then(async () => {
        try {
          if (this.failure) throw this.failure;
          signal.throwIfAborted();
          this.networkFile ??= await open(join(this.directory, 'trace.network'), 'wx', 0o600);
          signal.throwIfAborted();
          await this.networkFile.writeFile(encoded);
          this.networkHash.update(encoded);
          signal.throwIfAborted();
        } catch (error) { this.fail(error); }
        finally { this.queuedBytes -= encoded.length; }
      });
      return this.writes.then(() => { if (this.failure) throw this.failure; });
    } catch (error) { this.fail(error); return Promise.reject(error); }
  }
  fail(error: unknown): void { this.failure ??= error; }
  async finish(path: string | undefined, signal: AbortSignal, beginCommit: () => void = () => {}): Promise<void> {
    if (path === undefined) { await this.sealStream(signal); return; }
    const archive = await this.takeArchive(signal);
    try { await archive.export(path, signal, beginCommit); }
    catch (error) { await archive.dispose().catch(() => {}); throw error; }
    await archive.dispose();
  }

  /** The caller takes sole cleanup ownership after complete, uncancelled manifest preparation. */
  takeArchive(signal: AbortSignal): Promise<SealedTraceArchive> {
    if (this.preparingArchive || this.sealed || this.disposal) return Promise.reject(failure('ProtocolError', 'tracing.archive', 'chunk has already been sealed or disposed'));
    this.preparingArchive = this.prepareArchive(signal);
    return this.preparingArchive;
  }

  private async sealStream(signal: AbortSignal): Promise<void> {
    this.sealed = true;
    await this.writes;
    await Promise.all([this.file.close(), this.networkFile?.close()]);
    if (this.failure) throw this.failure;
    signal.throwIfAborted();
  }

  private async prepareArchive(signal: AbortSignal): Promise<SealedTraceArchive> {
    await this.sealStream(signal);
    for (const sourcePath of this.sourcePaths) {
      if (this.disposal) throw failure('TargetClosedError', 'tracing.archive', 'writer was disposed during archive preparation');
      const resource = await this.resources.captureFile(sourcePath, signal, maximumSourceBytes);
      if (resource) this.addAlias(`resources/src@${createHash('sha1').update(sourcePath).digest('hex')}.txt`, resource);
    }
    signal.throwIfAborted();
    if (this.disposal) throw failure('TargetClosedError', 'tracing.archive', 'writer was disposed during archive preparation');
    const entries: TraceArchiveEntry[] = [
      { name: 'trace.trace', path: join(this.directory, 'trace.trace'), byteLength: this.bytes, contentHash: this.streamHash.digest('hex') },
      { name: 'trace.network', byteLength: this.networkBytes, contentHash: this.networkHash.digest('hex'), ...(this.networkFile ? { path: join(this.directory, 'trace.network') } : {}) },
      ...[...this.aliases].map(([name, resource]) => ({ name, ...resource })),
    ];
    const archive = new SealedTraceArchive(entries, () => this.removeFiles());
    this.releaseArchiveResources = this.resources.acquireArchive();
    this.releaseResources();
    this.transferred = true;
    this.sourcePaths.clear();
    this.aliases.clear();
    return archive;
  }

  dispose(): Promise<void> {
    this.sealed = true;
    this.disposal ??= (async () => {
      await this.preparingArchive?.catch(() => {});
      if (!this.transferred) await this.removeFiles();
      else await this.removingFiles;
    })();
    return this.disposal;
  }

  private removeFiles(): Promise<void> {
    this.removingFiles ??= (async () => {
      let originalFailure: unknown;
      let failed = false;
      try {
        await this.writes;
        try { await Promise.all([this.file.close(), this.networkFile?.close()]); }
        finally { await rm(this.directory, { recursive: true, force: true }); }
      } catch (error) { originalFailure = error; failed = true; }
      // Unfinished user calls may retain a disposed chunk; release its bounded metadata now.
      this.sourcePaths.clear();
      this.aliases.clear();
      this.releaseResources();
      try { await this.releaseArchiveResources?.(); }
      catch (error) {
        if (!failed) { originalFailure = error; failed = true; }
      }
      if (failed) throw originalFailure;
    })();
    return this.removingFiles;
  }
}
