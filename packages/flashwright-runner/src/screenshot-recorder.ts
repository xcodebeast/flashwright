import { mkdir, mkdtemp, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { failure, type BrowserContext, type Page } from '@flashwright/core';
import { runnerIntegration } from '@flashwright/core/runner-integration';
import type { TestInfo } from 'flashwright-upstream-runner/test';
import type { ScreenshotPolicy } from './screenshot-policy.js';
import { ArtifactErrors } from './artifact-errors.js';

interface PinnedTestInfo extends TestInfo {
  _onDidFinishTestFunctionCallbacks: Set<() => Promise<void>>;
}

/** One observer per worker; test/hook recorders own outcome and artifact retention. */
export class ScreenshotLifecycle {
  private readonly contexts = new Set<BrowserContext>();
  private readonly capturedPages = new WeakMap<TestInfo, WeakSet<Page>>();
  private recorder: ScreenshotRecorder | undefined;
  private readonly uninstall: () => void;

  constructor(private readonly policy: ScreenshotPolicy) {
    this.uninstall = runnerIntegration.installContextLifecycle(1, {
      didCreateContext: context => {
        this.contexts.add(context);
        context.once('close', () => this.contexts.delete(context));
      },
      willCloseContext: async context => { await this.recorder?.beforeContextClose(context); },
    });
  }

  start(testInfo: TestInfo): ScreenshotRecorder {
    if (this.recorder) throw failure('ProtocolError', 'runner.screenshot', 'a screenshot recording scope is already active');
    let capturedPages = this.capturedPages.get(testInfo);
    if (!capturedPages) { capturedPages = new WeakSet(); this.capturedPages.set(testInfo, capturedPages); }
    this.recorder = new ScreenshotRecorder(this.policy, testInfo as PinnedTestInfo, this.contexts, capturedPages);
    return this.recorder;
  }

  async finish(recorder: ScreenshotRecorder): Promise<void> {
    if (this.recorder !== recorder) throw failure('ProtocolError', 'runner.screenshot', 'screenshot recording ownership changed before teardown');
    this.recorder = undefined;
    await recorder.finish();
  }

  dispose(): void { this.uninstall(); this.contexts.clear(); }
}

class ScreenshotRecorder {
  private readonly temporaryPaths: string[] = [];
  private readonly pendingBatches = new Set<Promise<void>>();
  private temporaryDirectory: Promise<string> | undefined;
  private ordinal: number;
  private captureCount = 0;
  private capturedBytes = 0;
  private captureTail: Promise<void> = Promise.resolve();
  private readonly errors = new ArtifactErrors('screenshot-error', true);
  private finished = false;
  private readonly afterTestFunction = async () => { await this.captureAtFinish(); };

  constructor(
    private readonly policy: ScreenshotPolicy,
    private readonly testInfo: PinnedTestInfo,
    private readonly contexts: ReadonlySet<BrowserContext>,
    private readonly capturedPages: WeakSet<Page>,
  ) {
    if (!(testInfo._onDidFinishTestFunctionCallbacks instanceof Set)) {
      throw failure('ProtocolError', 'runner.screenshot', 'pinned runner test-finish callback boundary is unavailable');
    }
    this.ordinal = testInfo.attachments.filter(attachment => attachment.name === 'screenshot').length;
    testInfo._onDidFinishTestFunctionCallbacks.add(this.afterTestFunction);
  }

  private isFailure(): boolean {
    return this.testInfo.status !== 'skipped' && this.testInfo.status !== this.testInfo.expectedStatus;
  }

  private shouldRetain(): boolean {
    return this.policy.mode === 'on' || this.isFailure() && (
      this.policy.mode === 'only-on-failure' || this.policy.mode === 'on-first-failure' && this.testInfo.retry === 0
    );
  }

  private shouldCaptureBeforeClose(): boolean {
    return this.policy.mode === 'on' || this.policy.mode === 'only-on-failure' ||
      this.policy.mode === 'on-first-failure' && this.testInfo.retry === 0;
  }

  async beforeContextClose(context: BrowserContext): Promise<void> {
    if (this.finished || !this.shouldCaptureBeforeClose()) return;
    const batch = this.capturePages(context.pages(), true);
    this.pendingBatches.add(batch);
    try { await batch; } finally { this.pendingBatches.delete(batch); }
  }

  private async captureAtFinish(): Promise<void> {
    if (!this.finished && this.shouldRetain()) await this.capturePages([...this.contexts].flatMap(context => context.pages()), false);
  }

  private capturePages(pages: Page[], temporary: boolean): Promise<void> {
    const deadline = performance.now() + 5000;
    const batch = this.captureTail.then(() => this.captureBatch(pages, temporary, deadline));
    this.captureTail = batch.catch(() => {});
    return batch;
  }

  private async captureBatch(pages: Page[], temporary: boolean, deadline: number): Promise<void> {
    // Bound concurrent preparation and encoded image buffers while retaining every requested page.
    let nextPage = 0;
    await Promise.all(Array.from({ length: Math.min(4, pages.length) }, async () => {
      while (nextPage < pages.length) {
        const page = pages[nextPage++];
        if (!page) continue;
        if (this.capturedPages.has(page)) continue;
        this.capturedPages.add(page);
        await this.capturePage(page, temporary, deadline);
      }
    }));
  }

  private async directory(): Promise<string> {
    this.temporaryDirectory ??= (async () => {
      await mkdir(this.testInfo.project.outputDir, { recursive: true });
      return mkdtemp(join(this.testInfo.project.outputDir, '.flashwright-screenshots-'));
    })();
    return this.temporaryDirectory;
  }

  private attachmentPath(): string {
    return this.testInfo.outputPath(`test-${this.isFailure() ? 'failed' : 'finished'}-${++this.ordinal}.png`);
  }

  private attach(path: string): void {
    this.testInfo.attachments.push({ name: 'screenshot', path, contentType: 'image/png' });
  }

  private captureError(error: unknown): void {
    this.errors.record(error);
  }

  private async capturePage(page: Page, temporary: boolean, deadline: number): Promise<void> {
    let path: string | undefined;
    try {
      if (++this.captureCount > 1024) throw failure('ResourceLimitError', 'runner.screenshot', 'screenshot scope exceeds 1024 captures');
      if (this.capturedBytes >= 512 * 1024 * 1024) throw failure('ResourceLimitError', 'runner.screenshot', 'screenshot scope exceeds 512 MiB');
      path = temporary ? join(await this.directory(), `${randomUUID()}.png`) : this.attachmentPath();
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw failure('TimeoutError', 'runner.screenshot', 'five-second screenshot batch deadline exceeded');
      const capturePath = path;
      await runnerIntegration.runInternal(1, () => page.screenshot({ ...this.policy.options, timeout: remaining, path: capturePath, caret: 'initial' }));
      this.capturedBytes += (await stat(path)).size;
      if (this.capturedBytes > 512 * 1024 * 1024) throw failure('ResourceLimitError', 'runner.screenshot', 'screenshot scope exceeds 512 MiB');
      if (temporary) this.temporaryPaths.push(path);
      else this.attach(path);
    } catch (error) {
      if (path) await rm(path, { force: true }).catch(() => {});
      this.captureError(error);
    }
  }

  async finish(): Promise<void> {
    if (this.finished) return;
    this.testInfo._onDidFinishTestFunctionCallbacks.delete(this.afterTestFunction);
    try {
      await this.captureAtFinish();
      this.finished = true;
      await Promise.all([...this.pendingBatches]);
      if (this.shouldRetain()) {
        for (const temporaryPath of this.temporaryPaths) {
          try {
            const path = this.attachmentPath();
            await mkdir(this.testInfo.outputDir, { recursive: true });
            await rename(temporaryPath, path);
            this.attach(path);
          } catch (error) { this.captureError(error); }
        }
      }
    } finally {
      this.finished = true;
      if (this.temporaryDirectory) {
        try { await rm(await this.temporaryDirectory, { recursive: true, force: true }); }
        catch (error) { this.captureError(error); }
      }
      this.errors.publish(this.testInfo);
    }
  }
}
