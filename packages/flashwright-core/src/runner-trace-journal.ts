import { createHash } from 'node:crypto';
import { mkdtemp, open, rm, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { types } from 'node:util';
import { failure } from './errors.js';
import { SealedTraceArchive } from './trace-archive.js';
import { TraceResources, maximumSourceBytes, type TraceResource } from './trace-resources.js';
import { traceStorageBudget, type TraceStorageBudget, type TraceStorageLease } from './trace-storage-budget.js';
import { encodeRunnerRecord, maximumRunnerRecordBytes, runnerTraceErrorMessage, runnerTraceField, runnerTraceInvalid, runnerTraceLimit, runnerTraceParameters, snapshotRunnerRecord } from './runner-trace-record.js';

const maximumStreamBytes = 64 * 1024 * 1024;
const maximumQueuedBytes = 4 * 1024 * 1024;
const maximumQueuedAttachmentBytes = 32 * 1024 * 1024;
const maximumAttachmentBytes = 16 * 1024 * 1024;
const typedArrayByteLength = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'byteLength')!.get!;
const bufferBase64Slice = (Buffer.prototype as unknown as { base64Slice(start: number, end: number): string }).base64Slice;

export interface RunnerTraceJournalOptions {
  readonly attachments: boolean;
  readonly sources: boolean;
}

interface PendingAttachment {
  readonly original: Buffer;
  readonly length: number;
  readonly metadata: Record<string, unknown>;
}

/** One attempt owns bounded JSONL and body snapshots until final export or discard settles. */
export class RunnerTraceJournal {
  failure: unknown;
  private readonly cancellation = new AbortController();
  private readonly sourcePaths = new Set<string>();
  private readonly aliases = new Map<string, TraceResource>();
  private readonly journalHash = createHash('sha256');
  private sourcePathBytes = 0;
  private events = 0;
  private streamBytes = 0;
  private queuedBytes = 0;
  private queuedAttachmentBytes = 0;
  private queuedAttachments = 0;
  private writes: Promise<void> = Promise.resolve();
  private captures: Promise<void> = Promise.resolve();
  private preparation: Promise<SealedTraceArchive> | undefined;
  private disposal: Promise<void> | undefined;
  private removal: Promise<void> | undefined;
  private sealed = false;
  private transferred = false;
  private output: FileHandle | undefined;
  private directoryPath: string | undefined;
  private file: FileHandle | undefined;
  private resources: TraceResources | undefined;
  private readonly initialization: Promise<void>;
  private readonly storage: TraceStorageLease;

  private constructor(
    private readonly context: Record<string, unknown>,
    private readonly options: RunnerTraceJournalOptions,
    private readonly budget: TraceStorageBudget,
  ) {
    this.storage = budget.acquire(2);
    this.initialization = this.initialize();
    const initialized = this.initialization.catch(error => { this.fail(error); });
    this.writes = initialized;
    this.captures = initialized;
  }

  /** Admission starts synchronously; filesystem initialization has the same cleanup owner. */
  static begin(context: unknown, options: RunnerTraceJournalOptions, budget = traceStorageBudget): RunnerTraceJournal {
    const snapshot = snapshotRunnerRecord(context);
    if (snapshot.type !== 'context-options' || snapshot.origin !== 'testRunner' || snapshot.version !== 8) throw runnerTraceInvalid('expected the original version-8 runner context record');
    const attachments = runnerTraceField(options, 'attachments');
    const sources = runnerTraceField(options, 'sources');
    if (typeof attachments !== 'boolean' || typeof sources !== 'boolean') throw runnerTraceInvalid('invalid runner journal options');
    return new RunnerTraceJournal(snapshot, { attachments, sources }, budget);
  }

  static async create(context: unknown, options: RunnerTraceJournalOptions, budget = traceStorageBudget): Promise<RunnerTraceJournal> {
    const journal = RunnerTraceJournal.begin(context, options, budget);
    try {
      await journal.initialization;
      return journal;
    } catch (error) {
      await journal.dispose().catch(() => {});
      throw error;
    }
  }

  get directory(): string {
    if (this.directoryPath === undefined) throw runnerTraceInvalid('runner journal directory is not initialized');
    return this.directoryPath;
  }

  private async initialize(): Promise<void> {
    this.resources = await TraceResources.create(this.budget);
    this.cancellation.signal.throwIfAborted();
    this.directoryPath = await mkdtemp(join(tmpdir(), 'flashwright-runner-trace-'));
    this.cancellation.signal.throwIfAborted();
    this.file = await open(join(this.directoryPath, 'events.jsonl'), 'wx+', 0o600);
    this.cancellation.signal.throwIfAborted();
  }

  /** Replace the pinned caller before its recursive preview generation can run. */
  appendBeforeAction(options: unknown, timestamp: number): void {
    if (this.failure) return;
    try {
      this.assertAppendOpen();
      const stepId = runnerTraceField(options, 'stepId');
      this.append({
        type: 'before', callId: stepId, stepId, parentId: runnerTraceField(options, 'parentId'), startTime: timestamp,
        class: 'Test', method: runnerTraceField(options, 'category'), title: runnerTraceField(options, 'title'),
        params: runnerTraceParameters(runnerTraceField(options, 'params')),
        stack: runnerTraceField(options, 'stack'), group: runnerTraceField(options, 'group'),
      });
    } catch (error) { this.fail(error); }
  }

  appendAfterAction(callId: unknown, error: unknown, attachments: readonly unknown[] | undefined, annotations: unknown, timestamp: number): void {
    this.append({ type: 'after', callId, endTime: timestamp, annotations, error }, attachments);
  }

  /** Only bounded stack text reaches the pinned parser supplied by the runner adapter. */
  appendError(error: unknown, parseStack: (stack: string) => unknown[]): void {
    if (this.failure) return;
    try {
      this.assertAppendOpen();
      const stack = runnerTraceField(error, 'stack');
      if (stack !== undefined && typeof stack !== 'string') throw runnerTraceInvalid('runner error stack must be a string');
      if (stack && stack.length > 32768) throw runnerTraceLimit('runner error stack exceeds 32768 characters');
      this.append({ type: 'error', message: runnerTraceErrorMessage(error), stack: parseStack(stack ?? '') });
    } catch (error) { this.fail(error); }
  }

  /** The adapter passes normalized records; body attachments take their snapshot at this call. */
  append(event: unknown, attachments?: readonly unknown[]): void {
    if (this.failure) return;
    try {
      this.assertAppendOpen();
      const record = snapshotRunnerRecord(event);
      if (!['before', 'after', 'error', 'stdout', 'stderr'].includes(String(record.type))) throw runnerTraceInvalid('unexpected runner journal record');
      if (Object.hasOwn(record, 'attachments')) throw runnerTraceInvalid('attachments require separate snapshot admission');
      const pending: PendingAttachment[] = [];
      if (record.type === 'after' && this.options.attachments && attachments !== undefined) {
        const metadata = this.prepareAttachments(attachments, pending);
        if ((runnerTraceField(attachments, 'length') as number) > 0) record.attachments = metadata;
      }
      // A second admission includes attachment descriptors before any body copy is allocated.
      snapshotRunnerRecord(record);
      const measured = encodeRunnerRecord(record).length;
      if (this.events + 1 >= 100000 || this.streamBytes + measured > maximumStreamBytes || this.queuedBytes + measured > maximumQueuedBytes) throw runnerTraceLimit('runner trace exceeds its event, stream or pending-write limit');
      let attachmentBytes = 0;
      for (const attachment of pending) attachmentBytes += attachment.length;
      if (this.queuedAttachments + pending.length > 128 || this.queuedAttachmentBytes + attachmentBytes > maximumQueuedAttachmentBytes) throw runnerTraceLimit('runner trace exceeds 128 queued bodies or 32 MiB of attachment copies');
      if (record.type === 'before' && this.options.sources) this.referenceSources(record.stack);
      const releaseWrite = this.storage.reserveWrite(measured);
      try {
        for (const attachment of pending) {
          const releaseBody = this.budget.queue(attachment.length);
          try {
            const bytes = Buffer.allocUnsafe(attachment.length);
            Uint8Array.prototype.set.call(bytes, attachment.original);
            const alias = createHash('sha1').update(bytes).digest('hex');
            attachment.metadata.sha1 = alias;
            this.captureBody(bytes, alias, releaseBody);
          } catch (error) { releaseBody(); throw error; }
        }
        const encoded = encodeRunnerRecord(record);
        this.events++;
        this.streamBytes += measured;
        this.queuedBytes += measured;
        this.writes = this.writes.then(async () => {
          try {
            if (this.failure || this.cancellation.signal.aborted) return;
            await this.file!.writeFile(encoded);
            this.journalHash.update(encoded);
          } catch (error) { this.fail(error); }
          finally { this.queuedBytes -= measured; releaseWrite(); }
        });
      } catch (error) { releaseWrite(); this.storage.remove(measured); throw error; }
    } catch (error) { this.fail(error); }
  }

  /** Check binary size before base64 conversion, while retaining the caller's timestamp. */
  appendStdio(type: 'stdout' | 'stderr', chunk: string | Buffer, timestamp: number): void {
    if (this.failure) return;
    try {
      this.assertAppendOpen();
      if (typeof chunk === 'string') this.append({ type, timestamp, text: chunk });
      else {
        if (types.isProxy(chunk) || !Buffer.isBuffer(chunk)) throw runnerTraceInvalid('stdio must be a string or Buffer');
        const length = typedArrayByteLength.call(chunk) as number;
        if (Math.ceil(length / 3) * 4 + 128 > maximumRunnerRecordBytes) throw runnerTraceLimit('runner stdio exceeds its record limit');
        this.append({ type, timestamp, base64: bufferBase64Slice.call(chunk, 0, length) });
      }
    } catch (error) { this.fail(error); }
  }

  private prepareAttachments(attachments: readonly unknown[], pending: PendingAttachment[]): Record<string, unknown>[] {
    if (types.isProxy(attachments) || !Array.isArray(attachments)) throw runnerTraceInvalid('attachments must be an ordinary array');
    const length = runnerTraceField(attachments, 'length') as number;
    if (length > 256) throw runnerTraceLimit('one runner event exceeds 256 attachments');
    const result: Record<string, unknown>[] = [];
    for (let index = 0; index < length; index++) {
      const attachment = runnerTraceField(attachments, String(index));
      const name = runnerTraceField(attachment, 'name');
      if (name === 'trace') continue;
      const contentType = runnerTraceField(attachment, 'contentType');
      const path = runnerTraceField(attachment, 'path');
      if (typeof name !== 'string' || typeof contentType !== 'string' || path !== undefined && typeof path !== 'string') throw runnerTraceInvalid('invalid runner attachment metadata');
      if (typeof path === 'string' && path.length > 32768) throw runnerTraceLimit('runner attachment path exceeds 32768 characters');
      const metadata = snapshotRunnerRecord({ name, contentType, ...(path === undefined ? {} : { path }) });
      if (!path) {
        const body = runnerTraceField(attachment, 'body');
        if (body !== undefined) {
          if (types.isProxy(body) || !Buffer.isBuffer(body)) throw runnerTraceInvalid('attachment body must be a Buffer');
          const length = typedArrayByteLength.call(body) as number;
          if (length > maximumAttachmentBytes) throw runnerTraceLimit('runner attachment body exceeds 16 MiB');
          if (length) {
            metadata.sha1 = '0'.repeat(40);
            pending.push({ original: body, length, metadata });
          } else metadata.base64 = '';
        }
      }
      result.push(metadata);
    }
    return result;
  }

  private captureBody(bytes: Buffer, alias: string, releaseQueue: () => void): void {
    this.queuedAttachments++;
    this.queuedAttachmentBytes += bytes.length;
    this.captures = this.captures.then(async () => {
      try {
        if (this.failure || this.cancellation.signal.aborted) return;
        const resource = await this.resources!.captureBytes(bytes, this.cancellation.signal);
        this.addAlias(`resources/${alias}`, resource);
      } catch (error) { this.fail(error); }
      finally { this.queuedAttachments--; this.queuedAttachmentBytes -= bytes.length; releaseQueue(); }
    });
  }

  private referenceSources(stack: unknown): void {
    if (stack === undefined) return;
    if (!Array.isArray(stack)) throw runnerTraceInvalid('runner stack must be an array');
    for (let index = 0; index < stack.length; index++) {
      const file = runnerTraceField(stack[index], 'file');
      if (typeof file !== 'string') throw runnerTraceInvalid('runner source path must be a string');
      if (this.sourcePaths.has(file)) continue;
      const bytes = Buffer.byteLength(file);
      if (file.length > 32768 || this.sourcePaths.size >= 4096 || this.sourcePathBytes + bytes > 1024 * 1024) throw runnerTraceLimit('runner source path count or metadata limit exceeded');
      this.sourcePaths.add(file);
      this.sourcePathBytes += bytes;
    }
  }

  private addAlias(name: string, resource: TraceResource): void {
    const previous = this.aliases.get(name);
    if (previous && previous !== resource) throw runnerTraceInvalid('runner resource alias has conflicting content');
    if (!previous && this.aliases.size >= 8192) throw runnerTraceLimit('runner trace exceeds 8192 resource aliases');
    this.aliases.set(name, resource);
  }

  /** Final timeout and path-backed resources are observed at the runner's final stop boundary. */
  takeArchive(testTimeout: number, signal: AbortSignal): Promise<SealedTraceArchive> {
    if (this.sealed || this.disposal) return Promise.reject(runnerTraceInvalid('runner journal has already been sealed or disposed'));
    if (!Number.isFinite(testTimeout) || testTimeout < 0) return Promise.reject(runnerTraceInvalid('invalid final test timeout'));
    this.sealed = true;
    this.preparation = this.prepareArchive(testTimeout, signal);
    return this.preparation;
  }

  private async prepareArchive(testTimeout: number, callerSignal: AbortSignal): Promise<SealedTraceArchive> {
    const signal = AbortSignal.any([callerSignal, this.cancellation.signal]);
    signal.throwIfAborted();
    await Promise.all([this.writes, this.captures]);
    this.assertPreparing(signal);
    this.output = await open(join(this.directory, 'test.trace'), 'wx', 0o600);
    const hash = createHash('sha256');
    let bytes = 0;
    const write = async (record: Record<string, unknown>): Promise<void> => {
      this.assertPreparing(signal);
      const encoded = encodeRunnerRecord(snapshotRunnerRecord(record));
      if (bytes + encoded.length > maximumStreamBytes) throw runnerTraceLimit('final runner stream exceeds 64 MiB');
      this.storage.retain(encoded.length);
      bytes += encoded.length;
      await this.output!.writeFile(encoded);
      hash.update(encoded);
    };
    await write({ ...this.context, testTimeout });
    for await (const record of this.readRecords(signal)) {
      if (record.type === 'after' && Array.isArray(record.attachments)) {
        for (const attachment of record.attachments as Record<string, unknown>[]) {
          if (typeof attachment.path !== 'string' || !attachment.path) continue;
          const resource = await this.resources!.captureFile(attachment.path, signal);
          if (!resource) continue;
          const alias = await this.resourceSha1(resource, signal);
          this.addAlias(`resources/${alias}`, resource);
          delete attachment.path;
          delete attachment.base64;
          attachment.sha1 = alias;
        }
      }
      await write(record);
    }
    for (const path of this.sourcePaths) {
      this.assertPreparing(signal);
      const resource = await this.resources!.captureFile(path, signal, maximumSourceBytes, 'utf8');
      if (resource) this.addAlias(`resources/src@${createHash('sha1').update(path).digest('hex')}.txt`, resource);
    }
    await this.output.close();
    await this.file!.close();
    await rm(join(this.directory, 'events.jsonl'));
    this.storage.remove(this.streamBytes, 1);
    this.assertPreparing(signal);
    const archive = new SealedTraceArchive([
      { name: 'test.trace', path: join(this.directory, 'test.trace'), byteLength: bytes, contentHash: hash.digest('hex') },
      ...Array.from(this.aliases, ([name, resource]) => ({ name, ...resource })),
    ], () => this.removeFiles(), this.budget);
    this.transferred = true;
    this.sourcePaths.clear();
    this.aliases.clear();
    return archive;
  }

  /** Read bounded complete lines and verify the original journal before transferring custody. */
  private async *readRecords(signal: AbortSignal): AsyncGenerator<Record<string, unknown>> {
    const buffer = Buffer.allocUnsafe(65536);
    const hash = createHash('sha256');
    let offset = 0;
    let pending = Buffer.alloc(0);
    let events = 0;
    for (;;) {
      this.assertPreparing(signal);
      const { bytesRead } = await this.file!.read(buffer, 0, buffer.length, offset);
      if (!bytesRead) break;
      offset += bytesRead;
      if (offset > this.streamBytes) throw runnerTraceInvalid('runner journal changed before finalization');
      hash.update(buffer.subarray(0, bytesRead));
      let start = 0;
      for (let index = 0; index < bytesRead; index++) {
        if (buffer[index] !== 10) continue;
        const length = pending.length + index - start;
        if (length + 1 > maximumRunnerRecordBytes) throw runnerTraceLimit('stored runner record exceeds its limit');
        const line = pending.length ? Buffer.concat([pending, buffer.subarray(start, index)], length) : buffer.subarray(start, index);
        pending = Buffer.alloc(0);
        events++;
        if (events > this.events) throw runnerTraceInvalid('runner journal gained events before finalization');
        yield JSON.parse(line.toString('utf8')) as Record<string, unknown>;
        start = index + 1;
      }
      if (start < bytesRead) {
        const length = pending.length + bytesRead - start;
        if (length + 1 > maximumRunnerRecordBytes) throw runnerTraceLimit('stored runner record exceeds its limit');
        pending = Buffer.concat([pending, buffer.subarray(start, bytesRead)], length);
      }
    }
    if (pending.length || offset !== this.streamBytes || events !== this.events || hash.digest('hex') !== this.journalHash.digest('hex')) throw runnerTraceInvalid('runner journal changed before finalization');
  }

  private async resourceSha1(resource: TraceResource, signal: AbortSignal): Promise<string> {
    const file = await open(resource.path, 'r');
    let failed = false;
    try {
      const buffer = Buffer.allocUnsafe(65536);
      const hash = createHash('sha1');
      let bytes = 0;
      for (;;) {
        this.assertPreparing(signal);
        const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
        if (!bytesRead) break;
        bytes += bytesRead;
        if (bytes > resource.byteLength) throw runnerTraceInvalid('runner resource changed during hashing');
        hash.update(buffer.subarray(0, bytesRead));
      }
      if (bytes !== resource.byteLength) throw runnerTraceInvalid('runner resource changed during hashing');
      return hash.digest('hex');
    } catch (error) { failed = true; throw error; }
    finally {
      try { await this.resources!.closeReader(file); }
      catch (error) { if (!failed) throw error; }
    }
  }

  private assertAppendOpen(): void {
    if (this.sealed) throw runnerTraceInvalid('runner journal is sealed');
    this.cancellation.signal.throwIfAborted();
  }

  private assertPreparing(signal: AbortSignal): void {
    signal.throwIfAborted();
    if (this.failure) throw this.failure;
  }

  private fail(error: unknown): void { this.failure ??= error; }

  dispose(): Promise<void> {
    this.sealed = true;
    this.cancellation.abort(failure('TargetClosedError', 'runner.tracing', 'runner journal was disposed'));
    this.disposal ??= (async () => {
      await this.preparation?.catch(() => {});
      if (!this.transferred) await this.removeFiles();
      else await this.removal;
    })();
    return this.disposal;
  }

  private removeFiles(): Promise<void> {
    this.removal ??= (async () => {
      await Promise.all([this.writes, this.captures]);
      let originalFailure: unknown;
      let failed = false;
      const settle = async (work: Promise<unknown>): Promise<boolean> => {
        try { await work; return true; }
        catch (error) { if (!failed) { originalFailure = error; failed = true; } return false; }
      };
      const inputClosed = !this.file || await settle(this.file.close());
      const outputClosed = !this.output || await settle(this.output.close());
      const removed = !this.directoryPath || await settle(rm(this.directoryPath, { recursive: true, force: true }));
      if (inputClosed && outputClosed && removed) this.storage.release();
      if (this.resources) await settle(this.resources.dispose());
      this.sourcePaths.clear();
      this.aliases.clear();
      if (failed) throw originalFailure;
    })();
    return this.removal;
  }
}
