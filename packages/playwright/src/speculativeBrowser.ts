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

// Flashwright: a worker started ahead of time launches the browser most projects use while it
// waits to be configured. The `browser` fixture adopts it only when the project asks for exactly
// that browser; anything else closes it and launches as usual.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { isDeepStrictEqual } from 'util';

import type { Browser, LaunchOptions } from 'playwright-core';
import type * as globals from './globals';

// The options the browser fixture uses for a default project whose contexts are recycled.
const speculativeOptions = { handleSIGINT: false, headless: true, ...(process.env.FLASHWRIGHT_ISOLATION === 'strict' ? {} : { recycleContexts: true }) };
// The fixtures and the worker entry are bundled separately; share the launch through a global.
const speculativeKey = Symbol.for('flashwright.speculativeBrowser');
const laneBrowsersKey = Symbol.for('flashwright.laneSpeculativeBrowsers');
// The worker entry bundles this file with a copy of its imports: lanes come from the one module.
const lanes = () => (globalThis as any)[Symbol.for('flashwright.lanes')] as typeof globals;

export function launchSpeculativeBrowser(): Promise<Browser | undefined> {
  // With workersPerProcess, each of the process's first lanes gets one, launched in that lane so
  // that what its browser sends reaches the lane's test.
  const laneCount = Math.max(1, Math.floor(Number(process.env.FLASHWRIGHT_SPECULATIVE_LANES) || 1));
  // In a warm session, browsers of the previous run may be on their way; launching takes them over.
  const offered = process.env.FLASHWRIGHT_SESSION_OFFER ? receiveSessionBrowsers(laneCount) : Promise.resolve();
  const launchOne = (): Promise<Browser | undefined> => require('playwright-core').chromium.launch(speculativeOptions).catch(() => undefined);
  const launchIn = (lane: number) => laneCount === 1 ? launchOne() : lanes().runInLane(lanes().laneById(lane), launchOne);
  const launch = offered.then(() => launchIn(0)).catch(() => undefined);
  (globalThis as any)[speculativeKey] = launch;
  const laneBrowsers = Array.from({ length: laneCount }, (_, lane) => lane ? offered.then(() => launchIn(lane)).catch(() => undefined) : undefined);
  (globalThis as any)[laneBrowsersKey] = laneBrowsers;
  (globalThis as any)[Symbol.for('flashwright.keepLaneBrowsers')] = (count: number) => {
    for (let lane = count; lane < laneBrowsers.length; lane++) {
      void laneBrowsers[lane]?.then(browser => browser?.close()).catch(() => {});
      laneBrowsers[lane] = undefined;
    }
  };
  return launch;
}

// Flashwright: a warm session (see the runner's session.ts) moves browsers between the workers of
// consecutive runs. Each one travels as two messages, one per pipe, with what playwright-core
// needs to take it over (see its browserHandoff.ts).
const kBrowserMessage = '__flashwright_browser__';
// Where playwright-core's BrowserType looks for a browser to take over instead of launching one.
const offerKey = Symbol.for('flashwright.browserOffer');
// When the browser this worker was offered last ran tests: the session hands out the browsers that
// ran tests most recently first, since their renderers have the application compiled.
let offeredLastUsed = 0;

// The session answers before the run starts. Should the answer not come, the first test does not
// wait for it for long, and a browser that arrives after that goes back.
const kOfferTimeoutAfterInit = 500;

// A process that runs several workers (see workersPerProcess) asks for a browser for each, and
// leaves them all for playwright-core's BrowserType to take.
function receiveSessionBrowsers(count: number): Promise<void> {
  const offers: any[] = [];
  if (count > 1)
    (globalThis as any)[offerKey] = offers;
  return new Promise(resolve => {
    let answered = false;
    let answers = 0;
    let timer: NodeJS.Timeout | undefined;
    const answer = () => {
      answered = true;
      clearTimeout(timer);
      resolve();
    };
    const partsById = new Map<string, any>();
    const onMessage = (message: any, handle: any) => {
      if (message?.method === '__init__' && !answered)
        timer = setTimeout(answer, kOfferTimeoutAfterInit);
      if (message?.method !== kBrowserMessage || message.params.sent)
        return;
      if (!message.params.none) {
        const parts = partsById.get(message.params.id) ?? {};
        partsById.set(message.params.id, parts);
        parts[message.params.part] = handle;
        parts.metadata ??= message.params.metadata;
        if (!parts.write || !parts.read || !parts.metadata)
          return;
        partsById.delete(message.params.id);
        if (answered) {
          void sendToRunner(parts);
        } else {
          if (count > 1)
            offers.push(parts);
          else
            (globalThis as any)[offerKey] = parts;
          offeredLastUsed = Math.max(offeredLastUsed, parts.metadata.lastUsed ?? 0);
          // A browser that nothing took over goes with this process.
          process.once('exit', () => {
            if ((globalThis as any)[offerKey] === parts || offers.includes(parts))
              killHandedOverBrowser(parts.metadata);
          });
        }
      }
      if (++answers < count)
        return;
      process.off('message', onMessage);
      answer();
    };
    process.on('message', onMessage);
  });
}

// Called by the `browser` fixture instead of closing the browser. In a warm session, it goes to the
// runner, which passes it on to the session, along with a browser that was offered to this worker
// but not taken.
export async function handBrowsersToSession(browser: Browser | undefined, ranTests: boolean): Promise<boolean> {
  if (!process.env.FLASHWRIGHT_SESSION_HANDOFF || !process.send)
    return false;
  const offer = (globalThis as any)[offerKey];
  if (Array.isArray(offer)) {
    for (const parts of offer.splice(0))
      await sendToRunner(parts);
  } else if (offer) {
    delete (globalThis as any)[offerKey];
    await sendToRunner(offer);
  }
  if (!browser)
    return false;
  const serverBrowser = (browser as any)._connection.toImpl?.(browser);
  const handoff = await serverBrowser?.handoffForSession?.().catch(() => undefined);
  if (!handoff)
    return false;
  handoff.metadata.lastUsed = ranTests ? Date.now() : offeredLastUsed;
  await sendToRunner(handoff);
  return true;
}

async function sendToRunner(browser: { write: any, read: any, metadata: { pid: number, tempDirectories: string[] } }) {
  const id = `${process.pid}-${browser.metadata.pid}`;
  const send = (params: object, handle: any) => new Promise<boolean>(resolve => {
    if (!process.connected)
      return resolve(false);
    process.send!({ method: kBrowserMessage, params }, handle, undefined, error => resolve(!error));
  });
  if (await send({ id, part: 'write', metadata: browser.metadata }, browser.write) && await send({ id, part: 'read' }, browser.read)) {
    // Node holds back what is sent after a handle until the runner confirms it, and drops it if
    // the worker exits first, such as an interrupted test's result: this goes out once it did.
    await send({ id, sent: true }, undefined);
    return;
  }
  browser.write.destroy();
  browser.read.destroy();
  killHandedOverBrowser(browser.metadata);
}

function killHandedOverBrowser(metadata: { pid: number, tempDirectories: string[] }) {
  try {
    process.kill(-metadata.pid, 'SIGKILL');
  } catch {
  }
  for (const directory of metadata.tempDirectories) {
    try {
      fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5 });
    } catch {
    }
  }
}

// Called while the worker is still idle: the `browser` fixture that adopts the browser waits for
// the context to be ready, so that its first test finds it.
export function prepareSpeculativeContext() {
  const launch = (globalThis as any)[speculativeKey] as Promise<Browser | undefined> | undefined;
  const hint = speculativeOptions.recycleContexts ? readContextHint() : undefined;
  if (!launch || !hint)
    return;
  (globalThis as any)[speculativeKey] = launch.then(async browser => {
    const serverBrowser = browser && (browser as any)._connection.toImpl?.(browser);
    await serverBrowser?.prepareRecycledContext(hint.params, { storageState: hint.storageState }).catch(() => {});
    return browser;
  });
}

// The recycled context the tests of a config asked for last time, so that a browser started ahead
// of time has it ready with a tab open (see the server's Browser.prepareRecycledContext). Hints are kept per
// config, under the key the CLI computes for its worker hints, in one small file that only this
// user can read. The storage state is left out (the test's own is applied when it takes the
// context), and contexts with other options that can hold secrets (credentials, headers, a proxy,
// client certificates) are not remembered.
const contextHintFile = path.join(os.tmpdir(), 'flashwright-context-hints.json');
const maxContextHints = 200;
let rememberedContextHint = false;
// The hint this worker read while it waited, which its first test usually just confirms.
let hintReadAhead: { key: string, hint: ContextHints[string] | undefined } | undefined;

// `storageState` tells whether the tests used one, not what it was.
type ContextHints = Record<string, { params: any, storageState?: boolean, usedAt: number }>;

function readContextHints(): ContextHints {
  try {
    return JSON.parse(fs.readFileSync(contextHintFile, 'utf8'));
  } catch {
    return {};
  }
}

function readContextHint() {
  const key = process.env.FLASHWRIGHT_CONTEXT_HINT_KEY;
  if (!key)
    return;
  hintReadAhead = { key, hint: readContextHints()[key] };
  return hintReadAhead.hint;
}

// Called by the `context` fixture once it has created a recycled context.
export function rememberRecycledContext(browser: Browser) {
  const key = process.env.FLASHWRIGHT_CONTEXT_HINT_KEY;
  const params = { ...(browser as any)._lastRecycleParams };
  const storageState = !!params.storageState;
  delete params.storageState;
  const mayHoldSecrets = params.httpCredentials || params.extraHTTPHeaders?.length || params.proxy || params.clientCertificates?.length;
  if (rememberedContextHint || !key || !Object.keys(params).length || mayHoldSecrets || !isPlainJSON(params))
    return;
  rememberedContextHint = true;
  // Reading the file again takes milliseconds of the first test.
  const hint = hintReadAhead?.key === key ? hintReadAhead.hint : undefined;
  if (hint && JSON.stringify(hint.params) === JSON.stringify(params) && hint.storageState === storageState)
    return;
  try {
    const hints = readContextHints();
    if (JSON.stringify(hints[key]?.params) === JSON.stringify(params) && hints[key]?.storageState === storageState)
      return;
    hints[key] = { params, storageState, usedAt: Date.now() };
    const recent = Object.entries(hints).sort((a, b) => b[1].usedAt - a[1].usedAt).slice(0, maxContextHints);
    // Write a sibling file and rename it, so concurrent workers never read a partial file.
    const temporary = `${contextHintFile}.${process.pid}`;
    fs.writeFileSync(temporary, JSON.stringify(Object.fromEntries(recent)), { mode: 0o600 });
    fs.renameSync(temporary, contextHintFile);
  } catch {
  }
}

function isPlainJSON(value: unknown): boolean {
  if (value === null || ['string', 'number', 'boolean', 'undefined'].includes(typeof value))
    return true;
  if (Array.isArray(value))
    return value.every(isPlainJSON);
  return typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype && Object.values(value as object).every(isPlainJSON);
}

// Called when the runner of a warm session exits without having used this worker: the browser
// it started or was offered goes back to the session (see the runner's session.ts).
export async function returnSpeculativeBrowser() {
  const launch = (globalThis as any)[speculativeKey] as Promise<Browser | undefined> | undefined;
  if (!launch || !process.env.FLASHWRIGHT_SESSION_HANDOFF)
    return;
  delete (globalThis as any)[speculativeKey];
  await handBrowsersToSession(await launch, false);
}

export async function takeSpeculativeBrowser(browserName: string, options: LaunchOptions): Promise<Browser | undefined> {
  const lane = lanes()?.currentLane()?.id ?? 0;
  const laneBrowsers = (globalThis as any)[laneBrowsersKey] as (Promise<Browser | undefined> | undefined)[] | undefined;
  const launch = (lane ? laneBrowsers?.[lane] : (globalThis as any)[speculativeKey]) as Promise<Browser | undefined> | undefined;
  if (!launch)
    return;
  if (lane)
    laneBrowsers![lane] = undefined;
  else
    delete (globalThis as any)[speculativeKey];
  const { tracesDir, artifactsDir, ...rest } = options as LaunchOptions & { tracesDir?: string, artifactsDir?: string };
  const browser = await launch;
  if (!browser)
    return;
  const serverBrowser = (browser as any)._connection.toImpl?.(browser);
  if (browserName !== 'chromium' || !isDeepStrictEqual(rest, speculativeOptions) || !serverBrowser || !artifactsDir) {
    // Not the browser this project needs: close it in the background, out of the test's steps.
    (browser as any)._wrapApiCall(() => browser.close(), { internal: true }).catch(() => {});
    return;
  }
  // The browser was launched before the worker knew its output folders, and so was the context it
  // may have prepared for the first test.
  await serverBrowser.setOutputDirs(artifactsDir, tracesDir || artifactsDir);
  if (lanes()?.currentLane())
    serverBrowser.bindToCurrentAsyncContext();
  (browser as any)._connectToBrowserType(browser.browserType(), options, undefined);
  return browser;
}
