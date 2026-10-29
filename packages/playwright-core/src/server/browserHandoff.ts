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

// Flashwright: a warm test session (FLASHWRIGHT_SESSION, see the test runner's session.ts) keeps
// a test worker's browser running after the worker exits and hands it to a worker of the next
// run, renderer and compiled application code included. What moves between the processes is the
// browser's DevTools pipe, plus this description of it. The browser hands over one recycled
// context, already reset, with the tab that keeps its renderer alive; the worker that adopts it
// attaches to that context, resets it once more and gives its first test a new tab.

import type * as types from './types';
import type * as channels from './channels';

export type BrowserHandoffMetadata = {
  browserName: string;
  launchKey: string;
  pid: number;
  // Removed by whoever ends the browser.
  tempDirectories: string[];
  context: {
    id: string;
    // The recycled context's options, without its storage state.
    params: channels.BrowserNewContextForReuseParams;
    // Origins whose storage the next reset clears again.
    origins: string[];
  };
};

export type BrowserHandoff = {
  // The browser reads commands from `write` and answers on `read`.
  write: NodeJS.WritableStream;
  read: NodeJS.ReadableStream;
  metadata: BrowserHandoffMetadata;
};

// The test runner's worker leaves the browser it was offered here, before launching: one, or one
// per worker that its process runs.
const offerKey = Symbol.for('flashwright.browserOffer');

// What decides whether a running browser can stand in for a launch: everything that changes the
// browser process, but not where this worker writes its files or how it handles signals.
const kIgnoredLaunchOptions = new Set(['artifactsDir', 'tracesDir', 'downloadsPath', 'timeout', 'slowMo', 'handleSIGINT', 'handleSIGTERM', 'handleSIGHUP']);

export function browserLaunchKey(browserName: string, options: types.LaunchOptions): string {
  const entries = Object.entries(options).filter(([key, value]) => value !== undefined && !kIgnoredLaunchOptions.has(key) && !key.startsWith('__testHook'));
  entries.sort(([a], [b]) => a < b ? -1 : 1);
  return JSON.stringify([browserName, entries]);
}

// Called by BrowserType before it launches a browser.
export function takeBrowserOffer(browserName: string, options: types.LaunchOptions): BrowserHandoff | undefined {
  const offers = (globalThis as any)[offerKey] as BrowserHandoff | BrowserHandoff[] | undefined;
  const matches = (offer: BrowserHandoff) => offer.metadata.browserName === browserName && offer.metadata.launchKey === browserLaunchKey(browserName, options);
  if (Array.isArray(offers)) {
    const index = offers.findIndex(matches);
    return index === -1 ? undefined : offers.splice(index, 1)[0];
  }
  if (!offers || !matches(offers))
    return;
  delete (globalThis as any)[offerKey];
  return offers;
}
