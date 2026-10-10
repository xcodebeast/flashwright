import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { BrowserContext, Page } from '@flashwright/core';
import type { TestInfo } from 'flashwright-upstream-runner/test';
import { ArtifactErrors } from './artifact-errors.js';
import { buildFailureContext, maximumFailureContextDiagnosticCharacters } from './failure-context-format.js';

const maximumCaptureMilliseconds = 5000;
const maximumPendingCloses = 128;
const snapshotTruncationNotice = '\n[Diagnostic truncated: character limit reached.]';

interface FailureContextCapture {
  /** The callback must settle, including cancellation cleanup, within the supplied remaining budget. */
  capture(page: Page, timeoutMilliseconds: number): Promise<string>;
  now?: () => number;
}

interface AttemptOwnership {
  recorder: FailureContextRecorder | undefined;
  completion?: Promise<void>;
}

/** Assign context creation and closure to their original attempts without installing another observer. */
export class FailureContextScopes {
  private readonly attempts = new WeakMap<TestInfo, AttemptOwnership>();
  private readonly contexts = new WeakMap<BrowserContext, AttemptOwnership>();
  private current: AttemptOwnership | undefined;

  constructor(private readonly capture: FailureContextCapture) {}

  start(testInfo: TestInfo, existingContexts: Iterable<BrowserContext>): void {
    if (this.attempts.has(testInfo)) return;
    const ownership: AttemptOwnership = { recorder: new FailureContextRecorder(testInfo, this.capture) };
    this.attempts.set(testInfo, ownership);
    this.current = ownership;
    for (const context of existingContexts) this.contexts.set(context, ownership);
  }

  /** Capture ownership before asynchronous context preparation; explicit later adoption takes precedence. */
  claim(): { didCreateContext(context: BrowserContext): void } | undefined {
    const ownership = this.current;
    if (!ownership?.recorder) return undefined;
    return {
      didCreateContext: context => {
        if (!ownership.recorder) return;
        const existingOwner = this.contexts.get(context);
        if (!existingOwner?.recorder) this.contexts.set(context, ownership);
      },
    };
  }

  beforeContextClose(context: BrowserContext): Promise<void> {
    const ownership = this.contexts.get(context);
    this.contexts.delete(context);
    return ownership?.recorder?.beforeContextClose(context) ?? Promise.resolve();
  }

  /** Seal synchronously, then settle original capture and publish once. Only the first owned leftover is eligible. */
  finish(testInfo: TestInfo, existingContexts: Iterable<BrowserContext>): Promise<void> {
    const ownership = this.attempts.get(testInfo);
    const recorder = ownership?.recorder;
    if (!ownership || !recorder) return ownership?.completion ?? Promise.resolve();
    let leftover: BrowserContext | undefined;
    for (const context of existingContexts) {
      if (this.contexts.get(context) === ownership) { leftover = context; break; }
    }
    // Clearing one token releases every weak context owner, including contexts published by an old claim.
    ownership.recorder = undefined;
    if (this.current === ownership) this.current = undefined;
    const completion = recorder.finish(leftover);
    ownership.completion = completion;
    return completion;
  }
}

/** Optional fallback work shares one monotonic deadline and never changes the originating test failure. */
class FailureContextRecorder {
  private readonly now: () => number;
  private captureTail: Promise<void> = Promise.resolve();
  private deadline: number | undefined;
  private pageSnapshot: string | undefined;
  private pendingCloses = 0;
  private omittedCloses = false;
  private exhaustedBudget = false;
  private sealed = false;
  private readonly errors = new ArtifactErrors('error-context-error');

  constructor(private readonly testInfo: TestInfo, private readonly capture: FailureContextCapture) {
    this.now = capture.now ?? (() => performance.now());
  }

  beforeContextClose(context: BrowserContext): Promise<void> {
    if (this.sealed || !this.needsSnapshot()) return Promise.resolve();
    if (this.pendingCloses === maximumPendingCloses) {
      if (!this.omittedCloses) {
        this.errors.record(`Failure context fallback omitted for additional context closures: ${maximumPendingCloses} pending captures allowed per attempt.`);
      }
      this.omittedCloses = true;
      return Promise.resolve();
    }
    ++this.pendingCloses;
    const pending = this.captureTail.then(() => this.takeSnapshot(context)).catch(error => this.errors.record(error));
    this.captureTail = pending;
    return pending.finally(() => { --this.pendingCloses; });
  }

  private needsSnapshot(): boolean {
    try {
      return !process.env.PLAYWRIGHT_NO_COPY_PROMPT && this.testInfo.errors.length > 0 &&
        !this.testInfo.errors.some(error => error.errorContext) && !this.pageSnapshot;
    } catch (error) {
      this.errors.record(error);
      return false;
    }
  }

  private async takeSnapshot(context: BrowserContext): Promise<void> {
    if (!this.needsSnapshot()) return;
    const page = context.pages()[0];
    if (!page) return;
    this.deadline ??= this.now() + maximumCaptureMilliseconds;
    const remaining = this.deadline - this.now();
    if (remaining <= 0) {
      if (!this.exhaustedBudget) this.errors.record('Failure context fallback omitted: five-second attempt capture deadline exhausted.');
      this.exhaustedBudget = true;
      return;
    }
    // Await the original operation instead of racing it with an orphaning host timeout.
    const snapshot = await this.capture.capture(page, remaining);
    if (snapshot.length <= maximumFailureContextDiagnosticCharacters) this.pageSnapshot = snapshot;
    else this.pageSnapshot = snapshot.slice(0, maximumFailureContextDiagnosticCharacters) + snapshotTruncationNotice;
  }

  async finish(leftover: BrowserContext | undefined): Promise<void> {
    this.sealed = true;
    try {
      await this.captureTail;
      if (leftover) await this.takeSnapshot(leftover).catch(error => this.errors.record(error));
      if (!this.testInfo.errors.length) return;
      const markdown = await buildFailureContext({
        titlePath: this.testInfo.titlePath,
        location: { file: this.testInfo.file, line: this.testInfo.line, column: this.testInfo.column },
        errors: this.testInfo.errors,
        pageSnapshot: this.testInfo.errors.some(error => error.errorContext) ? undefined : this.pageSnapshot,
      });
      if (markdown) await this.publish(markdown);
    } catch (error) {
      // Capture, source formatting and local publication are optional diagnostics.
      this.errors.record(error);
    } finally {
      this.pageSnapshot = undefined;
      try { this.errors.publish(this.testInfo); } catch {}
    }
  }

  private async publish(markdown: string): Promise<void> {
    const destination = this.testInfo.outputPath('error-context.md');
    const temporary = join(dirname(destination), `.flashwright-error-context-${randomUUID()}.tmp`);
    try {
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(temporary, markdown, { encoding: 'utf8', flag: 'wx' });
      await rename(temporary, destination);
      this.testInfo.attachments.push({ name: 'error-context', contentType: 'text/markdown', path: destination });
    } finally {
      await rm(temporary, { force: true }).catch(error => this.errors.record(error));
    }
  }
}
