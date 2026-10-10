import { failure, type BrowserContext } from '@flashwright/core';
import { runnerIntegration } from '@flashwright/core/runner-integration';
import type { TestInfo } from 'flashwright-upstream-runner/test';
import { adoptRunnerTraceAtStart, type RunnerJournalAdmission } from './runner-trace-journal.js';
import { installRunnerTraceFinalizer, type RunnerTraceCollection } from './runner-trace-finalizer.js';
import { createOwnedTraceSteps, type OwnedTraceSteps } from './trace-steps.js';
import { ScreenshotScopes } from './screenshot-recorder.js';
import type { ScreenshotPolicy } from './screenshot-policy.js';

type Recording = Awaited<ReturnType<typeof runnerIntegration.startTraceRecordingWithActions>>;
type Chunk = NonNullable<ReturnType<typeof runnerIntegration.currentTraceChunk>>;
type Archive = Awaited<ReturnType<Chunk['takeArchive']>>;
type CreationOwner = ReturnType<Parameters<typeof runnerIntegration.installArtifactContextLifecycle>[1]['beginContextCreation']>;
interface TraceOptions { screenshots: boolean; snapshots: boolean }
interface PinnedTestInfo extends TestInfo { _tracing: { traceOptions(): TraceOptions | undefined } }
interface RecordingOwner {
  readonly context: BrowserContext;
  readonly options: TraceOptions;
  controls?: Recording;
  capture?: ContextCapture;
  lastCapture: ContextCapture;
  retirement?: Promise<void>;
  closedCleanup?: Promise<void>;
}

const maximumAttemptCaptures = 128;
const maximumWorkerCaptures = 256;
const maximumWorkerRecordings = 128;

/** One worker observer assigns every asynchronous creation to its original attempt. */
export class RunnerArtifactCoordinator {
  readonly contexts = new Set<BrowserContext>();
  private readonly attempts = new WeakMap<TestInfo, TraceAttempt>();
  private readonly recordings = new Map<BrowserContext, RecordingOwner>();
  private readonly activeCaptures = new WeakMap<BrowserContext, ContextCapture>();
  private registration: ReturnType<typeof runnerIntegration.installArtifactContextLifecycle> | undefined;
  private current: TraceAttempt | undefined;
  private screenshots: ScreenshotScopes | undefined;
  private outstandingCaptures = 0;
  private readiness: Promise<void> = Promise.resolve();
  private retiring = false;

  /** Called synchronously at the owned normalized-policy boundary, before live or fixture work. */
  start(testInfo: TestInfo): boolean {
    const previous = this.attempts.get(testInfo);
    if (previous) return true;
    const admission = adoptRunnerTraceAtStart(testInfo);
    if (!admission) {
      this.current = undefined;
      this.readiness = this.retireIdleRecordings().catch(() => {});
      return false;
    }
    const options = (testInfo as PinnedTestInfo)._tracing.traceOptions()!;
    const attempt = new TraceAttempt(this, testInfo, admission, { screenshots: options.screenshots, snapshots: options.snapshots });
    this.current = attempt;
    this.attempts.set(testInfo, attempt);
    const finalizer = installRunnerTraceFinalizer(testInfo, admission, attempt);
    void finalizer.cleanup.then(() => { if (finalizer.cleanupSucceeded) this.outstandingCaptures -= attempt.captureCount; });
    try {
      if (!this.registration) this.observeContexts();
      else for (const context of this.contexts) attempt.enrollExisting(context);
      this.readiness = (async () => { await this.registration?.ready; await attempt.ready(); })();
    } catch (error) { attempt.fail(error); this.readiness = Promise.resolve(); }
    void this.readiness.catch(error => attempt.fail(error));
    return true;
  }

  async ready(): Promise<void> {
    await this.registration?.ready.catch(error => this.current?.fail(error));
    await this.readiness.catch(error => this.current?.fail(error));
  }

  configureScreenshots(policy: ScreenshotPolicy): ScreenshotScopes | undefined {
    if (policy.mode === 'off') return undefined;
    if (!this.screenshots) this.screenshots = new ScreenshotScopes(policy, this.contexts);
    if (!this.registration) this.observeContexts();
    return this.screenshots;
  }

  reserveCapture(): boolean {
    if (this.retiring || this.outstandingCaptures >= maximumWorkerCaptures) return false;
    ++this.outstandingCaptures;
    return true;
  }

  /** Reserve before native startup; failed cleanup keeps this original recording slot. */
  async recording(context: BrowserContext, capture: ContextCapture, options: TraceOptions): Promise<RecordingOwner> {
    if (this.retiring) throw failure('ResourceLimitError', 'runner.tracing', 'worker artifact capture is retiring');
    const previous = this.recordings.get(context);
    if (previous) {
      if (previous.capture || previous.retirement) throw failure('ResourceLimitError', 'runner.tracing', 'the previous context capture has not retired');
      if (previous.options.screenshots === options.screenshots && previous.options.snapshots === options.snapshots) {
        previous.capture = capture;
        previous.lastCapture = capture;
        this.activeCaptures.set(context, capture);
        return previous;
      }
      await this.retireRecording(previous);
      if (this.retiring) throw failure('ResourceLimitError', 'runner.tracing', 'worker artifact capture is retiring');
    }
    if (this.recordings.size >= maximumWorkerRecordings) throw failure('ResourceLimitError', 'runner.tracing', 'worker exceeds 128 live or retiring trace recordings');
    const recording: RecordingOwner = { context, capture, lastCapture: capture, options: { ...options } };
    this.recordings.set(context, recording);
    this.activeCaptures.set(context, capture);
    return recording;
  }

  releaseFailedStartup(recording: RecordingOwner): void {
    if (recording.capture) this.finishChunk(recording, recording.capture);
    if (!recording.controls && this.recordings.get(recording.context) === recording) this.recordings.delete(recording.context);
  }

  finishChunk(recording: RecordingOwner, capture: ContextCapture): void {
    if (recording.capture === capture) delete recording.capture;
    if (this.activeCaptures.get(recording.context) === capture) this.activeCaptures.delete(recording.context);
    if (this.retiring && recording.controls && !recording.capture && !recording.closedCleanup) {
      void this.retireRecording(recording).catch(error => recording.lastCapture.failCleanup(error));
    }
  }

  retireRecording(recording: RecordingOwner): Promise<void> {
    recording.retirement ??= (async () => {
      if (recording.capture) throw failure('ProtocolError', 'runner.tracing', 'cannot retire a recording with an owned active chunk');
      await recording.controls?.stop();
      if (this.recordings.get(recording.context) === recording) this.recordings.delete(recording.context);
    })();
    return recording.retirement;
  }

  private observeContexts(): void {
    this.registration = runnerIntegration.installArtifactContextLifecycle(9, {
      beginContextCreation: () => {
        const owner = this.current?.claim();
        return {
          didCreateContext: async context => { this.observe(context); await owner?.didCreateContext(context); },
          complete: () => owner?.complete(),
        };
      },
      didCreateUnclaimedContext: context => this.observe(context),
      willCloseContext: async (context, source) => {
        if (source !== 'browser') await this.screenshots?.beforeContextClose(context);
        const capture = this.activeCaptures.get(context);
        if (capture) await capture.beforeContextClose();
        else {
          const recording = this.recordings.get(context);
          if (recording) await this.retireRecording(recording).catch(error => this.current?.fail(error));
        }
      },
    });
  }

  private observe(context: BrowserContext): void {
    if (this.contexts.has(context)) return;
    this.contexts.add(context);
    context.once('close', () => {
      this.contexts.delete(context);
      const recording = this.recordings.get(context);
      if (!recording) return;
      recording.closedCleanup = runnerIntegration.settleClosedTraceCleanup(11, context.tracing).then(() => {
        recording.capture?.didCloseContext();
        if (this.recordings.get(context) === recording) this.recordings.delete(context);
      });
      void recording.closedCleanup.catch(error => recording.lastCapture.failCleanup(error));
    });
  }

  private async retireIdleRecordings(): Promise<void> {
    const results = await Promise.allSettled([...this.recordings.values()].filter(recording => !recording.capture).map(recording => this.retireRecording(recording)));
    const rejected = results.find(result => result.status === 'rejected');
    if (rejected?.status === 'rejected') throw rejected.reason;
  }

  async dispose(): Promise<void> {
    this.retiring = true;
    try { await this.registration?.dispose(); } catch (error) { this.current?.fail(error); }
    await Promise.all([...this.recordings.values()].map(recording => recording.capture?.beforeContextClose()));
    try { await this.retireIdleRecordings(); } catch (error) { this.current?.fail(error); }
    this.contexts.clear();
    this.current = undefined;
  }
}

/** The finalizer owns this collection and releases its admissions only after all archive cleanup. */
class TraceAttempt implements RunnerTraceCollection {
  private readonly captures: ContextCapture[] = [];
  private readonly steps: OwnedTraceSteps | undefined;
  private accepting = true;
  private captureFailure: { error: unknown } | undefined;
  private disposal: Promise<void> | undefined;

  constructor(readonly coordinator: RunnerArtifactCoordinator, testInfo: TestInfo, admission: RunnerJournalAdmission, readonly options: TraceOptions) {
    this.steps = admission.journal ? createOwnedTraceSteps(testInfo, admission.journal) : undefined;
    if (admission.failure !== undefined) this.fail(admission.failure);
  }

  get captureCount(): number { return this.captures.length; }
  get active(): boolean { return this.accepting; }
  get observer(): OwnedTraceSteps['observer'] { return this.steps?.observer ?? { begin() { return undefined; } }; }
  fail(error: unknown): void { this.captureFailure ??= { error }; }

  claim(): CreationOwner | undefined {
    if (!this.accepting || !this.steps) return undefined;
    if (this.captures.length >= maximumAttemptCaptures || !this.coordinator.reserveCapture()) {
      this.fail(failure('ResourceLimitError', 'runner.tracing', 'trace exceeds 128 captures per attempt or 256 outstanding worker captures'));
      return undefined;
    }
    const capture = new ContextCapture(this);
    this.captures.push(capture);
    return { didCreateContext: context => capture.start(context), complete: () => capture.completeClaim() };
  }

  enrollExisting(context: BrowserContext): void {
    const claim = this.claim();
    if (!claim) return;
    void claim.didCreateContext(context).finally(() => claim.complete());
  }

  async ready(): Promise<void> { await Promise.all(this.captures.map(capture => capture.claimSettled)); }

  closeAdmission(): void { this.accepting = false; this.steps?.close(); }

  async collect(acceptArchive: (archive: Archive) => void, signal: AbortSignal): Promise<void> {
    await this.ready();
    signal.throwIfAborted();
    // Seal all admitted chunks promptly, so an earlier slow context cannot keep later ones accepting.
    await Promise.all(this.captures.map(capture => capture.seal(signal)));
    if (this.captureFailure) throw this.captureFailure.error;
    for (const capture of this.captures) { signal.throwIfAborted(); capture.handoff(acceptArchive); }
  }

  dispose(): Promise<void> {
    this.closeAdmission();
    this.disposal ??= (async () => {
      await this.ready();
      const results = await Promise.allSettled(this.captures.map(capture => capture.dispose()));
      const rejected = results.find(result => result.status === 'rejected');
      if (rejected?.status === 'rejected') throw rejected.reason;
    })();
    return this.disposal;
  }
}

/** One original creation retains its exact startup, chunk and any archive rejected by the finalizer. */
class ContextCapture {
  readonly claimSettled: Promise<void>;
  private resolveClaim!: () => void;
  private recording: RecordingOwner | undefined;
  private chunk: Chunk | undefined;
  private startupCleanup: Promise<void> = Promise.resolve();
  private startup: Promise<void> = Promise.resolve();
  private chunkCleanup: Promise<void> = Promise.resolve();
  private sealing: Promise<void> | undefined;
  private archive: Archive | undefined;
  private cleanupFailure: { error: unknown } | undefined;

  constructor(private readonly attempt: TraceAttempt) {
    this.claimSettled = new Promise(resolve => { this.resolveClaim = resolve; });
  }

  completeClaim(): void { this.resolveClaim(); }
  failCleanup(error: unknown): void { this.cleanupFailure ??= { error }; this.attempt.fail(error); }
  didCloseContext(): void {
    this.chunk = undefined;
    if (this.recording) this.attempt.coordinator.finishChunk(this.recording, this);
  }

  start(context: BrowserContext): Promise<void> {
    this.startup = this.startOwned(context);
    return this.startup;
  }

  private async startOwned(context: BrowserContext): Promise<void> {
    if (!this.attempt.active) return;
    try {
      const recording = await this.attempt.coordinator.recording(context, this, this.attempt.options);
      this.recording = recording;
      if (recording.controls) {
        const startup = runnerIntegration.beginTraceRecordingChunk(11, context.tracing, recording.controls.recording, this.attempt.observer);
        this.startupCleanup = startup.cleanup;
        try { this.chunk = await startup.ready; }
        catch (error) {
          void startup.cleanup.then(() => this.attempt.coordinator.finishChunk(recording, this), () => {});
          throw error;
        }
      }
      else {
        const startup = runnerIntegration.beginTraceRecordingWithActions(11, context.tracing, { ...this.attempt.options, sources: false }, this.attempt.observer);
        this.startupCleanup = startup.cleanup;
        try {
          const started = await startup.ready;
          recording.controls = started;
          this.chunk = started.chunk;
        }
        catch (error) {
          void startup.cleanup.then(() => this.attempt.coordinator.releaseFailedStartup(recording), () => {});
          throw error;
        }
      }
    } catch (error) { this.attempt.fail(error); }
  }

  seal(signal?: AbortSignal): Promise<void> {
    this.sealing ??= (async () => {
      await this.startup;
      if (!this.chunk) return;
      const chunk = this.chunk;
      try {
        this.archive = await chunk.takeArchive(signal);
        this.chunk = undefined;
        this.attempt.coordinator.finishChunk(this.recording!, this);
      } catch (error) {
        this.attempt.fail(error);
        this.chunkCleanup = runnerIntegration.discardTraceChunk(11, this.recording!.context.tracing, chunk).then(() => {
          this.chunk = undefined;
          this.attempt.coordinator.finishChunk(this.recording!, this);
        });
        void this.chunkCleanup.catch(cleanupError => this.failCleanup(cleanupError));
      }
    })();
    return this.sealing;
  }

  handoff(acceptArchive: (archive: Archive) => void): void {
    if (!this.archive) return;
    acceptArchive(this.archive);
    this.archive = undefined;
  }

  async beforeContextClose(): Promise<void> {
    await this.seal();
    try {
      if (this.recording && !this.recording.capture) await this.attempt.coordinator.retireRecording(this.recording);
    } catch (error) { this.failCleanup(error); }
  }

  async dispose(): Promise<void> {
    const results = await Promise.allSettled([
      this.startupCleanup,
      (async () => {
        await this.sealing;
        if (this.archive) { await this.archive.dispose(); this.archive = undefined; }
      })(),
      (async () => {
        await this.startupCleanup;
        await this.sealing;
        await this.chunkCleanup;
        await this.recording?.closedCleanup;
        if (this.chunk) {
          await runnerIntegration.discardTraceChunk(11, this.recording!.context.tracing, this.chunk);
          this.chunk = undefined;
          this.attempt.coordinator.finishChunk(this.recording!, this);
        }
        if (this.recording?.lastCapture === this) await this.recording.retirement;
      })(),
    ]);
    const rejected = results.find(result => result.status === 'rejected');
    if (rejected?.status === 'rejected') throw rejected.reason;
    if (this.cleanupFailure) throw this.cleanupFailure.error;
  }
}
