import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { EngineClient } from './client.js';
import { failure } from './errors.js';
import { validateOptions } from './validation.js';
import { TraceWriter } from './trace-writer.js';
import { TraceResources } from './trace-resources.js';
import { TraceDiagnosticChannel, type TraceDiagnostic } from './trace-diagnostics.js';
import { tracePreview, serializedTracePreview, traceStack, traceError } from './trace-preview.js';
import { traceChunkOpened, traceChunkClosed, type TraceOwner, type TraceCallMetadata } from './trace-hooks.js';
import { pageError } from './page-errors.js';
import { remotePreview } from './console.js';
import { TraceFilmstripChannel, sampleTraceClock } from './trace-filmstrip.js';

export interface TracingStartOptions { name?: string; title?: string; screenshots?: boolean; snapshots?: boolean; sources?: boolean }
export interface TracingChunkOptions { name?: string; title?: string }
export interface TracingStopOptions { path?: string }
interface TraceChunk { identifier: string; writer: TraceWriter; channel?: TraceDiagnosticChannel; filmstrip?: TraceFilmstripChannel; accepting: boolean }
export interface TraceCall { identifier: string; chunk: TraceChunk; completed: boolean; evaluates: boolean; pageId: string | undefined; nativeTrace?: TraceCallMetadata }
const processIdentity = randomUUID();
let nextCall = 0;
let nextContext = 0;

/** Manual action tracing owns context diagnostics and independent, bounded archive chunks. */
export class Tracing {
  private readonly traceContext = `${processIdentity}@context-${++nextContext}`;
  private recording = false;
  private resources: TraceResources | undefined;
  private includeSources = false;
  private includeScreenshots = false;
  private ownerIsClosed = false;
  private controlling = false;
  private chunk: TraceChunk | undefined;
  private readonly calls = new Set<TraceCall>();
  private cleanup: Promise<void> | undefined;
  private cleanupFailure: unknown;
  private retiringChunk: TraceChunk | undefined;
  private exportCancellation: AbortController | undefined;
  constructor(private readonly client: EngineClient, private readonly context: string, private readonly viewport: { width: number; height: number } | null) {}

  start(options: TracingStartOptions = {}): Promise<void> {
    return this.control(async () => {
      validateOptions('tracing.start', options, ['name', 'title', 'screenshots', 'snapshots', 'sources']);
      for (const key of ['screenshots', 'snapshots', 'sources'] as const) {
        if (options[key] !== undefined && typeof options[key] !== 'boolean') throw failure('InvalidArgumentError', `tracing.start.${key}`, 'expected a boolean');
        if (key === 'snapshots' && options[key]) throw failure('UnsupportedFeatureError', `tracing.start.${key}`, 'manual tracing does not yet capture DOM snapshots');
      }
      validateChunkOptions(options);
      if (this.recording) throw failure('InvalidArgumentError', 'tracing.start', 'tracing is already started');
      this.resources = await TraceResources.create();
      this.includeSources = options.sources ?? false;
      this.includeScreenshots = options.screenshots ?? false;
      try { await this.openChunk(options); this.recording = true; }
      catch (error) {
        const resources = this.resources;
        this.resources = undefined;
        await this.waitForCleanup(resources?.dispose() ?? Promise.resolve());
        throw error;
      }
    });
  }
  startChunk(options: TracingChunkOptions = {}): Promise<void> {
    return this.control(async () => {
      validateOptions('tracing.startChunk', options, ['name', 'title']);
      validateChunkOptions(options);
      if (!this.recording) throw failure('InvalidArgumentError', 'tracing.startChunk', 'must start tracing first');
      await this.finishChunk(undefined);
      await this.openChunk(options);
    });
  }
  stopChunk(options: TracingStopOptions = {}): Promise<void> {
    return this.control(async () => { validateStopOptions(options); await this.finishChunk(options.path); });
  }
  stop(options: TracingStopOptions = {}): Promise<void> {
    return this.control(async () => {
      validateStopOptions(options);
      try { await this.finishChunk(options.path, true); }
      finally { this.recording = false; }
    });
  }
  private async control(callback: () => Promise<void>): Promise<void> {
    if (this.ownerIsClosed) throw failure('TargetClosedError', 'tracing', 'context has been closed');
    if (this.controlling) throw failure('InvalidArgumentError', 'tracing', 'another tracing control operation is in progress');
    if (this.cleanup) throw failure('ResourceLimitError', 'tracing', 'previous trace cleanup has not settled');
    if (this.cleanupFailure) throw this.cleanupFailure;
    this.controlling = true;
    try { await callback(); } finally { this.controlling = false; }
  }
  private async openChunk(options: TracingChunkOptions): Promise<void> {
    if (this.ownerIsClosed) throw failure('TargetClosedError', 'tracing.startChunk', 'context is closed');
    if (this.cleanup) throw failure('ResourceLimitError', 'tracing.startChunk', 'previous trace cleanup has not settled');
    if (!this.resources) throw failure('ProtocolError', 'tracing', 'recording resource owner is unavailable');
    const writer = await TraceWriter.create(this.resources);
    const chunk: TraceChunk = { identifier: randomUUID(), writer, accepting: false };
    try {
      const clock = this.includeScreenshots ? await sampleTraceClock(this.client, this.context) : undefined;
      writer.append({ version: 8, type: 'context-options', origin: 'library', browserName: 'chromium', playwrightVersion: '1.60.0', options: { viewport: this.viewport }, platform: process.platform, wallTime: Date.now(), monotonicTime: performance.now(), sdkLanguage: 'javascript', contextId: this.traceContext, title: options.title, testIdAttributeName: 'data-testid', ...(clock ? { flashwrightClock: clock } : {}) });
      chunk.channel = await TraceDiagnosticChannel.start(this.client, this.context, chunk.identifier, diagnostic => this.diagnostic(chunk, diagnostic), error => writer.fail(error));
      if (clock) chunk.filmstrip = await TraceFilmstripChannel.start(this.client, this.context, chunk.identifier, clock, this.resources, writer, page => this.pageIdentity(page));
      if (this.ownerIsClosed) { chunk.channel.ownerClosed(); chunk.filmstrip?.ownerClosed(); throw failure('TargetClosedError', 'tracing.start', 'context closed while starting tracing'); }
      this.chunk = chunk;
      chunk.accepting = true;
      traceChunkOpened();
    } catch (error) {
      this.cleanupFailure ??= writer.failure;
      await this.waitForCleanup((async () => {
        try { await Promise.all([chunk.channel?.stop(), chunk.filmstrip?.stop()]); }
        finally { await writer.dispose(); }
      })());
      throw error;
    }
  }
  private seal(chunk: TraceChunk): void {
    if (chunk.accepting) { chunk.accepting = false; traceChunkClosed(); }
  }
  private async finishChunk(path: string | undefined, retireRecording = false): Promise<void> {
    const resources = retireRecording ? this.resources : undefined;
    if (retireRecording) this.resources = undefined;
    const chunk = this.chunk;
    if (!chunk) {
      if (resources) await this.waitForCleanup(resources.dispose());
      if (path !== undefined) throw failure('InvalidArgumentError', 'tracing.stopChunk', 'must start tracing before exporting');
      return;
    }
    this.seal(chunk);
    this.chunk = undefined;
    const cancellation = new AbortController();
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
    const work = (async () => {
      await Promise.all([chunk.channel?.stop(), chunk.filmstrip?.stop(cancellation.signal)]);
      await chunk.writer.finish(path, cancellation.signal, () => {
        cancellation.signal.throwIfAborted();
        if (performance.now() >= deadline) throw failure('TimeoutError', 'tracing.stopChunk', 'trace preparation exceeded 30 seconds before atomic commit');
        committing = true;
        clearTimeout(timer);
      });
    })();
    let originalFailure: unknown;
    let failed = false;
    try { await Promise.race([work, expired, interrupted]); }
    catch (error) { originalFailure = error; failed = true; }
    finally {
      clearTimeout(timer);
      cancellation.signal.removeEventListener('abort', interrupt);
      this.retiringChunk = undefined;
      this.exportCancellation = undefined;
      const dispose = async () => {
        try { await chunk.writer.dispose(); }
        finally { await resources?.dispose(); }
      };
      await this.waitForCleanup(work.then(dispose, dispose));
    }
    if (failed) throw originalFailure;
    if (this.cleanupFailure) throw this.cleanupFailure;
  }

  /** Compose every cleanup owner; a newer closure cannot hide an older pending export. */
  private ownCleanup(work: Promise<void>): Promise<void> {
    const ownership = Promise.allSettled(this.cleanup ? [this.cleanup, work] : [work]).then(results => {
      for (const result of results) if (result.status === 'rejected') this.cleanupFailure ??= result.reason;
    });
    this.cleanup = ownership;
    void ownership.then(() => { if (this.cleanup === ownership) this.cleanup = undefined; });
    return ownership;
  }
  private async waitForCleanup(work: Promise<void>): Promise<void> {
    const ownership = this.ownCleanup(work);
    let grace: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([ownership, new Promise<void>(resolve => { grace = setTimeout(resolve, 2000); })]);
    clearTimeout(grace);
  }

  begin(className: string, method: string, title: string, owner: TraceOwner, parameterNames: readonly string[], values: unknown[]): TraceCall | undefined {
    const chunk = this.chunk;
    if (!chunk?.accepting || this.ownerIsClosed || chunk.writer.failure) return undefined;
    if (this.calls.size >= 1024) { chunk.writer.fail(failure('ResourceLimitError', 'tracing', 'trace exceeds 1024 unfinished public calls')); return undefined; }
    const call: TraceCall = { identifier: `${processIdentity}@${++nextCall}`, chunk, completed: false, evaluates: method.includes('eval'), pageId: owner.pageId };
    if (this.includeScreenshots) call.nativeTrace = Object.freeze({ context: this.context, generation: chunk.identifier });
    this.calls.add(call);
    chunk.filmstrip?.activity(owner.pageId);
    try {
      const parameters: Record<string, unknown> = Object.create(null);
      if (owner.selector !== undefined) parameters.selector = owner.selector;
      for (let index = 0; index < parameterNames.length; index++) parameters[parameterNames[index]!] = values[index];
      const preview = tracePreview(parameters, 16384) as Record<string, unknown>;
      const argumentIndex = parameterNames.indexOf('arg');
      if (call.evaluates && argumentIndex !== -1) {
        preview.arg = { value: serializedTracePreview(values[argumentIndex]), handles: [] };
        preview.isFunction = typeof values[parameterNames.indexOf('expression')] === 'function';
      }
      const stack = traceStack();
      if (this.includeSources) chunk.writer.referenceSources(stack);
      chunk.writer.append({ type: 'before', callId: call.identifier, startTime: performance.now(), class: className, method, title, params: preview, pageId: owner.pageId === undefined ? undefined : this.pageIdentity(owner.pageId), stack });
    } catch (error) { chunk.writer.fail(error); }
    return call;
  }
  async complete(call: TraceCall, value: unknown, error: unknown, failed: boolean): Promise<void> {
    if (call.completed) return;
    call.completed = true;
    try {
      if (!call.chunk.accepting) return;
      call.chunk.filmstrip?.activity(call.pageId);
      await call.chunk.channel?.fence();
      if (call.chunk.accepting) call.chunk.writer.append({ type: 'after', callId: call.identifier, endTime: performance.now(), ...(failed ? { error: traceError(error) } : { result: { value: call.evaluates ? serializedTracePreview(value) : tracePreview(value) } }) });
    } catch (captureError) { call.chunk.writer.fail(captureError); }
    finally { this.calls.delete(call); }
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
  /** Explicit closure drains first, without changing screenshot hooks or the user's close result. */
  async beforeOwnerClose(): Promise<void> {
    try { await this.waitForCleanup(Promise.all([this.chunk?.channel?.stop(), this.chunk?.filmstrip?.stop()]).then(() => {})); }
    catch (error) { this.chunk?.writer.fail(error); }
  }
  ownerClosed(): void {
    this.ownerIsClosed = true;
    this.recording = false;
    this.retiringChunk?.channel?.ownerClosed();
    this.retiringChunk?.filmstrip?.ownerClosed();
    this.exportCancellation?.abort(failure('TargetClosedError', 'tracing', 'context closed during export'));
    const chunk = this.chunk;
    this.chunk = undefined;
    const resources = this.resources;
    this.resources = undefined;
    if (chunk) {
      this.seal(chunk);
      chunk.channel?.ownerClosed();
      chunk.filmstrip?.ownerClosed();
    }
    if (chunk || resources) {
      this.ownCleanup((async () => {
        try { await chunk?.filmstrip?.stop(); await chunk?.writer.dispose(); }
        finally { await resources?.dispose(); }
      })());
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
