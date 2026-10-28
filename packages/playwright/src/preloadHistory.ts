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

// Flashwright: the preloadPages option. When a test takes its recycled context, the worker tells
// the browser what the next test will probably open first, so that its tab loads it meanwhile (see
// the server's pagePreload.ts): the path that test's first goto went to last time, and how long the
// current test took, to time the preload. A test that called anything before its goto, or did not
// navigate, gets no preload. Without a previous run, the browser preloads the URL the current test
// goes to. The history is kept per config, in a file only this user can read; URLs with
// credentials are not remembered.

import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { monotonicTime } from '@isomorphic/time';

import type { Browser as BrowserImpl } from '../../playwright-core/src/client/browser';
import type { BrowserContext as BrowserContextImpl } from '../../playwright-core/src/client/browserContext';
import type { TestInfoImpl } from './worker/testInfo';

type Entry = { path?: string, first: boolean, duration: number };

const historyDir = path.join(os.tmpdir(), `flashwright-page-preloads-${os.userInfo().uid}`);
const maxEntries = 20000;

let history: { file: string, entries: Map<string, Entry>, updates: Map<string, Entry> } | undefined;

function loadHistory(configFile: string | undefined) {
  if (history)
    return history;
  const key = crypto.createHash('sha1').update(configFile ?? process.cwd()).digest('hex').slice(0, 16);
  const file = path.join(historyDir, `${key}.json`);
  history = { file, entries: readEntries(file), updates: new Map() };
  process.on('exit', saveHistory);
  return history;
}

function readEntries(file: string): Map<string, Entry> {
  try {
    return new Map(Object.entries(JSON.parse(fs.readFileSync(file, 'utf8'))));
  } catch {
    return new Map();
  }
}

// A preload runs beside the test before it, which only helps while CPU cores are idle: with one
// worker, or workers fewer than half the cores. Measured on 2 to 6 cores, more workers made runs
// slower.
export function canPreloadPages(testInfo: TestInfoImpl): boolean {
  const workers = testInfo.config.workers;
  return workers === 1 || workers * 2 < os.availableParallelism();
}

// Called when a test takes its recycled context. Returns when the test took it.
export function preloadNextPage(browser: BrowserImpl, testInfo: TestInfoImpl): number {
  const takenAt = monotonicTime();
  const nextTestId = testInfo._nextTestId;
  if (!nextTestId)
    return takenAt;
  const { entries } = loadHistory(testInfo.config.configFile);
  const next = entries.get(nextTestId);
  if (next && !next.first)
    return takenAt;
  const current = entries.get(testInfo.testId);
  browser._wrapApiCall(() => browser._preloadNextPage({ path: next?.path, expectedDuration: current?.duration }), { internal: true }).catch(() => {});
  return takenAt;
}

// Called once the test's recycled context has closed.
export function recordFirstNavigation(context: BrowserContextImpl, testInfo: TestInfoImpl, takenAt: number) {
  const { entries, updates } = loadHistory(testInfo.config.configFile);
  const firstNavigation = context._firstNavigation;
  let navigatedPath: string | undefined;
  try {
    const url = new URL(firstNavigation?.url ?? '');
    if ((url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password)
      navigatedPath = url.pathname + url.search + url.hash;
  } catch {
  }
  const entry = { path: navigatedPath, first: !!firstNavigation?.first && !!navigatedPath, duration: Math.round(monotonicTime() - takenAt) };
  entries.set(testInfo.testId, entry);
  updates.set(testInfo.testId, entry);
}

function saveHistory() {
  if (!history?.updates.size)
    return;
  try {
    fs.mkdirSync(historyDir, { recursive: true, mode: 0o700 });
    // Other workers of the run may have saved theirs meanwhile.
    const entries = readEntries(history.file);
    for (const [testId, entry] of history.updates) {
      // Most recent last, so the oldest entries are the ones dropped.
      entries.delete(testId);
      entries.set(testId, entry);
    }
    const temporary = `${history.file}.${process.pid}`;
    fs.writeFileSync(temporary, JSON.stringify(Object.fromEntries([...entries].slice(-maxEntries))), { mode: 0o600 });
    fs.renameSync(temporary, history.file);
    history.updates.clear();
  } catch {
  }
}
