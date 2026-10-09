import { performance } from 'node:perf_hooks';
import { failure } from '@flashwright/core';
import type { TestInfo } from 'flashwright-upstream-runner/test';
import type { RunnerJournalAdmission } from './runner-trace-journal.js';
import { ArtifactErrors } from './artifact-errors.js';

type Journal = NonNullable<RunnerJournalAdmission['journal']>;
type Archive = Awaited<ReturnType<Journal['takeArchive']>>;
const journalAppenders = ['appendForError', 'appendStdioToTrace', 'appendBeforeActionForStep', 'appendAfterActionForStep', '_appendTraceEvent'] as const;
const discard = (): void => {};
interface TimeoutSlot { timeout: number; elapsed: number }
interface PinnedTestInfo extends TestInfo {
  _timeoutManager: {
    _running?: { slot: TimeoutSlot; runnable: { type: string; slot?: TimeoutSlot; fixture?: unknown } };
    defaultSlot(): TimeoutSlot;
    setTimeout(timeout: number): void;
  };
  _tracing: { stopIfNeeded(): Promise<void>; _shouldAbandonTrace(): boolean } & Partial<Record<typeof journalAppenders[number], (...arguments_: unknown[]) => void>>;
}

const finalizers = new WeakMap<object, RunnerTraceFinalizer>();

/** Install once on the original instance, whose final stop follows every test and failure hook. */
export function installRunnerTraceFinalizer(testInfo: TestInfo, admission: RunnerJournalAdmission): RunnerTraceFinalizer {
  const information = testInfo as PinnedTestInfo;
  const existing = finalizers.get(information._tracing);
  if (existing) {
    if (existing.admission !== admission) throw failure('ProtocolError', 'runner.tracing', 'runner journal ownership changed before final stop');
    return existing;
  }
  const finalizer = new RunnerTraceFinalizer(information, admission);
  information._tracing.stopIfNeeded = () => finalizer.finish();
  finalizers.set(information._tracing, finalizer);
  return finalizer;
}

/** Final export owns its deadline and late cleanup without changing the originating test outcome. */
export class RunnerTraceFinalizer {
  readonly cleanup: Promise<void>;
  private resolveCleanup!: () => void;
  private completion: Promise<void> | undefined;
  private readonly errors = new ArtifactErrors('trace-error');

  constructor(private readonly testInfo: PinnedTestInfo, readonly admission: RunnerJournalAdmission) {
    this.cleanup = new Promise(resolve => { this.resolveCleanup = resolve; });
  }

  finish(): Promise<void> {
    this.completion ??= this.finishOwned();
    return this.completion;
  }

  /** The pinned worker creates a separate final slot; the main test timeout must remain untouched. */
  private ownFinalTimeout(): void {
    const manager = this.testInfo._timeoutManager;
    const running = manager?._running;
    if (!running || running.runnable.type !== 'test' || running.runnable.fixture !== undefined ||
        running.runnable.slot !== running.slot || running.slot === manager.defaultSlot()) {
      throw failure('ProtocolError', 'runner.tracing', 'final runner trace stop is outside its separate timeout slot');
    }
    manager.setTimeout(0);
  }

  private async finishOwned(): Promise<void> {
    const journal = this.admission.journal;
    const cancellation = new AbortController();
    let archive: Archive | undefined;
    let work: Promise<void> = Promise.resolve();
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Final artifacts still create public attachment steps. They must not append
    // to their own sealed journal or turn its successful capture into a failure.
    for (const name of journalAppenders) this.testInfo._tracing[name] = discard;
    try {
      this.ownFinalTimeout();
      if (!this.testInfo._tracing._shouldAbandonTrace()) {
        if (this.admission.failure !== undefined) throw this.admission.failure;
        if (!journal) throw failure('ProtocolError', 'runner.tracing', 'runner trace admission has no journal');
        const timeout = this.testInfo.timeout;
        const destination = this.testInfo.outputPath('trace.zip');
        const deadline = performance.now() + 30000;
        const deadlineError = () => failure('TimeoutError', 'runner.tracing', 'runner trace preparation exceeded 30 seconds before atomic commit');
        const checkPreparation = () => {
          cancellation.signal.throwIfAborted();
          if (performance.now() >= deadline) throw deadlineError();
        };
        const expired = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            const error = deadlineError();
            cancellation.abort(error);
            reject(error);
          }, 30000);
        });
        work = (async () => {
          archive = await journal.takeArchive(timeout, cancellation.signal);
          checkPreparation();
          await archive.export(destination, cancellation.signal, () => {
            checkPreparation();
            // Once rename starts, cancellation cannot promise an unchanged destination.
            clearTimeout(timer);
          });
          this.testInfo.attachments.push({ name: 'trace', path: destination, contentType: 'application/zip' });
        })();
        await Promise.race([work, expired]);
      }
    } catch (error) {
      cancellation.abort(error);
      this.errors.record(error);
    } finally {
      clearTimeout(timer);
      // Dispose immediately cancels pending initialization and writes. A late archive belongs
      // to this finalizer until the original export settles, including a dispatched rename.
      const journalCleanup = journal?.dispose() ?? Promise.resolve();
      const archiveCleanup = work.then(() => archive?.dispose(), () => archive?.dispose());
      void Promise.allSettled([journalCleanup, archiveCleanup]).then(results => {
        for (const result of results) if (result.status === 'rejected') this.errors.record(result.reason);
        this.resolveCleanup();
      });
      let grace: ReturnType<typeof setTimeout> | undefined;
      const settled = await Promise.race([
        this.cleanup.then(() => true),
        new Promise<false>(resolve => { grace = setTimeout(() => resolve(false), 2000); }),
      ]);
      clearTimeout(grace);
      if (!settled) this.errors.record(failure('TimeoutError', 'runner.tracing', 'trace cleanup remains pending after its two-second foreground grace; the original attempt retains custody'));
      this.errors.publish(this.testInfo);
    }
  }
}
