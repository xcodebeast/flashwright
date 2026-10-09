import { open, mkdir, rename, rm } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { failure } from './errors.js';

export interface TraceArchiveEntry {
  readonly name: string;
  readonly path?: string;
  readonly byteLength: number;
  readonly contentHash: string;
}

export interface TraceArchiveReader {
  readonly entries: readonly TraceArchiveEntry[];
  release(): void;
}

/** A sealed manifest owns its files until its one admitted reader and cleanup settle. */
export class SealedTraceArchive {
  private readonly entries: readonly TraceArchiveEntry[];
  private reading = false;
  private closing = false;
  private readerFinished: (() => void) | undefined;
  private disposal: Promise<void> | undefined;

  constructor(entries: readonly TraceArchiveEntry[], private readonly removeFiles: () => Promise<void>) {
    validateManifest(entries);
    this.entries = Object.freeze(entries.map(entry => Object.freeze({ ...entry })));
  }

  acquire(): TraceArchiveReader {
    if (this.closing) throw failure('TargetClosedError', 'tracing.archive', 'archive is being disposed');
    if (this.reading) throw failure('ResourceLimitError', 'tracing.archive', 'archive already has an active reader');
    this.reading = true;
    let released = false;
    return Object.freeze({ entries: this.entries, release: () => {
      if (released) return;
      released = true;
      this.reading = false;
      this.readerFinished?.();
    } });
  }

  async export(destination: string, signal: AbortSignal, beginCommit: () => void = () => {}): Promise<void> {
    const reader = this.acquire();
    let cleanup: Promise<void> | undefined;
    let originalFailure: unknown;
    let failed = false;
    try {
      await exportArchive(reader.entries, destination, signal, beginCommit, work => { cleanup = work; void work.catch(() => {}); });
    } catch (error) { originalFailure = error; failed = true; }
    finally {
      try { await cleanup; }
      catch (error) { if (!failed) { originalFailure = error; failed = true; } }
      finally { reader.release(); }
    }
    if (failed) throw originalFailure;
  }

  dispose(): Promise<void> {
    this.closing = true;
    this.disposal ??= (async () => {
      if (this.reading) await new Promise<void>(resolve => { this.readerFinished = resolve; });
      await this.removeFiles();
    })();
    return this.disposal;
  }
}

/** Check aggregate encoded size and member identity before accepting custody or touching output. */
function validateManifest(entries: readonly TraceArchiveEntry[]): void {
  if (entries.length > 8194) throw failure('ResourceLimitError', 'tracing.archive', 'archive exceeds its entry limit');
  let centralBytes = 0;
  let archiveBytes = 22;
  const names = new Set<string>();
  for (const entry of entries) {
    if (!/^(?:test\.trace|(?:[0-9]{1,9}-)?trace\.(?:trace|network|stacks)|resources\/(?:src@[a-f0-9]{40}\.txt|[a-f0-9]{40,64}(?:\.[a-z0-9]{1,8})?))$/.test(entry.name) || names.has(entry.name) ||
        !Number.isSafeInteger(entry.byteLength) || entry.byteLength < 0 || !/^[a-f0-9]{64}$/.test(entry.contentHash) ||
        (entry.path === undefined ? entry.byteLength !== 0 : typeof entry.path !== 'string' || !entry.path)) {
      throw failure('ProtocolError', 'tracing.archive', 'invalid or duplicate archive entry');
    }
    names.add(entry.name);
    const nameBytes = Buffer.byteLength(entry.name);
    centralBytes += 46 + nameBytes;
    archiveBytes += 92 + 2 * nameBytes + entry.byteLength;
    if (centralBytes > 4 * 1024 * 1024 || archiveBytes > 512 * 1024 * 1024) {
      throw failure('ResourceLimitError', 'tracing.archive', 'archive byte or central-directory limit exceeded');
    }
  }
}

const checksumTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

/** Export a fixed manifest with bounded ZIP metadata and verified immutable resources. */
async function exportArchive(entries: readonly TraceArchiveEntry[], destination: string, signal: AbortSignal, beginCommit: () => void, ownCleanup: (cleanup: Promise<void>) => void): Promise<void> {
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
      const contentHash = createHash('sha256');
      if (entry.path !== undefined) {
        try {
          for await (const part of createReadStream(entry.path, { highWaterMark: 65536, signal })) {
            const bytes = part as Buffer;
            for (const byte of bytes) checksum = checksumTable[(checksum ^ byte) & 255]! ^ (checksum >>> 8);
            size += bytes.length;
            if (size > entry.byteLength) throw failure('ProtocolError', 'tracing', 'archive input grew after sealing');
            contentHash.update(bytes);
            await write(bytes);
          }
        } catch (error) {
          // Read streams wrap the caller's reason; unrelated I/O failures keep their identity.
          if (signal.aborted && error instanceof Error && error.name === 'AbortError' &&
              'code' in error && error.code === 'ABORT_ERR' && error.cause === signal.reason) throw signal.reason;
          throw error;
        }
      }
      if (size !== entry.byteLength || contentHash.digest('hex') !== entry.contentHash) {
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
