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

// The options the browser fixture uses for a default project whose contexts are recycled.
const speculativeOptions = { handleSIGINT: false, headless: true, ...(process.env.FLASHWRIGHT_ISOLATION === 'strict' ? {} : { recycleContexts: true }) };
// The fixtures and the worker entry are bundled separately; share the launch through a global.
const speculativeKey = Symbol.for('flashwright.speculativeBrowser');

export function launchSpeculativeBrowser(): Promise<Browser | undefined> {
  const playwright = require('playwright-core');
  const launch = playwright.chromium.launch(speculativeOptions).catch(() => undefined);
  (globalThis as any)[speculativeKey] = launch;
  return launch;
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
  return key ? readContextHints()[key] : undefined;
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

export async function takeSpeculativeBrowser(browserName: string, options: LaunchOptions): Promise<Browser | undefined> {
  const launch = (globalThis as any)[speculativeKey] as Promise<Browser | undefined> | undefined;
  if (!launch)
    return;
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
  (browser as any)._connectToBrowserType(browser.browserType(), options, undefined);
  return browser;
}
