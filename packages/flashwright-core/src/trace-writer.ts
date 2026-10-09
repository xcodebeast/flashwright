import { open, mkdtemp, rm, mkdir, rename, type FileHandle } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { failure } from './errors.js';
import { TraceResources, maximumSourceBytes, type TraceResource } from './trace-resources.js';
import { prepareSnapshotRecord } from './trace-snapshot-record.js';

const maximumEvents = 100000;
const maximumBytes = 64 * 1024 * 1024;
const maximumQueuedBytes = 4 * 1024 * 1024;
const maximumEventBytes = 256 * 1024;
const maximumArchiveBytes = 512 * 1024 * 1024;
const maximumAliases = 8192;
interface ArchiveEntry { name: string; path?: string; byteLength: number; contentHash?: string }

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
  private archiveCleanup: Promise<void> | undefined;
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
        try { if (!this.failure) await this.file.writeFile(encoded); }
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
          signal.throwIfAborted();
        } catch (error) { this.fail(error); }
        finally { this.queuedBytes -= encoded.length; }
      });
      return this.writes.then(() => { if (this.failure) throw this.failure; });
    } catch (error) { this.fail(error); return Promise.reject(error); }
  }
  fail(error: unknown): void { this.failure ??= error; }
  async finish(path: string | undefined, signal: AbortSignal, beginCommit: () => void = () => {}): Promise<void> {
    this.sealed = true;
    await this.writes;
    await Promise.all([this.file.close(), this.networkFile?.close()]);
    if (this.failure) throw this.failure;
    signal.throwIfAborted();
    if (path === undefined) return;
    for (const sourcePath of this.sourcePaths) {
      const resource = await this.resources.captureFile(sourcePath, signal, maximumSourceBytes);
      if (resource) this.addAlias(`resources/src@${createHash('sha1').update(sourcePath).digest('hex')}.txt`, resource);
    }
    const entries: ArchiveEntry[] = [
      { name: 'trace.trace', path: join(this.directory, 'trace.trace'), byteLength: this.bytes },
      { name: 'trace.network', byteLength: this.networkBytes, ...(this.networkFile ? { path: join(this.directory, 'trace.network') } : {}) },
      ...[...this.aliases].map(([name, resource]) => ({ name, ...resource })),
    ];
    await exportArchive(entries, path, signal, beginCommit, cleanup => { this.archiveCleanup = cleanup; void cleanup.catch(() => {}); });
  }
  dispose(): Promise<void> {
    this.sealed = true;
    this.disposal ??= (async () => {
      await this.writes;
      try { await this.archiveCleanup; await Promise.all([this.file.close(), this.networkFile?.close()]); }
      finally {
        try { await rm(this.directory, { recursive: true, force: true }); }
        finally {
          // Unfinished user calls may retain a disposed chunk; release its bounded metadata now.
          this.sourcePaths.clear();
          this.aliases.clear();
          this.releaseResources();
        }
      }
    })();
    return this.disposal;
  }
}

const checksumTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

/** Export a fixed manifest with bounded ZIP metadata and verified immutable resources. */
async function exportArchive(entries: readonly ArchiveEntry[], destination: string, signal: AbortSignal, beginCommit: () => void, ownCleanup: (cleanup: Promise<void>) => void): Promise<void> {
  const centralBytes = entries.reduce((total, entry) => total + 46 + Buffer.byteLength(entry.name), 0);
  const archiveBytes = 22 + entries.reduce((total, entry) => total + 92 + 2 * Buffer.byteLength(entry.name) + entry.byteLength, 0);
  if (entries.length > maximumAliases + 2 || centralBytes > 4 * 1024 * 1024 || archiveBytes > maximumArchiveBytes) {
    throw failure('ResourceLimitError', 'tracing', 'archive entry, byte or central-directory limit exceeded');
  }
  signal.throwIfAborted();
  await mkdir(dirname(destination), { recursive: true });
  const temporary = `${destination}.${randomUUID()}.tmp`;
  const archive = await open(temporary, 'wx', 0o600);
  let offset = 0;
  const centralDirectory: Buffer[] = [];
  const write = async (bytes: Buffer): Promise<void> => {
    signal.throwIfAborted();
    await archive.writeFile(bytes);
    offset += bytes.length;
  };
  try {
    for (const entry of entries) {
      const nameBytes = Buffer.from(entry.name);
      const localOffset = offset;
      const header = Buffer.alloc(30);
      header.writeUInt32LE(0x04034b50, 0);
      header.writeUInt16LE(20, 4);
      header.writeUInt16LE(8, 6);
      header.writeUInt16LE(33, 12);
      header.writeUInt16LE(nameBytes.length, 26);
      await write(Buffer.concat([header, nameBytes]));
      let checksum = 0xffffffff;
      let size = 0;
      const contentHash = entry.contentHash ? createHash('sha256') : undefined;
      if (entry.path !== undefined) {
        for await (const part of createReadStream(entry.path, { highWaterMark: 65536, signal })) {
          const bytes = part as Buffer;
          for (const byte of bytes) checksum = checksumTable[(checksum ^ byte) & 255]! ^ (checksum >>> 8);
          size += bytes.length;
          if (size > entry.byteLength) throw failure('ProtocolError', 'tracing', 'archive input grew after sealing');
          contentHash?.update(bytes);
          await write(bytes);
        }
      }
      if (size !== entry.byteLength || contentHash && contentHash.digest('hex') !== entry.contentHash) {
        throw failure('ProtocolError', 'tracing', 'archive input changed after sealing');
      }
      checksum = (checksum ^ 0xffffffff) >>> 0;
      const descriptor = Buffer.alloc(16);
      descriptor.writeUInt32LE(0x08074b50, 0);
      descriptor.writeUInt32LE(checksum, 4);
      descriptor.writeUInt32LE(size, 8);
      descriptor.writeUInt32LE(size, 12);
      await write(descriptor);
      const central = Buffer.alloc(46);
      central.writeUInt32LE(0x02014b50, 0);
      central.writeUInt16LE(20, 4);
      central.writeUInt16LE(20, 6);
      central.writeUInt16LE(8, 8);
      central.writeUInt16LE(33, 14);
      central.writeUInt32LE(checksum, 16);
      central.writeUInt32LE(size, 20);
      central.writeUInt32LE(size, 24);
      central.writeUInt16LE(nameBytes.length, 28);
      central.writeUInt32LE(localOffset, 42);
      centralDirectory.push(Buffer.concat([central, nameBytes]));
    }
    const centralOffset = offset;
    for (const record of centralDirectory) await write(record);
    const footer = Buffer.alloc(22);
    footer.writeUInt32LE(0x06054b50, 0);
    footer.writeUInt16LE(entries.length, 8);
    footer.writeUInt16LE(entries.length, 10);
    footer.writeUInt32LE(offset - centralOffset, 12);
    footer.writeUInt32LE(centralOffset, 16);
    await write(footer);
    await archive.close();
    signal.throwIfAborted();
    // Once rename is dispatched, cancellation cannot honestly promise that the
    // destination remains untouched. The controller awaits its definitive result.
    beginCommit();
    await rename(temporary, destination);
  } finally {
    ownCleanup((async () => {
      try { await archive.close(); }
      finally { await rm(temporary, { force: true }); }
    })());
  }
}
