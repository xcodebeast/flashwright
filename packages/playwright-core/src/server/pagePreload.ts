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

// Flashwright: the test runner's preloadPages option. A browser that preloads keeps a second
// recycled context; while a test runs in one, the tab the next test gets in the other loads the
// page that test is expected to open first (see Browser.preloadNextPage). When the next test's
// first call is a goto of that URL, the goto returns the navigation that already happened.
//
// Until then the preloaded document stays hidden: clients are told the page is still the blank tab
// it was, and its frames' events are held back, so that the goto reports the navigation as if it
// happened then. If the test calls anything else first, goes to another URL, or the document did
// something a goto cannot report afterwards (a popup, a download, a service worker), the page goes
// back to a blank tab and the context's storage is reset, as if nothing had been loaded.

import { monotonicTime } from '@isomorphic/time';
import { eventsHelper } from '@utils/eventsHelper';
import { nullProgress, ProgressController } from './progress';

import type { BrowserContext } from './browserContext';
import type { Frame } from './frames';
import type { SdkObject } from './instrumentation';
import type * as network from './network';
import type { Page, PageError } from './page';
import type { Progress } from './progress';
import type * as types from './types';
import type { RegisteredListener } from '@utils/eventsHelper';

// A document that loaded longer ago than this when the test navigates is loaded again: the test
// would otherwise see a page that has been running for longer than its navigation took.
const kMaxAge = 500;
const kPreloadTimeout = 30000;
const kDiscardTimeout = 5000;

export class PagePreload {
  readonly page: Page;
  readonly url: string;
  // What clients see of the main frame while the document is hidden: the blank tab.
  readonly blankUrl: string;
  readonly blankLoadStates: types.LifecycleEvent[];
  // The document's page errors, reported when it is shown.
  readonly pageErrors: PageError[] = [];
  readonly startedAt = monotonicTime();
  private _navigation: Promise<network.Response | null | Error>;
  private _loadedAt: number | undefined;
  private _unusable = false;
  private _discarded: Promise<void> | undefined;
  // Set once the goto shows the document: until then, its requests are not reported.
  shown = false;
  private _listeners: RegisteredListener[];

  constructor(page: Page, url: string) {
    this.page = page;
    this.url = url;
    // What a goto could not report afterwards.
    const markUnusable = () => this.markUnusable();
    this._listeners = [
      eventsHelper.addEventListener(page, 'download', markUnusable),
      eventsHelper.addEventListener(page, 'filechooser', markUnusable),
      eventsHelper.addEventListener(page, 'websocket', markUnusable),
      eventsHelper.addEventListener(page.browserContext, 'page', (popup: Page) => {
        if (popup.opener() === page)
          markUnusable();
      }),
    ];
    const mainFrame = page.mainFrame();
    this.blankUrl = mainFrame.url();
    this.blankLoadStates = [...mainFrame._firedLifecycleEvents];
    const controller = new ProgressController();
    this._navigation = controller.run(progress => mainFrame.gotoImpl(progress, url, {}), kPreloadTimeout).then(response => {
      this._loadedAt = monotonicTime();
      if (response && response.status() >= 400)
        this._unusable = true;
      return response;
    }, error => {
      this._unusable = true;
      return error as Error;
    });
  }

  // Settles once the document has loaded, or failed to.
  async loaded(): Promise<void> {
    await this._navigation;
  }

  loadDuration(): number | undefined {
    return this._loadedAt === undefined ? undefined : this._loadedAt - this.startedAt;
  }

  markUnusable() {
    if (this._unusable)
      return;
    this._unusable = true;
    this.page.browserContext.preloadBecameUnusable(this);
  }

  discardIfUnusable() {
    if (this._unusable)
      this.discard().catch(() => {});
  }

  // Called by the test's goto of the page's main frame. Returns that navigation's response when
  // the preloaded document is shown, or undefined once the page is a blank tab again and the goto
  // should navigate.
  async claim(progress: Progress, url: string, options: types.GotoOptions): Promise<network.Response | null | undefined> {
    const referer = options.referer ?? this.page.extraHTTPHeaders()?.find(h => h.name.toLowerCase() === 'referer')?.value;
    const waitUntil = options.waitUntil ?? 'load';
    if (normalizeURL(url) === normalizeURL(this.url) && referer === undefined && ['load', 'domcontentloaded', 'commit', 'networkidle'].includes(waitUntil) && !this._unusable) {
      const result = await progress.race(this._navigation);
      // Calls the client made along with the goto, like waiting for one of the navigation's
      // requests, arrive meanwhile: they see the navigation happen, without the preload.
      await progress.race(new Promise(f => setImmediate(f)));
      if (!(result instanceof Error) && this._isUsable()) {
        this._stopWatching();
        this.shown = true;
        this.page.showPreloadedDocument(this);
        return result;
      }
    }
    await progress.race(this.discard());
    return undefined;
  }

  private _stopWatching() {
    eventsHelper.removeEventListeners(this._listeners);
  }

  private _isUsable(): boolean {
    return !this._unusable && this._loadedAt !== undefined && monotonicTime() - this._loadedAt <= kMaxAge && this.page.preload === this && !this.page.isClosedOrClosingOrCrashed();
  }

  pendingDiscard(): Promise<void> | undefined {
    return this._discarded;
  }

  // Puts the page and its context back as they were before the preload. A page that cannot be
  // reset closes, rather than show the test a document it did not load.
  discard(): Promise<void> {
    this._unusable = true;
    this._discarded ??= (async () => {
      this._stopWatching();
      const reset = this.page.browserContext.resetPreloadedPage(this.page).then(() => true, () => false);
      const done = await Promise.race([reset, new Promise<boolean>(f => setTimeout(() => f(false), kDiscardTimeout))]);
      if (this.page.preload === this)
        this.page.preload = undefined;
      if (!done)
        await this.page.close(nullProgress, { reason: 'Could not reset the preloaded page' }).catch(() => {});
    })();
    return this._discarded;
  }
}

function normalizeURL(url: string): string {
  try {
    return new URL(url).href;
  } catch {
    return url;
  }
}

// Contexts handed to a test that has not navigated yet. Until it does, calls from clients are
// checked: anything but a goto (and calls that cannot affect a page) means the test does more
// before navigating than the preloaded document has seen.
const awaitingFirstNavigation = new Set<BrowserContext>();

export function watchFirstNavigation(context: BrowserContext) {
  awaitingFirstNavigation.add(context);
}

export function unwatchFirstNavigation(context: BrowserContext) {
  awaitingFirstNavigation.delete(context);
}

export function isAwaitingFirstNavigation(context: BrowserContext): boolean {
  return awaitingFirstNavigation.has(context) && !context.hasFirstNavigation();
}

// Returns a promise to wait for before running the call, if it needs to wait.
export function beforeClientCall(object: SdkObject, type: string, method: string): Promise<unknown> | undefined {
  if (!awaitingFirstNavigation.size)
    return;
  const discards: Promise<void>[] = [];
  const owner = object.attribution.context;
  for (const context of awaitingFirstNavigation) {
    // Calls on what belongs to another context are another test's: the workers of the test runner's
    // process share a browser (see its workersPerProcess).
    if (owner && owner !== context)
      continue;
    if (!isAllowedBeforeFirstNavigation(context, object, type, method))
      discards.push(context.callBeforeFirstNavigation());
  }
  return discards.length ? Promise.all(discards) : undefined;
}

function isAllowedBeforeFirstNavigation(context: BrowserContext, object: SdkObject, type: string, method: string): boolean {
  // Default timeouts only apply to the client's own calls.
  if (method.endsWith('NoReply'))
    return true;
  if (type === 'Frame' && method === 'goto')
    return (object as Frame)._page?.browserContext === context;
  if (type === 'BrowserContext' && method === 'newPage')
    return object === context;
  // What the test runner calls when a test takes or gives back its recycled context, or sets up its
  // locators: another worker's test, when the workers of its process share the browser.
  if (type === 'Browser' && (method === 'preloadNextPage' || method === 'closeRecycledContext' || method === 'newContextForRecycle'))
    return true;
  if (type === 'BrowserContext' && method === 'setTestIdAttributeName')
    return true;
  return false;
}
