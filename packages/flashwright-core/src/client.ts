import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { callerStack } from './call-sites.js';
import { once } from 'node:events';
import { performance } from 'node:perf_hooks';
import { Duplex } from 'node:stream';
import { setTimeout as waitForRetry } from 'node:timers/promises';
import { failure, fromRecord, errorMessage, type ErrorRecord } from './errors.js';
import { residentRuntimeSha256 } from './runtime-version.cjs';
import { AttachmentReceiver } from './attachments.js';
import { traceCommandMetadata } from './trace-hooks.js';
import { operationAdmissionLimit, minimumDialogPendingOperations, isTraceCollection, isTraceCollectionTake } from './operation-admission.js';
import { EventControlLane, isSubscriptionControl, isDialogHandling } from './event-control-lane.js';
import { TraceAdmission } from './trace-admission.js';

import { engineHandshake, requiredCapabilities } from './engine-contract.js';
import { resolveDriverExecutable } from './driver-runtime.js';
export { requiredCapabilities } from './engine-contract.js';

const limits = engineHandshake.limits;
const maximumFrameBytes = limits.controlFrameBytes;
const maximumPendingOperations = limits.pendingOperations;
interface PendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout> | undefined;
  cleanupTimeout: ReturnType<typeof setTimeout> | undefined;
  dispatched: boolean;
  deadlineExpired: boolean;
  callSite: string | undefined;
  binary: boolean;
  input: OutgoingInput | undefined;
  expectedBinaryByteLength: number | undefined;
}
interface OutgoingInput {
  bytes: Buffer | undefined;
  byteLength: number;
  sentBytes: number;
  dispatched: boolean;
  finished: Promise<void>;
  finish: () => void;
}
export interface ObjectEvent { event: string; parameters: unknown }

interface Reply {
  kind: string;
  requestId?: number;
  value?: unknown;
  inputDelivery?: string;
  error?: ErrorRecord;
  handshake?: { protocolVersion: number; packageVersion: string; capabilityInventoryVersion: number; limits: typeof limits };
  capabilities?: string[];
  residentRuntimeSha256?: string;
  target?: string;
  event?: string;
  parameters?: unknown;
  encoding?: unknown;
  byteLength?: unknown;
  encodedLength?: unknown;
}

/** One asynchronous transport per worker, shared by lazily owned browsers. */
export class EngineClient {
  private readonly process: ChildProcessWithoutNullStreams;
  private readonly parentLiveness: Duplex;
  private readonly pending = new Map<number, PendingRequest>();
  private nextIdentifier = 1;
  private incoming = Buffer.alloc(0);
  private writeChain = Promise.resolve();
  private queuedBytes = 0;
  private references = 0;
  private failure: Error | undefined;
  private readyResolve!: () => void;
  private readyReject!: (error: Error) => void;
  private readonly ready: Promise<void>;
  private readonly exited: Promise<void>;
  private exitResolve!: () => void;
  private closed = false;
  private diagnostics = '';
  private handshakeComplete = false;
  private readonly objectListeners = new Map<string, (event: ObjectEvent) => void>();
  private readonly bufferedEvents = new Map<string, ObjectEvent[]>();
  private readonly releasedObjects = new Set<string>();
  private bufferedEventCount = 0;
  private resourceLimits = { ...limits };
  private attachments: AttachmentReceiver | undefined;
  private outgoingInputCount = 0;
  private readonly writeAborted = new AbortController();
  private readonly pageReadiness = new Map<string, Promise<unknown>>();
  private readonly eventControls = new EventControlLane();
  private readonly controlCapacityWaiters = new Set<() => void>();
  private traceAdmission: TraceAdmission | undefined;

  constructor(executablePath: string) {
    this.ready = new Promise((resolve, reject) => { this.readyResolve = resolve; this.readyReject = reject; });
    this.exited = new Promise(resolve => { this.exitResolve = resolve; });
    this.process = spawn(executablePath, [], { stdio: ['pipe', 'pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32', env: { ...process.env, FLASHWRIGHT_PARENT_LIVENESS_FD: '3' } });
    const parentLiveness = this.process.stdio[3];
    if (!(parentLiveness instanceof Duplex)) throw failure('ProtocolError', 'engine', 'parent liveness pipe was not created');
    this.parentLiveness = parentLiveness;
    this.parentLiveness.on('error', error => this.fail(error));
    this.parentLiveness.resume();
    this.process.on('exit', () => this.parentLiveness.destroy());
    this.process.stdout.on('data', (chunk: Buffer) => this.consume(chunk));
    this.process.stderr.on('data', (chunk: Buffer) => {
      this.diagnostics = (this.diagnostics + chunk.toString('utf8')).slice(-8192);
      if (process.env.FLASHWRIGHT_DEBUG_BROWSER) process.stderr.write(chunk);
    });
    this.process.stdin.on('error', error => this.fail(error));
    this.process.on('error', error => this.fail(error));
    this.process.on('close', (code, signal) => {
      this.parentLiveness.destroy();
      this.fail(failure('BrowserDisconnectedError', 'engine', `driver exited (${signal ?? code})${this.diagnostics ? `: ${this.diagnostics}` : ''}`));
      this.exitResolve();
    });
    const handshakeTimeout = setTimeout(() => this.fail(failure('TimeoutError', 'handshake', 'driver handshake exceeded 10 seconds')), 10000);
    this.ready.then(() => clearTimeout(handshakeTimeout), () => clearTimeout(handshakeTimeout));
    void this.send({ kind: 'handshake', handshake: engineHandshake }).catch(error => this.fail(error));
  }

  subscribeObject(identifier: string, listener: (event: ObjectEvent) => void, initialEvents: ObjectEvent[] = []): () => void {
    this.objectListeners.set(identifier, listener);
    for (const event of initialEvents) queueMicrotask(() => listener(event));
    for (const event of this.bufferedEvents.get(identifier) ?? []) {
      this.bufferedEventCount--;
      queueMicrotask(() => listener(event));
    }
    this.bufferedEvents.delete(identifier);
    if (this.failure) queueMicrotask(() => listener({ event: 'transportclosed', parameters: null }));
    return () => this.forgetObject(identifier);
  }

  private forgetObject(identifier: string): void {
    this.pageReadiness.delete(identifier);
    this.objectListeners.delete(identifier);
    this.bufferedEventCount -= this.bufferedEvents.get(identifier)?.length ?? 0;
    this.bufferedEvents.delete(identifier);
    this.releasedObjects.add(identifier);
    if (this.releasedObjects.size > maximumPendingOperations) this.releasedObjects.delete(this.releasedObjects.values().next().value!);
  }

  private receiveEvent(message: Reply): void {
    if (typeof message.target !== 'string' || typeof message.event !== 'string') throw failure('ProtocolError', 'event', 'event omitted object identity or name');
    if (this.releasedObjects.has(message.target)) return;
    const event = { event: message.event, parameters: message.parameters };
    const listener = this.objectListeners.get(message.target);
    if (listener) {
      // Application listener exceptions must not be mistaken for corrupt protocol input.
      queueMicrotask(() => listener(event));
    } else {
      if (++this.bufferedEventCount > maximumPendingOperations) throw failure('ResourceLimitError', 'event', 'too many events for objects awaiting publication');
      const buffered = this.bufferedEvents.get(message.target) ?? [];
      buffered.push(event);
      this.bufferedEvents.set(message.target, buffered);
    }
  }

  waitForHandshake(): Promise<void> { return this.ready; }

  retain(): void { this.references++; }
  isClosed(): boolean { return this.closed || this.failure !== undefined; }

  setConsoleSubscription(owner: 'page' | 'context', identifier: string, enabled: boolean): void {
    void this.request(`${owner}.console.subscribe`, { [owner]: identifier, enabled }).catch(error => this.eventControlFailure(error));
  }
  setDialogSubscription(owner: 'page' | 'context', identifier: string, enabled: boolean): void {
    void this.request(`${owner}.dialog.subscribe`, { [owner]: identifier, enabled }).catch(error => this.eventControlFailure(error));
  }
  /** A subsequent page command must wait for interception acknowledgement, including rapid toggles. */
  setFileChooserSubscription(page: string, enabled: boolean): void {
    const previous = this.pageReadiness.get(page) ?? this.ready;
    const changed = this.request('page.fileChooser.subscribe', { page, enabled }, 0, false, undefined, previous);
    this.pageReadiness.set(page, changed);
    void changed.catch(error => this.eventControlFailure(error));
  }
  discardEventHandles(page: string, group: string): void {
    void this.request('handle.discard', { page, group }).catch(error => this.eventControlFailure(error));
  }
  rejectProtocol(error: unknown): void {
    this.fail(error instanceof Error ? error : failure('ProtocolError', 'protocol', String(error)));
  }
  private eventControlFailure(error: Error): void {
    if (!['TargetClosedError', 'PageCrashedError', 'BrowserDisconnectedError'].includes(error.name)) this.fail(error);
  }

  private removePending(identifier: number): void {
    if (this.pending.delete(identifier)) {
      this.traceAdmission?.capacityChanged();
      this.notifyControlCapacity();
    }
  }

  /** Allocate optional-work scheduling only after the first actual trace command. */
  private traceAdmissionOwner(): TraceAdmission {
    return this.traceAdmission ??= new TraceAdmission(
      this.resourceLimits.pendingOperations,
      operationAdmissionLimit('page.evaluate', this.resourceLimits.pendingOperations),
      this.resourceLimits.queuedMessages,
      () => this.pending.size,
      () => {
        let trace = 0;
        let collection = 0;
        for (const request of this.pending.values()) {
          if (request.method.startsWith('context.trace.')) trace++;
          if (isTraceCollection(request.method)) collection++;
        }
        return { total: this.pending.size, trace, collection };
      },
    );
  }

  private notifyControlCapacity(): void {
    for (const changed of [...this.controlCapacityWaiters]) changed();
  }

  /** A later control may wait for admitted handling, whose acknowledgement requires no renderer work. */
  private async waitForControlCapacity(method: string, signal: AbortSignal): Promise<void> {
    while (this.pending.size >= this.resourceLimits.pendingOperations) {
      if (signal.aborted) throw failure('CancelledError', method, 'event control admission wait ended');
      if (this.failure) throw this.failure;
      // Enter the priority admission queue so the next collector cannot overtake this control.
      if ([...this.pending.values()].some(request => isTraceCollection(request.method))) return;
      if (![...this.pending.values()].some(request => isDialogHandling(request.method))) throw failure('ResourceLimitError', method, 'pending recovery capacity is exhausted');
      await new Promise<void>((resolve, reject) => {
        const dispose = () => { this.controlCapacityWaiters.delete(changed); signal.removeEventListener('abort', aborted); };
        const changed = () => { dispose(); resolve(); };
        const aborted = () => { dispose(); reject(failure('CancelledError', method, 'event control admission wait ended')); };
        this.controlCapacityWaiters.add(changed);
        signal.addEventListener('abort', aborted, { once: true });
      });
    }
  }

  async release(): Promise<void> {
    if (--this.references > 0) return;
    this.closed = true;
    this.traceAdmission?.close(failure('BrowserDisconnectedError', 'engine', 'engine client is closed'));
    this.process.stdin.end();
    const termination = setTimeout(() => this.process.kill('SIGKILL'), 3000);
    try { await this.exited; } finally { clearTimeout(termination); }
  }

  /** timeout 0 means unbounded publicly; an exhausted finite budget is sent as zero remaining. */
  async request(method: string, parameters: unknown, timeoutMilliseconds = 0, binary = false, inputBuffers?: readonly Buffer[], readinessOverride?: Promise<unknown>, expectedBinaryByteLength?: number): Promise<unknown> {
    if (expectedBinaryByteLength !== undefined && (!binary || !Number.isSafeInteger(expectedBinaryByteLength) || expectedBinaryByteLength < 0)) throw failure('InvalidArgumentError', method, 'invalid expected binary byte length');
    const started = performance.now();
    const callSite = callerStack();
    const traceCall = traceCommandMetadata();
    const subscriptionControl = isSubscriptionControl(method);
    const dialogHandling = isDialogHandling(method);
    const controlTicket = subscriptionControl || dialogHandling ? this.eventControls.reserve(method, this.resourceLimits.queuedMessages) : undefined;
    const ownerClosure = ['page.close', 'context.close', 'browser.close'].includes(method);
    const controlPredecessor = controlTicket ? controlTicket.predecessor : ownerClosure ? undefined : this.eventControls.predecessor();
    const controlAdmission = subscriptionControl ? new AbortController() : undefined;
    try {
      const page = parameters && typeof parameters === 'object' && 'page' in parameters && typeof parameters.page === 'string' ? parameters.page : undefined;
      const bypassPageReadiness = method === 'page.close' || subscriptionControl || dialogHandling;
      let readiness = readinessOverride ?? (page && !bypassPageReadiness ? this.pageReadiness.get(page) : undefined) ?? this.ready;
      if (controlPredecessor) readiness = Promise.all([readiness, controlPredecessor]);
      if (controlAdmission) readiness = readiness.then(() => this.waitForControlCapacity(method, controlAdmission.signal));
      let readinessTimeout: ReturnType<typeof setTimeout> | undefined;
      try {
        // Every request uses the same promise stages so finite and unbounded calls
        // keep invocation order when readiness settles, including during handshake.
        await Promise.race([
          readiness,
          ...(timeoutMilliseconds === 0 ? [] : [new Promise<never>((_, reject) => {
            readinessTimeout = setTimeout(() => reject(failure('TimeoutError', method, 'deadline exceeded before driver acceptance')), timeoutMilliseconds);
          })]),
        ]);
      } finally { clearTimeout(readinessTimeout); }
      if (this.failure) throw this.failure;
      if (this.closed) throw failure('BrowserDisconnectedError', method, 'engine client is closed');
      const admissionLimit = operationAdmissionLimit(method, this.resourceLimits.pendingOperations);
      const admissionKind = isTraceCollection(method) ? 'collection' : method.startsWith('context.trace.') ? 'trace' : admissionLimit === this.resourceLimits.pendingOperations ? 'recovery' : 'ordinary';
      const admission = admissionKind === 'trace' || admissionKind === 'collection' ? this.traceAdmissionOwner() : this.traceAdmission;
      const dispatch = (): Promise<unknown> => {
        if (this.failure) throw this.failure;
        if (this.closed) throw failure('BrowserDisconnectedError', method, 'engine client is closed');
        if (this.pending.size >= admissionLimit) throw failure('ResourceLimitError', method, 'pending operation capacity is exhausted or reserved for recovery');
        const input = inputBuffers === undefined ? undefined : this.prepareInput(method, inputBuffers);
        inputBuffers = undefined;
        const identifier = this.nextIdentifier++;
        const remaining = timeoutMilliseconds === 0 ? null : Math.max(0, Math.floor(timeoutMilliseconds - (performance.now() - started)));
        const result = new Promise((resolve, reject) => {
          const expire = () => {
            const pending = this.pending.get(identifier);
            if (!pending || pending.deadlineExpired) return;
            pending.deadlineExpired = true;
            if (input) input.bytes = undefined;
            this.attachments?.expire(identifier);
            if (!pending.dispatched) {
              this.removePending(identifier);
              reject(failure('TimeoutError', method, 'deadline exceeded before dispatch'));
              return;
            }
            void this.send({ kind: 'cancel', requestId: identifier }).catch(error => this.fail(error));
            // A stuck driver must not also disable the independent caller-side deadline path.
            pending.cleanupTimeout = setTimeout(() => {
              this.fail(failure('TimeoutError', method, 'deadline exceeded; driver did not finish cancellation within the 2 second cleanup budget'));
              this.process.kill('SIGKILL');
            }, 2000);
          };
          const timeout = remaining === null ? undefined : setTimeout(expire, remaining);
          this.pending.set(identifier, { method, resolve, reject, timeout, cleanupTimeout: undefined, dispatched: false, deadlineExpired: false, callSite, binary, input, expectedBinaryByteLength });
          const message = { kind: 'command', requestId: identifier, method, parameters, timeoutMilliseconds: remaining, ...(input ? { inputByteLength: input.byteLength } : {}), ...(traceCall ? { traceCall } : {}) };
          const transmission = this.send(message, () => {
            const pending = this.pending.get(identifier);
            if (!pending) return null;
            const remaining = timeoutMilliseconds === 0 ? null : Math.max(0, Math.floor(timeoutMilliseconds - (performance.now() - started)));
            if (remaining === 0) {
              this.removePending(identifier);
              clearTimeout(pending.timeout);
              reject(failure('TimeoutError', method, 'deadline exceeded before dispatch'));
              return null;
            }
            pending.dispatched = true;
            if (input) input.dispatched = true;
            return { ...message, timeoutMilliseconds: remaining };
          });
          const rejectTransmission = (error: Error) => {
            const pending = this.pending.get(identifier);
            this.removePending(identifier);
            clearTimeout(pending?.timeout);
            clearTimeout(pending?.cleanupTimeout);
            if (input?.dispatched) this.fail(error);
            reject(error);
          };
          if (input) {
            void transmission.then(() => this.sendInput(identifier, input, started, timeoutMilliseconds, expire))
              .catch(rejectTransmission).finally(() => { input.bytes = undefined; input.finish(); });
          } else void transmission.catch(rejectTransmission);
        });
        if (dialogHandling) controlTicket!.complete();
        if (!input) return result;
        return result.finally(async () => {
          let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([input.finished, new Promise<void>(resolve => {
              cleanupTimer = setTimeout(() => {
                this.fail(failure('TimeoutError', method, 'binary input cleanup exceeded 2 seconds'));
                resolve();
              }, 2000);
            })]);
          } finally { clearTimeout(cleanupTimer); this.outgoingInputCount--; }
        });
      };
      const result = admission ? admission.run(admissionKind, method, timeoutMilliseconds === 0 ? undefined : started + timeoutMilliseconds, dispatch) : dispatch();
      return subscriptionControl ? await result : result;
    } catch (error) {
      if (subscriptionControl && !(error instanceof Error && ['TargetClosedError', 'PageCrashedError', 'BrowserDisconnectedError'].includes(error.name))) {
        controlTicket!.fail(error);
        this.rejectProtocol(error);
      }
      throw error;
    } finally {
      controlAdmission?.abort();
      controlTicket?.complete();
    }
  }

  /** Snapshot bounded input after readiness, retaining one slot until transfer and reply settle. */
  private prepareInput(method: string, buffers: readonly Buffer[]): OutgoingInput {
    if (buffers.length > 4096 || buffers.some(buffer => !Buffer.isBuffer(buffer))) throw failure('InvalidArgumentError', method, 'binary input requires at most 4096 buffers');
    const byteLength = buffers.reduce((total, buffer) => total + buffer.length, 0);
    if (byteLength > this.resourceLimits.binaryAttachmentBytes) throw failure('ResourceLimitError', method, 'binary input exceeds negotiated byte limit');
    if (this.outgoingInputCount >= this.resourceLimits.pendingAttachments) throw failure('ResourceLimitError', method, 'too many active binary inputs');
    const bytes = Buffer.concat(buffers, byteLength);
    let finish!: () => void;
    const finished = new Promise<void>(resolve => { finish = resolve; });
    this.outgoingInputCount++;
    return { bytes, byteLength, sentBytes: 0, dispatched: false, finished, finish };
  }

  /** Each chunk yields the shared writer so cancellation and unrelated requests can progress. */
  private async sendInput(identifier: number, input: OutgoingInput, started: number, timeoutMilliseconds: number, expire: () => void): Promise<void> {
    if (!input.dispatched) return;
    const chunkBytes = Math.min(64 * 1024, this.resourceLimits.controlFrameBytes - 13);
    let chunks = 0;
    while (input.bytes && input.sentBytes < input.byteLength) {
      if (timeoutMilliseconds && performance.now() - started >= timeoutMilliseconds) { expire(); break; }
      const length = Math.min(chunkBytes, input.byteLength - input.sentBytes);
      const frame = Buffer.allocUnsafe(4 + 13 + length);
      frame.writeUInt32LE(13 + length);
      frame[4] = 0;
      frame.writeBigUInt64LE(BigInt(identifier), 5);
      frame.writeUInt32LE(input.sentBytes, 13);
      input.bytes.copy(frame, 17, input.sentBytes, input.sentBytes + length);
      await this.queueFrame(frame, () => {
        if (!input.bytes || !this.pending.has(identifier)) return null;
        input.sentBytes += length;
        return frame;
      });
      if (++chunks % 16 === 0) await new Promise<void>(resolve => setImmediate(resolve));
    }
    await this.send({ kind: 'inputEnd', requestId: identifier, aborted: !input.bytes || input.sentBytes !== input.byteLength });
  }

  requestBinary(method: string, parameters: unknown, timeoutMilliseconds = 0, expectedByteLength?: number): Promise<Buffer> {
    if (isTraceCollectionTake(method)) throw failure('InvalidArgumentError', method, 'trace collection requires bounded attachment admission');
    return this.request(method, parameters, timeoutMilliseconds, true, undefined, undefined, expectedByteLength) as Promise<Buffer>;
  }

  /** A collection busy reply owns no bytes; retry only that explicit reply under one deadline. */
  async requestTraceAttachment(method: string, parameters: Readonly<Record<string, unknown>>, timeoutMilliseconds: number, expectedByteLength: number, signal?: AbortSignal): Promise<Buffer> {
    if (!isTraceCollectionTake(method)) throw failure('InvalidArgumentError', method, 'not a native trace collection transfer');
    if (!Number.isFinite(timeoutMilliseconds) || timeoutMilliseconds <= 0) throw failure('InvalidArgumentError', method, 'trace transfer needs a finite positive deadline');
    const deadline = performance.now() + timeoutMilliseconds;
    const originalParameters = Object.freeze({ ...parameters });
    for (;;) {
      signal?.throwIfAborted();
      const remaining = Math.floor(deadline - performance.now());
      if (remaining <= 0) throw failure('TimeoutError', method, 'deadline exceeded waiting for trace attachment capacity');
      const result = await this.request(method, originalParameters, remaining, true, undefined, undefined, expectedByteLength);
      signal?.throwIfAborted();
      if (Buffer.isBuffer(result)) return result;
      if (result !== null) throw failure('ProtocolError', method, 'invalid trace attachment admission reply');
      try { await waitForRetry(Math.min(10, Math.max(0, deadline - performance.now())), undefined, { signal }); }
      catch (error) { signal?.throwIfAborted(); throw error; }
    }
  }

  requestWithInput(method: string, parameters: unknown, buffers: readonly Buffer[], timeoutMilliseconds = 0): Promise<unknown> {
    return this.request(method, parameters, timeoutMilliseconds, false, buffers);
  }

  private async send(message: unknown, beforeWrite?: () => unknown | null): Promise<void> {
    const body = Buffer.from(JSON.stringify(message));
    if (body.length > this.resourceLimits.controlFrameBytes || this.queuedBytes + body.length + 4 > this.resourceLimits.controlFrameBytes * 2) {
      return Promise.reject(failure('ResourceLimitError', 'protocol', 'outgoing control-frame or queued-byte limit exceeded'));
    }
    const frame = Buffer.allocUnsafe(body.length + 4);
    frame.writeUInt32LE(body.length);
    body.copy(frame, 4);
    return this.queueFrame(frame, beforeWrite ? () => {
      const prepared = beforeWrite();
      if (prepared === null) return null;
      const body = Buffer.from(JSON.stringify(prepared));
      const outgoing = Buffer.allocUnsafe(body.length + 4);
      outgoing.writeUInt32LE(body.length);
      body.copy(outgoing, 4);
      return outgoing;
    } : undefined);
  }

  /** One bounded writer owns both control and binary frames, including blocked-pipe cancellation. */
  private async queueFrame(frame: Buffer, beforeWrite?: () => Buffer | null): Promise<void> {
    if (frame.length > this.resourceLimits.controlFrameBytes + 4 || this.queuedBytes + frame.length > this.resourceLimits.controlFrameBytes * 2) {
      throw failure('ResourceLimitError', 'protocol', 'outgoing control-frame or queued-byte limit exceeded');
    }
    this.queuedBytes += frame.length;
    const send = this.writeChain.then(async () => {
      if (this.failure) throw this.failure;
      const outgoing = beforeWrite ? beforeWrite() : frame;
      if (outgoing === null) return;
      if (!this.process.stdin.write(outgoing)) await once(this.process.stdin, 'drain', { signal: this.writeAborted.signal });
    }).finally(() => { this.queuedBytes -= frame.length; });
    this.writeChain = send.catch(error => { this.fail(error); });
    return send;
  }

  private consume(chunk: Buffer): void {
    if (this.failure) return;
    this.incoming = Buffer.concat([this.incoming, chunk]);
    try {
      while (this.incoming.length >= 4) {
        const length = this.incoming.readUInt32LE(0);
        if (length === 0 || length > this.resourceLimits.controlFrameBytes) throw failure('ProtocolError', 'protocol', 'invalid incoming frame size');
        if (this.incoming.length < length + 4) return;
        const body = this.incoming.subarray(4, length + 4);
        this.incoming = this.incoming.subarray(length + 4);
        if (body[0] === 0) {
          if (!this.attachments) throw failure('ProtocolError', 'protocol', 'attachment before handshake');
          this.attachments.receive(body);
          continue;
        }
        const message: Reply = JSON.parse(body.toString('utf8'));
        if (!message || typeof message !== 'object' || Array.isArray(message)) throw failure('ProtocolError', 'protocol', 'invalid driver envelope');
        if (message.kind === 'handshake') {
          if (this.handshakeComplete) throw failure('ProtocolError', 'handshake', 'duplicate driver handshake');
          const handshake = message.handshake;
          if (handshake?.protocolVersion !== engineHandshake.protocolVersion || handshake.packageVersion !== engineHandshake.packageVersion || handshake.capabilityInventoryVersion !== engineHandshake.capabilityInventoryVersion || message.residentRuntimeSha256 !== residentRuntimeSha256 || requiredCapabilities.some(method => !message.capabilities?.includes(method))) {
            throw failure('ProtocolError', 'handshake', 'driver/package capability mismatch');
          }
          for (const field of Object.keys(limits) as Array<keyof typeof limits>) {
            const value = handshake.limits?.[field];
            if (!Number.isSafeInteger(value) || value < 1 || value > limits[field]) throw failure('ProtocolError', 'handshake', 'invalid negotiated resource limits');
          }
          if (handshake.limits.controlFrameBytes < 1024) throw failure('ProtocolError', 'handshake', 'control frame limit is too small');
          if (handshake.limits.pendingOperations < minimumDialogPendingOperations) throw failure('ProtocolError', 'handshake', 'dialog-capable clients require at least two pending operation slots');
          this.resourceLimits = { ...handshake.limits };
          this.attachments = new AttachmentReceiver(this.resourceLimits.binaryAttachmentBytes, this.resourceLimits.pendingAttachments);
          this.readyResolve();
          this.handshakeComplete = true;
          continue;
        }
        if (message.kind === 'error' && message.requestId == null) throw fromRecord(message.error!);
        if (!this.handshakeComplete) throw failure('ProtocolError', 'handshake', 'driver message before handshake');
        if (message.kind === 'event') { this.receiveEvent(message); continue; }
        if (!Number.isSafeInteger(message.requestId) || message.requestId! <= 0) throw failure('ProtocolError', 'protocol', 'reply omitted request identity');
        const requestId = message.requestId!;
        const pending = this.pending.get(requestId);
        if (!pending) throw failure('ProtocolError', 'protocol', 'unexpected or duplicate terminal reply');
        if (message.kind === 'binaryStart') {
          if (!pending.binary) throw failure('ProtocolError', pending.method, 'unexpected binary attachment');
          if (pending.expectedBinaryByteLength !== undefined && message.byteLength !== pending.expectedBinaryByteLength) throw failure('ProtocolError', pending.method, 'binary attachment differs from its reserved byte length');
          this.attachments!.begin(requestId, message.encoding, message.byteLength, message.encodedLength, pending.deadlineExpired);
          continue;
        }
        if (message.kind === 'binaryResult') {
          if (!pending.binary) throw failure('ProtocolError', pending.method, 'unexpected binary result');
          message.value = this.attachments!.finish(requestId, message.byteLength);
        } else if (message.kind === 'error' && message.error) this.attachments!.discard(requestId);
        else if (message.kind !== 'result' || pending.binary && !(isTraceCollectionTake(pending.method) && message.value === null && !this.attachments!.has(requestId))) {
          throw failure('ProtocolError', 'protocol', 'unknown or mismatched terminal message');
        }
        this.removePending(requestId);
        if (pending.input) pending.input.bytes = undefined;
        clearTimeout(pending.timeout);
        clearTimeout(pending.cleanupTimeout);
        if (pending.deadlineExpired) void this.rejectExpired(pending, message);
        else if (message.kind === 'result' || message.kind === 'binaryResult') pending.resolve(message.value);
        else if (message.kind === 'error' && message.error) {
          const error = fromRecord(message.error);
          if (pending.callSite) error.stack += `\nCalled from:\n${pending.callSite}`;
          pending.reject(error);
        } else throw failure('ProtocolError', 'protocol', 'unknown terminal message');
      }
    } catch (error) { this.fail(error instanceof SyntaxError ? failure('ProtocolError', 'protocol', 'invalid incoming control JSON') : error instanceof Error ? error : new Error(String(error))); }
  }

  private async rejectExpired(pending: PendingRequest, message: Reply): Promise<void> {
    const details: ErrorRecord = { ...message.error, code: 'TimeoutError', method: message.error?.method ?? pending.method, message: message.error ? `operation exceeded its deadline; ${errorMessage(message.error)}` : 'operation exceeded its deadline' };
    delete details.messageUtf16;
    if (message.kind === 'result' || message.kind === 'binaryResult') {
      details.inputDelivery = message.inputDelivery ?? 'uncertain';
      if (pending.method === 'assertion.run') details.diagnostics = message.value;
    }
    // A successful allocation can cross the caller deadline before its reply arrives.
    // The caller never receives its identity, so dispose it before rejecting the call.
    const cleanup = {
      'browser.launch': { method: 'browser.close', owner: 'browser' },
      'browser.newContext': { method: 'context.close', owner: 'context' },
      'context.newPage': { method: 'page.close', owner: 'page' },
      'page.addInitScript': { method: 'initScript.dispose', owner: 'script' },
      'context.addInitScript': { method: 'initScript.dispose', owner: 'script' },
    }[pending.method];
    if (message.kind === 'result' && cleanup && message.value && typeof message.value === 'object' && 'identifier' in message.value) {
      try {
        await this.request(cleanup.method, { [cleanup.owner]: message.value.identifier }, 1000);
        details.cleanup = 'resourceDisposedAfterLateSuccess';
        if (typeof message.value.identifier === 'string') this.forgetObject(message.value.identifier);
      } catch (error) {
        details.cleanup = 'driverShutdownAfterLateSuccessCleanupFailure';
        this.fail(error instanceof Error ? error : new Error(String(error)));
      }
    }
    if (message.kind === 'result' && ['page.evaluateHandle', 'frame.evaluateHandle', 'handle.evaluateHandle', 'handle.getProperty', 'handle.getProperties', 'frame.waitForSelector'].includes(pending.method)) {
      const allocation = message.value as { page?: unknown; group?: unknown } | undefined;
      if (allocation && typeof allocation.page === 'string' && typeof allocation.group === 'string') {
        try {
          await this.request('handle.discard', { page: allocation.page, group: allocation.group }, 1000);
          details.cleanup = 'handleGroupDisposedAfterLateSuccess';
        } catch (error) {
          details.cleanup = 'driverShutdownAfterLateSuccessCleanupFailure';
          this.fail(error instanceof Error ? error : new Error(String(error)));
        }
      }
    }
    const error = fromRecord(details);
    if (pending.callSite) error.stack += `\nCalled from:\n${pending.callSite}`;
    pending.reject(error);
  }

  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    this.traceAdmission?.close(error);
    this.readyReject(error);
    for (const pending of this.pending.values()) { clearTimeout(pending.timeout); clearTimeout(pending.cleanupTimeout); if (pending.input) pending.input.bytes = undefined; pending.reject(error); }
    this.pending.clear();
    this.notifyControlCapacity();
    this.attachments?.clear();
    this.writeAborted.abort();
    for (const listener of this.objectListeners.values()) queueMicrotask(() => listener({ event: 'transportclosed', parameters: null }));
    this.bufferedEvents.clear();
    this.bufferedEventCount = 0;
    this.process.stdin.destroy();
    this.parentLiveness.destroy();
  }
}

let implicitClient: EngineClient | undefined;
export function retainEngine(deadline = Infinity): EngineClient {
  if (!implicitClient || implicitClient.isClosed()) {
    const executablePath = resolveDriverExecutable();
    if (performance.now() >= deadline) throw failure('TimeoutError', 'chromium.launch', 'deadline exceeded while resolving the driver');
    implicitClient = new EngineClient(executablePath);
  }
  implicitClient.retain();
  return implicitClient;
}
