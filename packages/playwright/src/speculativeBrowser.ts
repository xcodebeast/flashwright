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

import { isDeepStrictEqual } from 'util';

import type { Browser, LaunchOptions } from 'playwright-core';

// The options the browser fixture uses for a default project whose contexts are recycled.
const speculativeOptions = { handleSIGINT: false, headless: true, ...(process.env.FLASHWRIGHT_ISOLATION === 'strict' ? {} : { recycleContexts: true }) };
// The fixtures and the worker entry are bundled separately; share the launch through a global.
const speculativeKey = Symbol.for('flashwright.speculativeBrowser');

export function launchSpeculativeBrowser() {
  const playwright = require('playwright-core');
  (globalThis as any)[speculativeKey] = playwright.chromium.launch(speculativeOptions).catch(() => undefined);
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
  // The browser was launched before the worker knew its output folders; nothing has used them yet.
  serverBrowser.options.artifactsDir = artifactsDir;
  serverBrowser.options.downloadsPath = artifactsDir;
  serverBrowser.options.tracesDir = tracesDir || artifactsDir;
  (browser as any)._connectToBrowserType(browser.browserType(), options, undefined);
  return browser;
}
