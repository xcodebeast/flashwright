import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { EngineClient } from './client.js';
import { failure } from './errors.js';
import { validateOptions } from './validation.js';
import { TraceWriter } from './trace-writer.js';
import { TraceResources, type TraceResource } from './trace-resources.js';
import { tryAcquireTraceTransfer } from './trace-transfers.js';
import { TraceDiagnosticChannel, type TraceDiagnostic } from './trace-diagnostics.js';
import { tracePreview, serializedTracePreview, traceStack, traceError, traceBooleanField } from './trace-preview.js';
import { traceChunkOpened, traceChunkClosed, type TraceOwner, type TraceCallMetadata, type TraceCaptureMode } from './trace-hooks.js';
import { pageError } from './page-errors.js';
import { remotePreview } from './console.js';
import { TraceFilmstripChannel, sampleTraceClock } from './trace-filmstrip.js';
import { NativeTraceRecording, type NativeTraceChunk } from './trace-recording.js';
import { TraceSnapshotChannel } from './trace-snapshots.js';
import { TraceNetworkChannel } from './trace-network.js';
import { beginRunnerAction, captureRunnerActionObserver, type RunnerAction, type RunnerActionObserver } from './runner-actions.js';
import { registerRunnerTraceOwner, type RunnerTraceChunk, type RunnerTraceRecording, type RunnerTraceRecordingWithActions, type RunnerTraceStartup, type RunnerTraceOperation } from './runner-trace-archives.js';
import type { SealedTraceArchive } from './trace-archive.js';
import { apiTraceAttempt, apiTraceBodyExtension, apiTraceBodySnapshot, apiTraceRequestBodySnapshot, apiTraceResourceExtension, type APITraceAttempt } from './trace-api-network.js';

export interface TracingStartOptions { name?: string; title?: string; screenshots?: boolean; snapshots?: boolean; sources?: boolean }
export interface TracingChunkOptions { name?: string; title?: string }
export interface TracingStopOptions { path?: string }
export interface TracingGroupOptions { location?: { file: string; line?: number; column?: number } }
export interface TracingHarOptions { content?: 'omit' | 'embed' | 'attach'; mode?: 'full' | 'minimal'; resourcesDir?: string; urlFilter?: string | RegExp }
export type TraceBackend = 'browser' | 'api';
interface APIEntrySlot { attempt: APITraceAttempt; resolve(snapshot: Record<string, unknown>): void }
interface APIRequestBody { hash: string; size: number; resource: Promise<TraceResource>; formParams?: { name: string; value: string }[] }
interface TraceChunk { identifier: string; writer: TraceWriter; runner: RunnerTraceChunk; retireCleanup(cleanup: Promise<void>): void; actionObserver?: RunnerActionObserver; channel?: TraceDiagnosticChannel; filmstrip?: TraceFilmstripChannel; native?: NativeTraceChunk; nativeOwner?: NativeTraceRecording; network?: TraceNetworkChannel; snapshots?: TraceSnapshotChannel; networkExport?: Promise<void>; completions?: Set<Promise<void>>; apiAttempts?: Set<string>; apiPendingResponses?: Map<string, APIEntrySlot>; apiRequestBodies?: Map<string, APIRequestBody>; apiPendingRequestBytes?: number; apiResourceTail?: Promise<void>; apiDispatchCancellation?: AbortController; apiRetirement?: Promise<void>; apiEntries?: Set<APIEntrySlot>; apiEntryBytes?: number; apiEntryTail?: Promise<void>; accepting: boolean }
interface StartedRecording { recording: RunnerTraceRecording; chunk: RunnerTraceChunk }
type TraceChunkDestination = { kind: 'file'; path: string | undefined } | { kind: 'runner'; signal: AbortSignal | undefined };
export interface TraceCall { identifier: string; chunk: TraceChunk; completed: boolean; evaluates: boolean; pageId: string | undefined; capture: TraceCaptureMode; nativeTrace?: TraceCallMetadata; runnerAction?: RunnerAction; assertionIsNot?: boolean }
const processIdentity = randomUUID();
let nextCall = 0;
let nextContext = 0;
const captureAPIRequestAttempt = Symbol('capture API request attempt');
const captureAPIRequestFailure = Symbol('capture API request failure');
const captureAPIResponse = Symbol('capture API response body');
const captureAPIRequestBody = Symbol('capture API request body');
const closeAPIAdmission = Symbol('close API trace admission');
const prepareAPIOwnerClose = Symbol('prepare original API trace owner closure');
const requestNetworkSignal = new AbortController().signal;

export function recordAPITraceAttempt(tracing: Tracing, value: unknown): void { tracing[captureAPIRequestAttempt](value); }
export function recordAPITraceFailure(tracing: Tracing, value: unknown): void { tracing[captureAPIRequestFailure](value); }
export function recordAPITraceResponse(tracing: Tracing, generation: string, call: string, responseIdentifier: string, bodyLength: number): void { tracing[captureAPIResponse](generation, call, responseIdentifier, bodyLength); }
export function recordAPITraceRequestBody(tracing: Tracing, generation: string, call: string, body: Buffer, parseForm: boolean): void { tracing[captureAPIRequestBody](generation, call, body, parseForm); }

export function closeAPITraceAdmission(tracing: Tracing): void { tracing[closeAPIAdmission](); }
export function prepareAPITraceOwnerClose(tracing: Tracing): Promise<void> { return tracing[prepareAPIOwnerClose](); }

/** Manual action tracing owns context diagnostics and independent, bounded archive chunks. */
export class Tracing {
  private readonly traceContext = `${processIdentity}@context-${++nextContext}`;
  private recording: RunnerTraceRecording | undefined;
  private resources: TraceResources | undefined;
  private includeSources = false;
  private includeScreenshots = false;
  private includeSnapshots = false;
  private nativeRecording: NativeTraceRecording | undefined;
  private network: TraceNetworkChannel | undefined;
  private ownerIsClosed = false;
  private apiAdmissionClosed = false;
  private apiCloseHandoffStarted = false;
  private apiCloseHandoff: Promise<void> | undefined;
  private controlling = false;
  private controlSettlement: Promise<void> | undefined;
  private readonly chunkRetirements = new WeakMap<RunnerTraceChunk, Promise<void>>();
  private chunk: TraceChunk | undefined;
  private readonly calls = new Set<TraceCall>();
  private cleanup: Promise<void> | undefined;
  private cleanupOutcome: Promise<void> | undefined;
  private cleanupFailure: { error: unknown } | undefined;
  private retiringChunk: TraceChunk | undefined;
  private exportCancellation: AbortController | undefined;
  private async withAPITransfer<Result>(chunk: TraceChunk, capture: () => Promise<Result>): Promise<Result> {
    const deadline = performance.now() + 30000;
    for (;;) {
      chunk.apiDispatchCancellation?.signal.throwIfAborted();
      if (this.ownerIsClosed) throw failure('TargetClosedError', 'tracing.api', 'original API request context closed during trace collection');
      if (chunk.writer.failure) throw chunk.writer.failure;
      const release = tryAcquireTraceTransfer(this.client, this.context);
      if (release) {
        try {
          chunk.apiDispatchCancellation?.signal.throwIfAborted();
          return await capture();
        }
        finally { release(); }
      }
      if (performance.now() >= deadline) throw failure('TimeoutError', 'tracing.api', 'shared trace transfer admission deadline exceeded');
      await new Promise<void>(resolve => setTimeout(resolve, 10));
    }
  }
  private enqueueAPIResource<Result>(chunk: TraceChunk, capture: () => Promise<Result>): Promise<Result> {
    const result = (chunk.apiResourceTail ?? Promise.resolve()).then(capture);
    chunk.apiResourceTail = result.then(() => {}, () => {});
    return result;
  }
  [captureAPIRequestBody](generation: string, call: string, body: Buffer, parseForm: boolean): void {
    const chunk = this.chunk;
    if (this.backend !== 'api' || !chunk?.accepting || chunk.identifier !== generation || this.ownerIsClosed || !this.resources) return;
    try {
      const requestBodies = chunk.apiRequestBodies ??= new Map();
      if (requestBodies.has(call)) throw failure('ProtocolError', 'tracing.api', 'public API call prepared multiple request bodies');
      if (body.length > 16 * 1024 * 1024 || (chunk.apiPendingRequestBytes ?? 0) + body.length > 32 * 1024 * 1024) throw failure('ResourceLimitError', 'tracing.api', 'pending API request bodies exceed trace allowance');
      if (parseForm && body.length > 256 * 1024) throw failure('ResourceLimitError', 'tracing.api', 'API form trace parameters exceed parsing allowance');
      const formParams = parseForm ? [...new URLSearchParams(body.toString('utf8'))].map(([name, value]) => ({ name, value })) : undefined;
      if (formParams && formParams.length > 2048) throw failure('ResourceLimitError', 'tracing.api', 'API form trace exceeds 2048 parameters');
      const hash = createHash('sha1').update(body).digest('hex');
      chunk.apiPendingRequestBytes = (chunk.apiPendingRequestBytes ?? 0) + body.length;
      const resources = this.resources;
      const resource = this.enqueueAPIResource(chunk, () => this.withAPITransfer(chunk, () => resources.captureBytes(body, requestNetworkSignal))).finally(() => {
        chunk.apiPendingRequestBytes = (chunk.apiPendingRequestBytes ?? 0) - body.length;
      });
      requestBodies.set(call, { hash, size: body.length, resource, ...(formParams ? { formParams } : {}) });
      const completion = resource.then(() => {});
      const completions = chunk.completions ??= new Set();
      completions.add(completion);
      void completion.then(() => completions.delete(completion), error => { completions.delete(completion); chunk.writer.fail(error); });
    } catch (error) { chunk.writer.fail(error); }
  }
  private queueAPIEntry(chunk: TraceChunk, attempt: APITraceAttempt): APIEntrySlot {
    const bytes = Buffer.byteLength(JSON.stringify(attempt.snapshot));
    const entries = chunk.apiEntries ??= new Set();
    if (bytes > 256 * 1024 || entries.size >= 1024 || (chunk.apiEntryBytes ?? 0) + bytes > 16 * 1024 * 1024) {
      throw failure('ResourceLimitError', 'tracing.api', 'pending API trace entries exceed their count or byte allowance');
    }
    let fulfill!: (snapshot: Record<string, unknown>) => void;
    const ready = new Promise<Record<string, unknown>>(resolve => { fulfill = resolve; });
    let settled = false;
    const slot: APIEntrySlot = { attempt, resolve(snapshot) { if (settled) return; settled = true; fulfill(snapshot); } };
    entries.add(slot);
    chunk.apiEntryBytes = (chunk.apiEntryBytes ?? 0) + bytes;
    const write = (chunk.apiEntryTail ?? Promise.resolve()).then(async () => {
      const snapshot = await ready;
      await chunk.writer.appendNetwork({ type: 'resource-snapshot', snapshot }, requestNetworkSignal);
    }).finally(() => {
      entries.delete(slot);
      chunk.apiEntryBytes = (chunk.apiEntryBytes ?? 0) - bytes;
    });
    chunk.apiEntryTail = write.then(() => {}, error => { chunk.writer.fail(error); });
    return slot;
  }
  [captureAPIRequestAttempt](value: unknown): void {
    const chunk = this.chunk;
    if (this.backend !== 'api' || !chunk?.accepting || this.ownerIsClosed) return;
    try {
      const attempt = apiTraceAttempt(value);
      if (attempt.generation !== chunk.identifier) return;
      const attempts = chunk.apiAttempts ??= new Set();
      if (attempts.size >= 16384) throw failure('ResourceLimitError', 'tracing.api', 'API trace exceeds 16384 wire attempts');
      if (attempts.has(attempt.attempt)) throw failure('ProtocolError', 'tracing.api', 'duplicate API wire attempt identity');
      if (attempt.responseIdentifier && chunk.apiPendingResponses?.has(attempt.call)) throw failure('ProtocolError', 'tracing.api', 'public API call owns multiple final wire responses');
      if (attempt.requestBodyPresent) {
        const body = chunk.apiRequestBodies?.get(attempt.call);
        if (!body) throw failure('ProtocolError', 'tracing.api', 'wire attempt lost its prepared request body');
        const request = attempt.snapshot.request as { headers: { name: string; value: string }[] };
        const mimeType = request.headers.find(header => header.name.toLowerCase() === 'content-type')?.value ?? 'application/octet-stream';
        const alias = `${body.hash}.${apiTraceResourceExtension(mimeType)}`;
        attempt.snapshot = apiTraceRequestBodySnapshot(attempt, { alias, mimeType, size: body.size,
          ...(mimeType.split(';', 1)[0]!.trim().toLowerCase() === 'application/x-www-form-urlencoded' && body.formParams ? { params: body.formParams } : {}) });
        const completion = body.resource.then(resource => chunk.writer.addResource(`resources/${alias}`, resource));
        const completions = chunk.completions ??= new Set();
        completions.add(completion);
        void completion.then(() => completions.delete(completion), error => { completions.delete(completion); chunk.writer.fail(error); });
      }
      attempts.add(attempt.attempt);
      const slot = this.queueAPIEntry(chunk, attempt);
      if (attempt.responseIdentifier) {
        const pending = chunk.apiPendingResponses ??= new Map();
        pending.set(attempt.call, slot);
      } else slot.resolve(attempt.snapshot);
    } catch (error) { chunk.writer.fail(error); }
  }
  [captureAPIResponse](generation: string, call: string, responseIdentifier: string, bodyLength: number): void {
    const chunk = this.chunk;
    if (this.backend !== 'api' || !chunk?.accepting || chunk.identifier !== generation || this.ownerIsClosed) return;
    const pending = chunk.apiPendingResponses?.get(call);
    if (!pending || pending.attempt.responseIdentifier !== responseIdentifier || !this.resources) {
      chunk.writer.fail(failure('ProtocolError', 'tracing.api', 'final API response lost its original wire attempt'));
      return;
    }
    chunk.apiPendingResponses!.delete(call);
    const resources = this.resources;
    const completion = this.enqueueAPIResource(chunk, () => this.withAPITransfer(chunk, async () => {
      const response = pending.attempt.snapshot.response as { content: { size: number } };
      if (response.content.size > 16 * 1024 * 1024) throw failure('ResourceLimitError', 'tracing.api', 'API response body exceeds the trace resource limit');
      if (bodyLength !== response.content.size) throw failure('ProtocolError', 'tracing.api', 'API trace response metadata differs from the original wire body');
      const parameters = { context: this.context, response: responseIdentifier };
      const bytes = await this.client.requestTraceAttachment('apiRequest.traceBody.take', parameters, 2000, bodyLength, undefined, chunk.apiDispatchCancellation?.signal);
      if (bytes.length !== response.content.size) throw failure('ProtocolError', 'tracing.api', 'API trace response body length changed after native publication');
      const alias = `${createHash('sha1').update(bytes).digest('hex')}.${apiTraceBodyExtension(pending.attempt)}`;
      const resource = await resources.captureBytes(bytes, requestNetworkSignal);
      chunk.writer.addResource(`resources/${alias}`, resource);
      await this.client.request('apiRequest.traceBody.ingested', parameters, 2000);
      pending.resolve(apiTraceBodySnapshot(pending.attempt, alias));
    }));
    const completions = chunk.completions ??= new Set();
    completions.add(completion);
    void completion.then(() => completions.delete(completion), error => {
      pending.resolve(apiTraceBodySnapshot(pending.attempt, undefined, 'original response body was unavailable'));
      completions.delete(completion); chunk.writer.fail(error);
    });
  }
  [captureAPIRequestFailure](value: unknown): void {
    const chunk = this.chunk;
    if (this.backend !== 'api' || !chunk?.accepting || this.ownerIsClosed) return;
    if (typeof value === 'string') {
      if (value === chunk.identifier) chunk.writer.fail(failure('ResourceLimitError', 'tracing.api', 'native API trace capture exceeds negotiated value limits'));
      return;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) { chunk.writer.fail(failure('ProtocolError', 'tracing.api', 'invalid API trace failure')); return; }
    const event = value as Record<string, unknown>;
    if (event.generation !== chunk.identifier) return;
    chunk.writer.fail(failure('ResourceLimitError', 'tracing.api', typeof event.message === 'string' ? event.message : 'native API trace capture failed'));
  }
  constructor(private readonly client: EngineClient, private readonly context: string, private readonly viewport: { width: number; height: number } | null, private readonly backend: TraceBackend = 'browser') {
    registerRunnerTraceOwner(this, {
      currentChunk: () => this.chunk?.runner,
      currentRecording: () => this.recording,
      startRecording: options => this.beginRecording(options).then(started => started.recording),
      startRecordingWithActions: (options, observer) => this.beginRecordingWithActions(options, observer),
      beginRecordingWithActions: (options, observer) => this.beginOwnedRecording(options, observer),
      discardChunk: chunk => this.discardExactRunnerChunk(chunk),
      beginRecordingChunk: (recording, observer, options) => this.ownedOperation(captureCleanup => this.startRunnerChunk(recording, options, captureRunnerActionObserver(observer), captureCleanup)),
      settleClosedCleanup: async () => {
        if (!this.ownerIsClosed) throw failure('InvalidArgumentError', 'runner.tracing', 'context must be closed before awaiting its final cleanup');
        await this.controlSettlement;
        await this.settleRunnerCleanup();
      },
    });
  }

  start(options: TracingStartOptions = {}): Promise<void> {
    return this.beginRecording(options).then(() => {});
  }

  async group(name: string, options: TracingGroupOptions = {}): Promise<never> {
    validateOptions('tracing.group', options, ['location']);
    if (typeof name !== 'string') throw failure('InvalidArgumentError', 'tracing.group', 'name must be a string');
    if (options.location !== undefined) {
      validateOptions('tracing.group.location', options.location, ['file', 'line', 'column']);
      if (typeof options.location.file !== 'string') throw failure('InvalidArgumentError', 'tracing.group.location.file', 'expected a string');
      for (const field of ['line', 'column'] as const) {
        if (options.location[field] !== undefined && (typeof options.location[field] !== 'number' || !Number.isFinite(options.location[field]))) {
          throw failure('InvalidArgumentError', `tracing.group.location.${field}`, 'expected a finite number');
        }
      }
    }
    throw failure('UnsupportedFeatureError', 'tracing.group', 'trace grouping is not implemented');
  }

  async groupEnd(): Promise<never> {
    throw failure('UnsupportedFeatureError', 'tracing.groupEnd', 'trace grouping is not implemented');
  }

  async startHar(path: string, options: TracingHarOptions = {}): Promise<never> {
    validateOptions('tracing.startHar', options, ['content', 'mode', 'resourcesDir', 'urlFilter']);
    if (typeof path !== 'string') throw failure('InvalidArgumentError', 'tracing.startHar', 'path must be a string');
    if (options.content !== undefined && !['omit', 'embed', 'attach'].includes(options.content)) throw failure('InvalidArgumentError', 'tracing.startHar.content', 'expected omit, embed, or attach');
    if (options.mode !== undefined && !['full', 'minimal'].includes(options.mode)) throw failure('InvalidArgumentError', 'tracing.startHar.mode', 'expected full or minimal');
    if (options.resourcesDir !== undefined && typeof options.resourcesDir !== 'string') throw failure('InvalidArgumentError', 'tracing.startHar.resourcesDir', 'expected a string');
    if (options.urlFilter !== undefined && typeof options.urlFilter !== 'string' && !(options.urlFilter instanceof RegExp)) throw failure('InvalidArgumentError', 'tracing.startHar.urlFilter', 'expected a string or regular expression');
    throw failure('UnsupportedFeatureError', 'tracing.startHar', 'HAR recording is not implemented');
  }

  async stopHar(): Promise<never> {
    throw failure('UnsupportedFeatureError', 'tracing.stopHar', 'HAR recording is not implemented');
  }

  private beginRecording(options: TracingStartOptions, observer?: RunnerActionObserver, captureCleanup?: (cleanup: Promise<void>) => void): Promise<StartedRecording> {
    return this.control(async () => {
      this.assertAPITraceAdmission();
      validateOptions('tracing.start', options, ['name', 'title', 'screenshots', 'snapshots', 'sources']);
      for (const key of ['screenshots', 'snapshots', 'sources'] as const) {
        if (options[key] !== undefined && typeof options[key] !== 'boolean') throw failure('InvalidArgumentError', `tracing.start.${key}`, 'expected a boolean');
      }
      validateChunkOptions(options);
      return await this.startRecording(options, observer);
    }, captureCleanup);
  }

  /** One recording retains snapshot and network ownership across independently exported chunks. */
  private async startRecording(options: TracingStartOptions, observer?: RunnerActionObserver): Promise<StartedRecording> {
    if (this.recording) throw failure('InvalidArgumentError', 'tracing.start', 'tracing is already started');
    this.resources = await TraceResources.create();
    this.includeSources = options.sources ?? false;
    this.includeScreenshots = options.screenshots ?? false;
    this.includeSnapshots = options.snapshots ?? false;
    try {
      if (this.includeSnapshots && this.backend === 'browser') {
        this.nativeRecording = new NativeTraceRecording(this.client, this.context, true);
        await this.nativeRecording.start();
        this.network = new TraceNetworkChannel(this.client, this.context, this.nativeRecording.identifier, this.resources, error => {
          this.chunk?.writer.fail(error); this.retiringChunk?.writer.fail(error);
        });
      }
      await this.openChunk(options, observer);
      if (this.ownerIsClosed) throw failure('TargetClosedError', 'tracing.start', 'context closed before recording publication');
      this.recording = this.createRunnerRecording();
      return { recording: this.recording, chunk: this.chunk!.runner };
    } catch (error) {
      const resources = this.resources;
      const native = this.nativeRecording;
      const network = this.network;
      this.network = undefined;
      this.resources = undefined;
      this.nativeRecording = undefined;
      await this.waitForCleanup((async () => {
        try { await network?.stop(); await native?.cleanup(); }
        finally { await resources?.retire(); }
      })());
      throw error;
    }
  }
  private async beginRecordingWithActions(options: TracingStartOptions, observer: RunnerActionObserver): Promise<RunnerTraceRecordingWithActions> {
    const captured = captureRunnerActionObserver(observer);
    const { recording } = await this.beginRecording(options, captured);
    return this.recordingWithActions(recording);
  }

  /** Capture setup retirement before releasing control, without extending the public setup grace. */
  private beginOwnedRecording(options: TracingStartOptions, observer: RunnerActionObserver): RunnerTraceStartup {
    return this.ownedOperation(async captureCleanup => {
      const captured = captureRunnerActionObserver(observer);
      const { recording, chunk } = await this.beginRecording(options, captured, captureCleanup);
      return Object.freeze({ ...this.recordingWithActions(recording), chunk });
    });
  }

  private ownedOperation<Value>(begin: (captureCleanup: (cleanup: Promise<void>) => void) => Promise<Value>): RunnerTraceOperation<Value> {
    let adoptCleanup!: (cleanup: Promise<void> | void) => void;
    const cleanup = new Promise<void>(resolve => { adoptCleanup = resolve; });
    void cleanup.catch(() => {});
    const ready = (async () => {
      try {
        return await begin(adoptCleanup);
      } finally {
        // A rejected preflight never entered control and owns no previous operation's cleanup.
        adoptCleanup();
      }
    })();
    return Object.freeze({ ready, cleanup });
  }

  private recordingWithActions(recording: RunnerTraceRecording): RunnerTraceRecordingWithActions {
    return Object.freeze({
      recording,
      startChunk: async (nextObserver: RunnerActionObserver, nextOptions: TracingChunkOptions = {}) => {
        const nextCaptured = captureRunnerActionObserver(nextObserver);
        return this.startRunnerChunk(recording, nextOptions, nextCaptured);
      },
      stop: () => recording.stop(),
    });
  }
  startChunk(options: TracingChunkOptions = {}): Promise<void> {
    return this.control(async () => {
      this.assertAPITraceAdmission();
      validateOptions('tracing.startChunk', options, ['name', 'title']);
      validateChunkOptions(options);
      if (!this.recording) throw failure('InvalidArgumentError', 'tracing.startChunk', 'must start tracing first');
      await this.finishChunk({ kind: 'file', path: undefined });
      await this.openChunk(options);
    });
  }
  stopChunk(options: TracingStopOptions = {}): Promise<void> {
    return this.control(async () => { validateStopOptions(options); await this.finishChunk({ kind: 'file', path: options.path }); });
  }
  stop(options: TracingStopOptions = {}): Promise<void> {
    return this.control(async () => {
      validateStopOptions(options);
      try { await this.finishChunk({ kind: 'file', path: options.path }, true); }
      finally { this.recording = undefined; }
    });
  }
  /** A runner cannot reuse a manual replacement or erase an unexpected active chunk. */
  private createRunnerRecording(): RunnerTraceRecording {
    const recording: RunnerTraceRecording = Object.freeze({
      startChunk: (options: TracingChunkOptions = {}) => this.startRunnerChunk(recording, options),
      stop: () => this.control(async () => {
        this.assertRunnerRecordingCurrent(recording);
        try {
          await this.discardAndSettle(true);
        } finally { this.recording = undefined; }
      }),
    });
    return recording;
  }

  private assertRunnerRecordingCurrent(recording: RunnerTraceRecording): void {
    if (this.recording !== recording) throw failure('InvalidArgumentError', 'runner.tracing', 'the original trace recording is no longer current');
    if (this.chunk) throw failure('InvalidArgumentError', 'runner.tracing', 'the original trace recording still has an active chunk');
  }

  private startRunnerChunk(recording: RunnerTraceRecording, options: TracingChunkOptions, observer?: RunnerActionObserver, captureCleanup?: (cleanup: Promise<void>) => void): Promise<RunnerTraceChunk> {
    return this.control(async () => {
      this.assertRunnerRecordingCurrent(recording);
      this.assertAPITraceAdmission();
      validateOptions('tracing.startChunk', options, ['name', 'title']);
      validateChunkOptions(options);
      await this.openChunk(options, observer);
      if (this.ownerIsClosed || !this.chunk) throw failure('TargetClosedError', 'runner.tracing', 'context closed before chunk publication');
      return this.chunk.runner;
    }, captureCleanup);
  }

  /** Private disposal returns only after its original cleanup, even beyond the public grace. */
  private async settleRunnerCleanup(): Promise<void> {
    while (this.cleanup) await this.cleanup;
    if (this.cleanupFailure) throw this.cleanupFailure.error;
  }

  private async discardAndSettle(retireRecording = false): Promise<void> {
    try { await this.finishChunk({ kind: 'file', path: undefined }, retireRecording); }
    catch (error) { await this.settleRunnerCleanup().catch(() => {}); throw error; }
    await this.settleRunnerCleanup();
  }
  private currentCleanupOutcome(): Promise<void> {
    return this.cleanupOutcome ?? (this.cleanupFailure ? Promise.reject(this.cleanupFailure.error) : Promise.resolve());
  }
  private async control<Value>(callback: () => Promise<Value>, captureCleanup?: (cleanup: Promise<void>) => void): Promise<Value> {
    if (this.ownerIsClosed || this.apiCloseHandoffStarted) throw failure('TargetClosedError', 'tracing', 'context has been closed');
    if (this.controlling) throw failure('InvalidArgumentError', 'tracing', 'another tracing control operation is in progress');
    if (this.cleanup) throw failure('ResourceLimitError', 'tracing', 'previous trace cleanup has not settled');
    if (this.cleanupFailure) throw this.cleanupFailure.error;
    this.controlling = true;
    let resolveControl!: () => void;
    this.controlSettlement = new Promise(resolve => { resolveControl = resolve; });
    try { return await callback(); } finally {
      captureCleanup?.(this.currentCleanupOutcome());
      this.controlling = false;
      this.controlSettlement = undefined;
      resolveControl();
    }
  }
  private async openChunk(options: TracingChunkOptions, observer?: RunnerActionObserver): Promise<void> {
    if (this.ownerIsClosed) throw failure('TargetClosedError', 'tracing.startChunk', 'context is closed');
    if (this.cleanup) throw failure('ResourceLimitError', 'tracing.startChunk', 'previous trace cleanup has not settled');
    if (!this.resources) throw failure('ProtocolError', 'tracing', 'recording resource owner is unavailable');
    const writer = await TraceWriter.create(this.resources);
    const identifier = randomUUID();
    const runner: RunnerTraceChunk = Object.freeze({
      takeArchive: (signal?: AbortSignal) => this.takeRunnerArchive(runner, signal),
      discard: () => this.discardRunnerChunk(identifier),
    });
    let retireCleanup!: (cleanup: Promise<void>) => void;
    const retirement = new Promise<void>(resolve => { retireCleanup = resolve; });
    void retirement.catch(() => {});
    this.chunkRetirements.set(runner, retirement);
    const chunk: TraceChunk = { identifier, writer, runner, retireCleanup, ...(this.backend === 'api' ? { apiDispatchCancellation: new AbortController() } : {}), ...(observer ? { actionObserver: observer } : {}), accepting: false };
    try {
      if (this.nativeRecording) {
        chunk.nativeOwner = this.nativeRecording;
        if (this.network) chunk.network = this.network;
        chunk.native = await chunk.nativeOwner.startChunk(chunk.identifier);
      }
      const clock = this.backend === 'browser' && this.includeScreenshots ? await sampleTraceClock(this.client, this.context) : undefined;
      writer.append({ version: 8, type: 'context-options', origin: 'library', browserName: this.backend === 'browser' ? 'chromium' : '', playwrightVersion: '1.60.0', options: this.backend === 'browser' ? { viewport: this.viewport } : {}, platform: process.platform, wallTime: Date.now(), monotonicTime: performance.now(), sdkLanguage: 'javascript', contextId: this.traceContext, title: options.title, testIdAttributeName: 'data-testid', ...(clock ? { flashwrightClock: clock } : {}), ...(chunk.native?.clock ? { flashwrightRecordingClock: chunk.native.clock } : {}) });
      if (this.backend === 'browser') chunk.channel = await TraceDiagnosticChannel.start(this.client, this.context, chunk.identifier, diagnostic => this.diagnostic(chunk, diagnostic), error => writer.fail(error));
      if (clock) chunk.filmstrip = await TraceFilmstripChannel.start(this.client, this.context, chunk.identifier, clock, this.resources, writer, page => this.pageIdentity(page));
      if (chunk.native?.clock) chunk.snapshots = new TraceSnapshotChannel(this.client, chunk.native.identity, chunk.native.clock, this.resources, writer,
        page => this.pageIdentity(page), call => writer.append({ type: 'input', callId: call, inputSnapshot: `input@${call}` }));
      if (this.ownerIsClosed) { chunk.channel?.ownerClosed(); chunk.filmstrip?.ownerClosed(); chunk.snapshots?.ownerClosed(); throw failure('TargetClosedError', 'tracing.start', 'context closed while starting tracing'); }
      this.chunk = chunk;
      chunk.accepting = true;
      traceChunkOpened();
    } catch (error) {
      if (writer.failure !== undefined) this.cleanupFailure ??= { error: writer.failure };
      await this.waitForCleanup((async () => {
        try { await this.retireCollectors(chunk); }
        finally { await writer.dispose(); }
      })());
      chunk.retireCleanup(this.currentCleanupOutcome());
      throw error;
    }
  }
  private seal(chunk: TraceChunk): void {
    if (chunk.accepting) { chunk.accepting = false; traceChunkClosed(); }
  }
  /** A saved runner handle cannot export a replacement created by manual trace controls. */
  private takeRunnerArchive(chunk: RunnerTraceChunk, signal?: AbortSignal): Promise<SealedTraceArchive> {
    return this.control(async () => {
      if (this.chunk?.runner !== chunk) throw failure('InvalidArgumentError', 'runner.tracing', 'the original trace chunk is no longer current');
      signal?.throwIfAborted();
      const archive = await this.finishChunk({ kind: 'runner', signal });
      if (!archive) throw failure('ProtocolError', 'runner.tracing', 'sealed trace archive is unavailable');
      return archive;
    });
  }

  /** Retire only this chunk, including cleanup initiated by concurrent manual controls or closure. */
  private async discardExactRunnerChunk(chunk: RunnerTraceChunk): Promise<void> {
    const retirement = this.chunkRetirements.get(chunk);
    if (!retirement) throw failure('ProtocolError', 'runner.tracing', 'unknown original trace chunk');
    while (this.chunk?.runner === chunk) {
      await this.controlSettlement;
      await this.cleanup;
      if (this.chunk?.runner !== chunk) break;
      try { await this.discardRunnerChunk(this.chunk.identifier); }
      catch (error) {
        if (this.chunk?.runner === chunk && !this.controlSettlement && !this.cleanup) throw error;
      }
    }
    await retirement;
  }

  private discardRunnerChunk(identifier: string): Promise<void> {
    return this.control(async () => {
      if (this.chunk?.identifier !== identifier) throw failure('InvalidArgumentError', 'runner.tracing', 'the original trace chunk is no longer current');
      await this.discardAndSettle();
    });
  }

  private async finishChunk(destination: TraceChunkDestination, retireRecording = false): Promise<SealedTraceArchive | undefined> {
    const resources = retireRecording ? this.resources : undefined;
    const nativeRecording = this.nativeRecording;
    const network = retireRecording ? this.network : undefined;
    if (retireRecording) this.network = undefined;
    if (retireRecording) this.resources = undefined;
    const chunk = this.chunk;
    if (!chunk) {
      if (resources || retireRecording && nativeRecording) await this.waitForCleanup((async () => {
        try { if (retireRecording) { await network?.stop(); await nativeRecording?.cleanup(); } }
        finally { if (retireRecording && this.nativeRecording === nativeRecording) this.nativeRecording = undefined; await resources?.retire(); }
      })());
      if (destination.kind === 'runner' || destination.path !== undefined) throw failure('InvalidArgumentError', 'tracing.stopChunk', 'must start tracing before exporting');
      return;
    }
    this.seal(chunk);
    this.chunk = undefined;
    const cancellation = new AbortController();
    const cancelAPIDispatch = () => chunk.apiDispatchCancellation?.abort(cancellation.signal.reason);
    cancellation.signal.addEventListener('abort', cancelAPIDispatch, { once: true });
    const externalSignal = destination.kind === 'runner' ? destination.signal : undefined;
    const cancelFromRunner = () => cancellation.abort(externalSignal!.reason);
    externalSignal?.addEventListener('abort', cancelFromRunner, { once: true });
    this.retiringChunk = chunk;
    this.exportCancellation = cancellation;
    let committing = false;
    let interrupt: () => void = () => {};
    const interrupted = new Promise<never>((_, reject) => {
      interrupt = () => { if (!committing) reject(cancellation.signal.reason); };
      cancellation.signal.addEventListener('abort', interrupt, { once: true });
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const error = failure('TimeoutError', 'tracing.stopChunk', 'trace preparation exceeded 30 seconds before atomic commit');
        cancellation.abort(error);
        reject(error);
      }, 30000);
    });
    const deadline = performance.now() + 30000;
    const checkPreparation = () => {
      cancellation.signal.throwIfAborted();
      if (performance.now() >= deadline) throw failure('TimeoutError', 'tracing.stopChunk', 'trace preparation exceeded 30 seconds before custody transfer');
    };
    let preparedArchive: SealedTraceArchive | undefined;
    const work = (async () => {
      await this.retireCollectors(chunk, cancellation.signal);
      if (destination.kind === 'runner') {
        preparedArchive = await chunk.writer.takeArchive(cancellation.signal);
        checkPreparation();
        return;
      }
      await chunk.writer.finish(destination.path, cancellation.signal, () => {
        checkPreparation();
        committing = true;
        clearTimeout(timer);
      });
    })();
    let originalFailure: unknown;
    let failed = false;
    try { await Promise.race([work, expired, interrupted]); }
    // Native retirement can fail before the writer reaches its own failure check.
    // Preserve the earlier capture error while cleanup still owns the native failure.
    catch (error) { originalFailure = chunk.writer.failure ?? error; failed = true; }
    finally {
      clearTimeout(timer);
      cancellation.signal.removeEventListener('abort', interrupt);
      const dispose = async () => {
        try {
          try {
            try { await this.retireCollectors(chunk); }
            finally { if (retireRecording) { await network?.stop(); await nativeRecording?.cleanup(); } }
          } finally {
            if (retireRecording && this.nativeRecording === nativeRecording) this.nativeRecording = undefined;
            try { await chunk.writer.dispose(); }
            finally { await resources?.retire(); }
          }
        } catch (error) {
          await preparedArchive?.dispose().catch(() => {});
          throw error;
        }
        if (failed || cancellation.signal.aborted) await preparedArchive?.dispose();
      };
      await this.waitForCleanup(work.then(dispose, dispose));
      this.retiringChunk = undefined;
      this.exportCancellation = undefined;
      cancellation.signal.removeEventListener('abort', cancelAPIDispatch);
      externalSignal?.removeEventListener('abort', cancelFromRunner);
    }
    try {
      if (destination.kind === 'runner') {
        let handoffFailed = failed;
        let handoffFailure = originalFailure;
        if (!handoffFailed) {
          try {
            if (this.cleanupFailure) throw this.cleanupFailure.error;
            checkPreparation();
            if (this.cleanup) throw failure('ResourceLimitError', 'runner.tracing', 'trace cleanup has not settled before archive handoff');
          } catch (error) { handoffFailed = true; handoffFailure = error; }
        }
        if (handoffFailed) {
          // Timed-out preparation may still produce a manifest. Its original owner disposes it.
          this.ownCleanup(work.then(() => preparedArchive?.dispose(), () => preparedArchive?.dispose()));
          throw handoffFailure;
        }
        return preparedArchive;
      }
      if (failed) throw originalFailure;
      if (this.cleanupFailure) throw this.cleanupFailure.error;
    } finally { chunk.retireCleanup(this.currentCleanupOutcome()); }
  }

  private async retireCollectors(chunk: TraceChunk, signal?: AbortSignal): Promise<void> {
    await this.drainCompletions(chunk);
    let apiRetirementFailure: { error: unknown } | undefined;
    if (this.backend === 'api' && !this.ownerIsClosed) {
      chunk.apiRetirement ??= this.client.request('apiRequest.traceBody.retire', { context: this.context, generation: chunk.identifier }, 2000)
        .then(() => {});
      try { await chunk.apiRetirement; }
      catch (error) {
        // Admission can fail before the native fence exists. Cleanup must retry or quarantine.
        delete chunk.apiRetirement;
        chunk.writer.fail(error);
        apiRetirementFailure = { error };
      }
    }
    for (const pending of chunk.apiPendingResponses?.values() ?? []) pending.resolve(apiTraceBodySnapshot(pending.attempt, undefined, 'response was not published before trace seal'));
    chunk.apiPendingResponses?.clear();
    await chunk.apiEntryTail;
    try { await chunk.native?.seal(); }
    catch (error) { chunk.writer.fail(error); chunk.snapshots?.fail(error); }
    if (chunk.native && chunk.network && !chunk.networkExport) chunk.networkExport = chunk.network.exportChunk(chunk.native, chunk.writer, page => this.pageIdentity(page), signal);
    const results = await Promise.allSettled([chunk.channel?.stop(), chunk.filmstrip?.stop(signal), chunk.snapshots?.stop(signal), chunk.networkExport]);
    if (chunk.native) {
      await chunk.nativeOwner!.retireChunk(chunk.native, signal);
      delete chunk.native;
    }
    const rejected = results.find(result => result.status === 'rejected');
    // Failed content prevents export, but does not make settled native retirement uncertain.
    if (rejected?.status === 'rejected') chunk.writer.fail(rejected.reason);
    if (apiRetirementFailure) throw apiRetirementFailure.error;
  }

  /** Compose every cleanup owner; a newer closure cannot hide an older pending export. */
  private ownCleanup(work: Promise<void>): Promise<void> {
    const previousFailure = this.cleanupFailure;
    const outcome = Promise.allSettled(this.cleanupOutcome ? [this.cleanupOutcome, work] : [work]).then(results => {
      const rejected = results.find(result => result.status === 'rejected');
      const cleanupFailure = previousFailure ?? (rejected?.status === 'rejected' ? { error: rejected.reason } : undefined);
      if (cleanupFailure) { this.cleanupFailure ??= cleanupFailure; throw cleanupFailure.error; }
    });
    const ownership = outcome.then(() => {}, () => {});
    this.cleanupOutcome = outcome;
    this.cleanup = ownership;
    void ownership.then(() => {
      if (this.cleanup === ownership) { this.cleanup = undefined; this.cleanupOutcome = undefined; }
    });
    return ownership;
  }
  private async waitForCleanup(work: Promise<void>): Promise<void> {
    const ownership = this.ownCleanup(work);
    let grace: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([ownership, new Promise<void>(resolve => { grace = setTimeout(resolve, 2000); })]);
    clearTimeout(grace);
  }

  begin(className: string, method: string, title: string, owner: TraceOwner, parameterNames: readonly string[], values: unknown[], capture: TraceCaptureMode = 'default'): TraceCall | undefined {
    const chunk = this.chunk;
    if (!chunk?.accepting || this.ownerIsClosed || chunk.writer.failure) return undefined;
    if (this.calls.size >= 1024) { chunk.writer.fail(failure('ResourceLimitError', 'tracing', 'trace exceeds 1024 unfinished public calls')); return undefined; }
    const call: TraceCall = { identifier: `${processIdentity}@${++nextCall}`, chunk, completed: false, evaluates: method.includes('eval'), pageId: owner.pageId, capture };
    if (this.backend === 'api' ? this.includeSnapshots : capture === 'metadata-only' || this.includeScreenshots || chunk.native) call.nativeTrace = Object.freeze({ context: this.context, generation: chunk.identifier,
      ...(this.backend === 'api' ? { call: call.identifier } : chunk.native && capture === 'default' ? { recording: chunk.native.identity.recording, call: call.identifier } : {}) });
    this.calls.add(call);
    if (capture !== 'metadata-only') chunk.filmstrip?.activity(owner.pageId);
    try {
      const parameters: Record<string, unknown> = Object.create(null);
      if (owner.selector !== undefined) parameters.selector = owner.selector;
      for (let index = 0; index < parameterNames.length; index++) parameters[parameterNames[index]!] = values[index];
      const preview = tracePreview(parameters, 16384) as Record<string, unknown>;
      if (className === 'Frame' && method === 'expect') {
        const isNot = traceBooleanField(values[parameterNames.indexOf('options')], 'isNot');
        if (isNot !== undefined) call.assertionIsNot = isNot;
        // Project the already-safe preview, never the application's option object.
        const assertion = preview.options;
        if (assertion && typeof assertion === 'object' && !Array.isArray(assertion)) {
          for (const name of ['expression', 'isNot', 'expectedText', 'expectedNumber', 'expectedValue', 'expressionArg', 'useInnerText', 'pseudo']) {
            if (Object.hasOwn(assertion, name)) preview[name] = (assertion as Record<string, unknown>)[name];
          }
          delete preview.options;
        }
        if (isNot !== undefined) preview.isNot = isNot;
        preview.expectedValue = { value: serializedTracePreview(preview.expectedValue), handles: [] };
      }
      const argumentIndex = parameterNames.indexOf('arg');
      if (call.evaluates && argumentIndex !== -1) {
        preview.arg = { value: serializedTracePreview(values[argumentIndex]), handles: [] };
        preview.isFunction = typeof values[parameterNames.indexOf('expression')] === 'function';
      }
      const stack = traceStack();
      const runnerAction = beginRunnerAction({ className, method, apiName: title, parameters: preview, stack }, chunk.actionObserver);
      if (runnerAction) call.runnerAction = runnerAction;
      if (this.includeSources) chunk.writer.referenceSources(stack);
      chunk.writer.append({ type: 'before', callId: call.identifier, stepId: call.runnerAction?.stepId, startTime: performance.now(), class: className, method, title: call.runnerAction?.title ?? title, params: preview, pageId: owner.pageId === undefined ? undefined : this.pageIdentity(owner.pageId), stack,
        ...(call.nativeTrace?.recording && !['keyboardPress', 'keyboardType', 'keyboardInsertText'].includes(method) ? { beforeSnapshot: `before@${call.identifier}` } : {}) });
    } catch (error) { chunk.writer.fail(error); }
    return call;
  }
  complete(call: TraceCall, value: unknown, error: unknown, failed: boolean): Promise<void> {
    if (call.completed) return Promise.resolve();
    call.completed = true;
    const completions = call.chunk.completions ??= new Set();
    const completion = this.captureCompletion(call, value, error, failed);
    completions.add(completion);
    void completion.then(() => completions.delete(completion), captureError => {
      completions.delete(completion);
      call.chunk.writer.fail(captureError);
    });
    return completion;
  }
  /** Event delivery cannot depend on renderer diagnostics needed after the recipient recovers it. */
  completeIndependently(call: TraceCall, value: unknown, error: unknown, failed: boolean): void {
    this.completeRunnerAction(call, failed ? error : undefined);
    void this.complete(call, value, error, failed);
  }
  private async captureCompletion(call: TraceCall, value: unknown, error: unknown, failed: boolean): Promise<void> {
    try {
      if (!call.chunk.accepting) return;
      call.chunk.apiRequestBodies?.delete(call.identifier);
      if (failed) {
        const pending = call.chunk.apiPendingResponses?.get(call.identifier);
        if (pending) {
          call.chunk.apiPendingResponses!.delete(call.identifier);
          pending.resolve(apiTraceBodySnapshot(pending.attempt, undefined, 'public API request failed before response publication'));
        }
      }
      const result = failed ? undefined : { value: call.evaluates ? serializedTracePreview(value) : tracePreview(value) };
      const capturedError = failed ? traceError(error) : undefined;
      const assertionFailed = call.assertionIsNot !== undefined && traceBooleanField(value, 'matches') === call.assertionIsNot;
      // Independent event recipients may mutate these objects while diagnostics are pending.
      value = undefined;
      if (!call.runnerAction) error = undefined;
      // Modal delivery and handling must settle without admitting diagnostic or renderer work.
      if (call.capture !== 'metadata-only') {
        call.chunk.filmstrip?.activity(call.pageId);
        await call.chunk.channel?.fence();
      }
      // A started completion retains its original chunk while export stops new admission.
      if (this.ownerIsClosed) return;
      call.chunk.writer.append({ type: 'after', callId: call.identifier, endTime: performance.now(),
        ...(call.nativeTrace?.recording ? { afterSnapshot: `after@${call.identifier}` } : {}),
        ...(failed ? { error: capturedError } : {
          result,
          ...(assertionFailed ? { error: { name: 'Expect', message: 'Expect failed' } } : {}),
        }) });
      if (call.nativeTrace?.recording && call.pageId) await this.client.request('context.trace.snapshot.after', {
        context: call.nativeTrace.context, recording: call.nativeTrace.recording, chunk: call.nativeTrace.generation, call: call.identifier, page: call.pageId,
      }, 2000);
    } catch (captureError) { call.chunk.writer.fail(captureError); }
    finally {
      this.completeRunnerAction(call, failed ? error : undefined);
      this.calls.delete(call);
    }
  }
  private completeRunnerAction(call: TraceCall, error: unknown): void {
    const action = call.runnerAction;
    delete call.runnerAction;
    try { action?.complete(error); }
    catch (captureError) { call.chunk.writer.fail(captureError); }
  }
  /** Calls remain inside the existing 1,024-call budget until their diagnostic custody ends. */
  private async drainCompletions(chunk: TraceChunk): Promise<void> {
    while (chunk.completions?.size) await Promise.allSettled(chunk.completions);
  }
  completeSynchronously(call: TraceCall, error: unknown): void {
    void this.complete(call, undefined, error, true);
  }
  pageEvent(pageId: string, opened: boolean): void {
    const chunk = this.chunk;
    if (chunk?.accepting) chunk.writer.append({ type: 'event', time: performance.now(), class: 'BrowserContext', method: opened ? 'page' : 'pageClosed', params: { pageId: this.pageIdentity(pageId) } });
  }
  private pageIdentity(page: string): string { return `${this.traceContext}/${page}`; }
  private diagnostic(chunk: TraceChunk, diagnostic: TraceDiagnostic): void {
    const event = JSON.parse(diagnostic.raw);
    const time = performance.now();
    if (diagnostic.kind === 'pageerror') {
      chunk.writer.append({ type: 'event', time, class: 'BrowserContext', method: 'pageError', pageId: this.pageIdentity(diagnostic.page), params: { error: { error: traceError(pageError({ exceptionJson: diagnostic.raw })) }, location: { url: event.exceptionDetails?.url ?? '', line: event.exceptionDetails?.lineNumber ?? 0, column: event.exceptionDetails?.columnNumber ?? 0 } } });
      return;
    }
    const isLog = diagnostic.kind === 'console-log';
    const arguments_: { preview: string; value?: unknown }[] = isLog ? [] : (event.args ?? []).map((argument: Parameters<typeof remotePreview>[0] & { value?: unknown; unserializableValue?: string }) => ({
      preview: argument.type === 'undefined' ? 'undefined' : Object.hasOwn(argument, 'value') ? String(argument.value)
        : argument.type === 'bigint' && argument.unserializableValue?.endsWith('n') ? argument.unserializableValue.slice(0, -1)
        : argument.type === 'number' && argument.unserializableValue ? String(Number(argument.unserializableValue))
        : argument.unserializableValue ?? remotePreview(argument),
      ...(Object.hasOwn(argument, 'value') ? { value: tracePreview(argument.value) } : {}),
    }));
    const frame = event.stackTrace?.callFrames?.[0];
    const location = isLog ? { url: event.entry?.url ?? '', lineNumber: event.entry?.lineNumber ?? 0, columnNumber: 0 }
      : { url: frame?.url ?? '', lineNumber: frame?.lineNumber ?? 0, columnNumber: frame?.columnNumber ?? 0 };
    chunk.writer.append({ type: 'console', time, pageId: this.pageIdentity(diagnostic.page), messageType: isLog ? event.entry?.level : event.type, text: isLog ? event.entry?.text : arguments_.map(argument => argument.preview).join(' '), args: arguments_, location });
  }
  private assertAPITraceAdmission(): void {
    if (this.apiAdmissionClosed) throw failure('TargetClosedError', 'tracing', 'API request context disposal has begun');
  }
  [closeAPIAdmission](): void {
    if (this.backend !== 'api') throw failure('ProtocolError', 'tracing.api', 'API trace closure requires the original API owner');
    this.apiAdmissionClosed = true;
  }
  /** Original capture custody survives the foreground cleanup grace and keeps its native owner alive. */
  [prepareAPIOwnerClose](): Promise<void> {
    this[closeAPIAdmission]();
    if (this.apiCloseHandoff) return this.apiCloseHandoff;
    this.apiCloseHandoffStarted = true;
    this.apiCloseHandoff = (async () => {
      // Existing manual export or runner retirement owns its original control and cleanup.
      // This handoff is deliberately not another control operation or an export dependency.
      await this.controlSettlement;
      while (this.cleanup) await this.cleanup;
      const chunk = this.chunk;
      if (chunk && !this.ownerIsClosed) {
        await this.ownCleanup((async () => {
          try { await this.retireCollectors(chunk); }
          finally { if (chunk.writer.failure !== undefined) this.cleanupFailure ??= { error: chunk.writer.failure }; }
        })());
      }
      await this.settleRunnerCleanup();
    })();
    void this.apiCloseHandoff.catch(() => {});
    return this.apiCloseHandoff;
  }
  /** Explicit closure drains first, without changing screenshot hooks or the user's close result. */
  async beforeOwnerClose(): Promise<void> {
    try { if (this.chunk) await this.waitForCleanup(this.retireCollectors(this.chunk)); }
    catch (error) { this.chunk?.writer.fail(error); }
  }
  ownerClosed(): void {
    this.ownerIsClosed = true;
    this.recording = undefined;
    this.nativeRecording = undefined;
    const network = this.network;
    this.network = undefined;
    network?.ownerClosed();
    this.retiringChunk?.network?.ownerClosed();
    this.retiringChunk?.channel?.ownerClosed();
    this.retiringChunk?.filmstrip?.ownerClosed();
    this.retiringChunk?.snapshots?.ownerClosed();
    this.exportCancellation?.abort(failure('TargetClosedError', 'tracing', 'context closed during export'));
    const chunk = this.chunk;
    chunk?.apiDispatchCancellation?.abort(failure('TargetClosedError', 'tracing.api', 'original request context closed'));
    this.chunk = undefined;
    const resources = this.resources;
    this.resources = undefined;
    if (chunk) {
      this.seal(chunk);
      chunk.channel?.ownerClosed();
      chunk.filmstrip?.ownerClosed();
      chunk.snapshots?.ownerClosed();
    }
    if (chunk || resources || network) {
      this.ownCleanup((async () => {
        try {
          if (chunk) {
            await this.drainCompletions(chunk);
            for (const pending of chunk.apiPendingResponses?.values() ?? []) pending.resolve(apiTraceBodySnapshot(pending.attempt, undefined, 'original request context closed'));
            chunk.apiPendingResponses?.clear();
            await chunk.apiEntryTail;
          }
          await Promise.all([chunk?.filmstrip?.stop(), chunk?.snapshots?.stop(), network?.stop()]);
          await chunk?.writer.dispose();
        }
        finally { await resources?.retire(); }
      })());
      chunk?.retireCleanup(this.currentCleanupOutcome());
    }
    this.calls.clear();
  }
}

function validateChunkOptions(options: TracingChunkOptions): void {
  for (const key of ['name', 'title'] as const) {
    if (options[key] !== undefined && typeof options[key] !== 'string') throw failure('InvalidArgumentError', `tracing.${key}`, 'expected a string');
    if (options[key] !== undefined && options[key].length > 4096) throw failure('ResourceLimitError', `tracing.${key}`, 'trace labels exceed 4096 UTF-16 units');
  }
}
function validateStopOptions(options: TracingStopOptions): void {
  validateOptions('tracing.stopChunk', options, ['path']);
  if (options.path !== undefined && typeof options.path !== 'string') throw failure('InvalidArgumentError', 'tracing.path', 'expected a string');
  if (options.path !== undefined && options.path.length > 32768) throw failure('ResourceLimitError', 'tracing.path', 'trace path exceeds 32768 UTF-16 units');
}
