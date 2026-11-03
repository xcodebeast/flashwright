/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import fs from 'fs';
import path from 'path';

import type { Page } from 'playwright-core';
import type { BrowserContext as BrowserContextImpl } from '../../playwright-core/src/client/browserContext';
import type { Page as PageImpl } from '../../playwright-core/src/client/page';
import type { TestInfoImpl, TestStepInternal } from './worker/testInfo';

// Flashwright: what a test does, as `playwright test --video` needs it to make a video afterwards:
// the frames of its pages, the steps it took and what it said. The runner's narratedVideo.ts reads
// this. A problem here never fails the test; at worst the video is missing or shorter.

export type RecordedPoint = { x: number, y: number };
export type RecordedBox = RecordedPoint & { width: number, height: number };

export type RecordedStep = {
  // Steps and narrations in the order they happened: several can share a millisecond.
  order: number;
  title: string;
  subtitle?: string;
  category: string;
  start: number;
  end?: number;
  failed?: boolean;
  method?: string;
  params?: { selector?: string, value?: string, key?: string, text?: string, url?: string };
};

export type Recording = {
  title: string;
  titlePath: string[];
  projectName: string;
  status: string;
  expectedStatus: string;
  error?: string;
  duration: number;
  outputDir: string;
  frames: { file: string, time: number, page: number, width: number, height: number }[];
  inputs: { time: number, page: number, point?: RecordedPoint, box?: RecordedBox }[];
  // `file` is the picture of the page that the voice speaks over.
  narrations: { order: number, text: string, time: number, page?: number, file?: string }[];
  steps: RecordedStep[];
};

const kMaxFrameSize = { width: 3840, height: 2160 };
const kSnapshotTimeout = 2000;

export class NarratedVideoRecorder {
  private _testInfo: TestInfoImpl;
  private _dir: string;
  private _pages = new Map<PageImpl, number>();
  private _pageCount = 0;
  private _contexts = new Set<BrowserContextImpl>();
  private _frames: Recording['frames'] = [];
  private _inputs: Recording['inputs'] = [];
  private _narrations: Recording['narrations'] = [];
  private _steps = new Map<TestStepInternal, RecordedStep>();
  private _started: Promise<unknown>[] = [];
  private _order = 0;
  private _finishedPages = new Set<number>();
  private _lastPaintedPage: PageImpl | undefined;

  constructor(testInfo: TestInfoImpl) {
    this._testInfo = testInfo;
    // Outside the test's folder, which preserveOutput may delete before the video is made.
    this._dir = path.join(testInfo.project.outputDir, '.video-recordings', `${testInfo.testId}-${testInfo.retry}`);
    fs.mkdirSync(this._dir, { recursive: true });
  }

  didCreateBrowserContext(context: BrowserContextImpl) {
    if (this._contexts.has(context))
      return;
    this._contexts.add(context);
    context.pages().forEach(page => this._watchPage(page));
    context.on('page', page => this._watchPage(page as PageImpl));
  }

  async willCloseBrowserContext(context: BrowserContextImpl) {
    const pages = context.pages() as PageImpl[];
    await this._takeLastFrame(pages);
    await Promise.all(pages.map(page => this._stopPage(page)));
  }

  // The video holds this picture of the page while the voice speaks. A screencast frame could not
  // promise it: the frame that shows the page as it is now may arrive after the test has moved on.
  async narrate(text: string, page?: Page) {
    const narration: Recording['narrations'][0] = { order: this._order++, text, time: Date.now() };
    this._narrations.push(narration);
    const target = (page as PageImpl | undefined) ?? this._currentPage();
    if (target) {
      narration.page = this._pages.get(target);
      narration.file = await this._snapshot(target);
    }
  }

  private async _snapshot(page: PageImpl): Promise<string | undefined> {
    const index = this._pages.get(page);
    if (index === undefined || page.isClosed())
      return;
    try {
      const data = await page._wrapApiCall(() => page.screenshot({ type: 'jpeg', quality: 90, caret: 'initial', timeout: kSnapshotTimeout }), { internal: true });
      const { width, height } = page.viewportSize() ?? this._frames[this._frames.length - 1] ?? { width: 0, height: 0 };
      if (!width || !height)
        return;
      return this._addFrame(data, index, width, height);
    } catch {
      // A page that cannot take a picture, behind a dialog for one, still has its frames.
    }
  }

  private _addFrame(data: Buffer, page: number, width: number, height: number) {
    const file = `page${page}-${String(this._frames.length).padStart(6, '0')}.jpg`;
    fs.writeFileSync(path.join(this._dir, file), data);
    // When it arrived: the browser's timestamp is when it expects to present the frame, on another
    // clock, and cannot be compared with the test's steps.
    this._frames.push({ file, time: Date.now(), page, width, height });
    return file;
  }

  onStepBegin(step: TestStepInternal) {
    if (step.category === 'pw:api' || step.category === 'expect' || step.category === 'test.step')
      this._steps.set(step, { order: this._order++, title: step.title, subtitle: step.subtitle, category: step.category, start: Date.now() });
  }

  onStepEnd(step: TestStepInternal) {
    const recorded = this._steps.get(step);
    if (recorded) {
      recorded.end = step.endWallTime;
      recorded.failed = !!step.error;
    }
  }

  onApiCall(step: TestStepInternal, channel: { type: string, method: string, params: any }) {
    const recorded = this._steps.get(step);
    if (!recorded)
      return;
    const { selector, value, key, text, url } = channel.params ?? {};
    recorded.method = channel.method;
    recorded.params = { selector, value, key, text, url };
  }

  async didFinishTest() {
    await Promise.all(this._started).catch(() => {});
    await this._takeLastFrame([...this._pages.keys()]);
    await Promise.all([...this._pages.keys()].map(page => this._stopPage(page)));
    const testInfo = this._testInfo;
    testInfo._narratedVideo = undefined;
    if (!this._frames.length) {
      // A test without a page has nothing to show.
      fs.rmSync(this._dir, { recursive: true, force: true });
      return;
    }
    const recording: Recording = {
      title: testInfo.title,
      titlePath: testInfo.titlePath,
      projectName: testInfo.project.name,
      status: testInfo.status ?? 'failed',
      expectedStatus: testInfo.expectedStatus,
      error: testInfo.errors[0]?.message ?? testInfo.errors[0]?.value,
      duration: testInfo.duration,
      outputDir: testInfo.outputDir,
      frames: this._frames,
      inputs: this._inputs,
      narrations: this._narrations,
      steps: [...this._steps.values()],
    };
    fs.writeFileSync(path.join(this._dir, 'recording.json'), JSON.stringify(recording));
    testInfo._narratedVideoRecording = this._dir;
  }

  // What the test's last action did on the page in view is painted after the test has moved on.
  // Frames that arrive after this picture can only show the page from before it.
  private async _takeLastFrame(pages: PageImpl[]) {
    const current = this._currentPage();
    if (current && pages.includes(current) && !this._finishedPages.has(this._pages.get(current)!))
      await this._snapshot(current);
    for (const page of pages) {
      const index = this._pages.get(page);
      if (index !== undefined)
        this._finishedPages.add(index);
    }
  }

  // The first frame of a page can arrive after the test has gone on to narrate.
  private _currentPage() {
    if (this._lastPaintedPage && !this._lastPaintedPage.isClosed())
      return this._lastPaintedPage;
    return [...this._pages.keys()].pop();
  }

  private _watchPage(page: PageImpl) {
    if (this._pages.has(page))
      return;
    const index = this._pageCount++;
    this._pages.set(page, index);
    page.once('close', () => this._pages.delete(page));
    const start = page._wrapApiCall(() => page.screencast.start({
      size: kMaxFrameSize,
      quality: 90,
      onFrame: ({ data, viewportWidth, viewportHeight }: { data: Buffer, viewportWidth: number, viewportHeight: number }) => {
        if (this._finishedPages.has(index))
          return;
        this._addFrame(data, index, viewportWidth, viewportHeight);
        this._lastPaintedPage = page;
      },
      _onInputAction: (action: { timestamp: number, point?: RecordedPoint, box?: RecordedBox }) => {
        this._inputs.push({ time: action.timestamp, page: index, point: action.point, box: action.box });
      },
    } as any), { internal: true }).catch(() => {});
    this._started.push(start);
  }

  private async _stopPage(page: Page) {
    const impl = page as PageImpl;
    if (!this._pages.has(impl) || impl.isClosed())
      return;
    await impl._wrapApiCall(() => impl.screencast.stop(), { internal: true }).catch(() => {});
  }
}
