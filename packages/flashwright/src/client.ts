import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { performance } from 'node:perf_hooks';
import { Duplex } from 'node:stream';
import { failure, fromRecord, errorMessage, type ErrorRecord } from './errors.js';
import { residentRuntimeSha256 } from './runtime-version.cjs';
import { AttachmentReceiver } from './attachments.js';

export const requiredCapabilities = [
  'browser.launch', 'browser.close', 'browser.newContext', 'context.newPage', 'context.close',
  'page.close', 'page.evaluate', 'page.goto', 'page.waitForLoadState', 'response.body',
  'locator.run', 'assertion.run', 'keyboard.press',
  'context.cookies', 'context.addCookies', 'context.clearCookies', 'context.storageState',
];

const maximumFrameBytes = 8 * 1024 * 1024;
const maximumPendingOperations = 1024;
const limits = { controlFrameBytes: maximumFrameBytes, pendingOperations: maximumPendingOperations, queuedMessages: 128, valueDepth: 64, valueNodes: 100000, binaryAttachmentBytes: 32 * 1024 * 1024, pendingAttachments: 2 };
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
    void this.send({ kind: 'handshake', handshake: { packageVersion: '0.0.0', protocolVersion: 5, capabilityInventoryVersion: 1, limits } }).catch(error => this.fail(error));
  }

  subscribeObject(identifier: string, listener: (event: ObjectEvent) => void): () => void {
    this.objectListeners.set(identifier, listener);
    for (const event of this.bufferedEvents.get(identifier) ?? []) {
      this.bufferedEventCount--;
      queueMicrotask(() => listener(event));
    }
    this.bufferedEvents.delete(identifier);
    if (this.failure) queueMicrotask(() => listener({ event: 'transportclosed', parameters: null }));
    return () => this.forgetObject(identifier);
  }

  private forgetObject(identifier: string): void {
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

  retain(): void { this.references++; }
  isClosed(): boolean { return this.closed || this.failure !== undefined; }

  async release(): Promise<void> {
    if (--this.references > 0) return;
    this.closed = true;
    this.process.stdin.end();
    const termination = setTimeout(() => this.process.kill('SIGKILL'), 3000);
    try { await this.exited; } finally { clearTimeout(termination); }
  }

  /** timeout 0 means unbounded publicly; an exhausted finite budget is sent as zero remaining. */
  async request(method: string, parameters: unknown, timeoutMilliseconds = 0, binary = false): Promise<unknown> {
    const started = performance.now();
    const callSite = new Error().stack;
    let readinessTimeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await (timeoutMilliseconds === 0 ? this.ready : Promise.race([
        this.ready,
        new Promise<never>((_, reject) => { readinessTimeout = setTimeout(() => reject(failure('TimeoutError', method, 'deadline exceeded before driver acceptance')), timeoutMilliseconds); }),
      ]));
    } finally { clearTimeout(readinessTimeout); }
    if (this.failure) throw this.failure;
    if (this.closed) throw failure('BrowserDisconnectedError', method, 'engine client is closed');
    if (this.pending.size >= this.resourceLimits.pendingOperations) throw failure('ResourceLimitError', method, 'too many pending operations');
    const identifier = this.nextIdentifier++;
    const remaining = timeoutMilliseconds === 0 ? null : Math.max(0, Math.floor(timeoutMilliseconds - (performance.now() - started)));
    return new Promise((resolve, reject) => {
      const timeout = remaining === null ? undefined : setTimeout(() => {
        const pending = this.pending.get(identifier);
        if (!pending) return;
        pending.deadlineExpired = true;
        this.attachments?.expire(identifier);
        if (!pending.dispatched) {
          this.pending.delete(identifier);
          reject(failure('TimeoutError', method, 'deadline exceeded before dispatch'));
          return;
        }
        void this.send({ kind: 'cancel', requestId: identifier }).catch(error => this.fail(error));
        // A stuck driver must not also disable the independent caller-side deadline path.
        pending.cleanupTimeout = setTimeout(() => {
          this.fail(failure('TimeoutError', method, 'deadline exceeded; driver did not finish cancellation within the 2 second cleanup budget'));
          this.process.kill('SIGKILL');
        }, 2000);
      }, remaining);
      this.pending.set(identifier, { method, resolve, reject, timeout, cleanupTimeout: undefined, dispatched: false, deadlineExpired: false, callSite, binary });
      const message = { kind: 'command', requestId: identifier, method, parameters, timeoutMilliseconds: remaining };
      void this.send(message, () => {
        const pending = this.pending.get(identifier);
        if (!pending) return null;
        const remaining = timeoutMilliseconds === 0 ? null : Math.max(0, Math.floor(timeoutMilliseconds - (performance.now() - started)));
        if (remaining === 0) {
          this.pending.delete(identifier);
          clearTimeout(pending.timeout);
          reject(failure('TimeoutError', method, 'deadline exceeded before dispatch'));
          return null;
        }
        pending.dispatched = true;
        return { ...message, timeoutMilliseconds: remaining };
      }).catch(error => {
        const pending = this.pending.get(identifier);
        this.pending.delete(identifier);
        clearTimeout(pending?.timeout);
        clearTimeout(pending?.cleanupTimeout);
        reject(error);
      });
    });
  }

  requestBinary(method: string, parameters: unknown, timeoutMilliseconds = 0): Promise<Buffer> {
    return this.request(method, parameters, timeoutMilliseconds, true) as Promise<Buffer>;
  }

  private async send(message: unknown, beforeWrite?: () => unknown | null): Promise<void> {
    const body = Buffer.from(JSON.stringify(message));
    if (body.length > this.resourceLimits.controlFrameBytes || this.queuedBytes + body.length + 4 > this.resourceLimits.controlFrameBytes * 2) {
      return Promise.reject(failure('ResourceLimitError', 'protocol', 'outgoing control-frame or queued-byte limit exceeded'));
    }
    const frame = Buffer.allocUnsafe(body.length + 4);
    frame.writeUInt32LE(body.length);
    body.copy(frame, 4);
    this.queuedBytes += frame.length;
    const send = this.writeChain.then(async () => {
      if (this.failure) throw this.failure;
      let outgoing = frame;
      if (beforeWrite) {
        const prepared = beforeWrite();
        if (prepared === null) return;
        const body = Buffer.from(JSON.stringify(prepared));
        outgoing = Buffer.allocUnsafe(body.length + 4);
        outgoing.writeUInt32LE(body.length);
        body.copy(outgoing, 4);
      }
      if (!this.process.stdin.write(outgoing)) await once(this.process.stdin, 'drain');
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
          if (handshake?.protocolVersion !== 5 || handshake.packageVersion !== '0.0.0' || handshake.capabilityInventoryVersion !== 1 || message.residentRuntimeSha256 !== residentRuntimeSha256 || requiredCapabilities.some(method => !message.capabilities?.includes(method))) {
            throw failure('ProtocolError', 'handshake', 'driver/package capability mismatch');
          }
          for (const field of Object.keys(limits) as Array<keyof typeof limits>) {
            const value = handshake.limits?.[field];
            if (!Number.isSafeInteger(value) || value < 1 || value > limits[field]) throw failure('ProtocolError', 'handshake', 'invalid negotiated resource limits');
          }
          if (handshake.limits.controlFrameBytes < 1024) throw failure('ProtocolError', 'handshake', 'control frame limit is too small');
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
          this.attachments!.begin(requestId, message.encoding, message.byteLength, message.encodedLength, pending.deadlineExpired);
          continue;
        }
        if (message.kind === 'binaryResult') {
          if (!pending.binary) throw failure('ProtocolError', pending.method, 'unexpected binary result');
          message.value = this.attachments!.finish(requestId, message.byteLength);
        } else if (message.kind === 'error' && message.error) this.attachments!.discard(requestId);
        else if (message.kind !== 'result' || pending.binary) throw failure('ProtocolError', 'protocol', 'unknown or mismatched terminal message');
        this.pending.delete(requestId);
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
    const error = fromRecord(details);
    if (pending.callSite) error.stack += `\nCalled from:\n${pending.callSite}`;
    pending.reject(error);
  }

  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    this.readyReject(error);
    for (const pending of this.pending.values()) { clearTimeout(pending.timeout); clearTimeout(pending.cleanupTimeout); pending.reject(error); }
    this.pending.clear();
    this.attachments?.clear();
    for (const listener of this.objectListeners.values()) queueMicrotask(() => listener({ event: 'transportclosed', parameters: null }));
    this.bufferedEvents.clear();
    this.bufferedEventCount = 0;
    this.process.stdin.destroy();
    this.parentLiveness.destroy();
  }
}

let implicitClient: EngineClient | undefined;
export function retainEngine(): EngineClient {
  if (!implicitClient || implicitClient.isClosed()) {
    const executablePath = process.env.FLASHWRIGHT_DRIVER_PATH;
    if (!executablePath) throw failure('UnsupportedFeatureError', 'chromium.launch', 'this development build requires FLASHWRIGHT_DRIVER_PATH pointing to the compiled flashwright-driver executable');
    implicitClient = new EngineClient(executablePath);
  }
  implicitClient.retain();
  return implicitClient;
}
