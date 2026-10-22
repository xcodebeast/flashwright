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

// Flashwright: the failFastWhenIdle context option. An assertion that does not pass yet fails as
// soon as nothing can change the page before its timeout: no timer due before then, no animation
// frame, idle callback, message or DOM change for a while, no request in flight, no open web
// socket, no navigation, no worker or service worker, no other page that could message it and no
// other call from the client on the page. Anything this cannot
// see (a test that acts on the page later from a concurrent async function, for example) can make
// an assertion fail that would have passed, which is why the option is off by default.

import { monotonicTime } from '@isomorphic/time';

import type { Page } from './page';

// The page side, installed in the main world of every frame before the page's own scripts run.
export const idleTrackerSource = `
const key = Symbol.for('flashwright.idle');
if (globalThis[key])
  return;
let activity = 0;
// Timer id -> when it is due next, in this document's performance.now() time.
const timers = new Map();
const frames = new Set();
const idleCallbacks = new Set();
const now = () => performance.now();
const nativeSetTimeout = globalThis.setTimeout;
const nativeClearTimeout = globalThis.clearTimeout;
const nativeSetInterval = globalThis.setInterval;
const nativeClearInterval = globalThis.clearInterval;
globalThis.setTimeout = function setTimeout(handler, timeout, ...args) {
  const delay = Math.max(0, Number(timeout) || 0);
  let id;
  if (typeof handler === 'function') {
    id = nativeSetTimeout.call(globalThis, function() {
      timers.delete(id);
      activity++;
      return handler.apply(this, args);
    }, timeout);
  } else {
    // Code strings run through the native timer; count them as due until they ran.
    id = nativeSetTimeout.call(globalThis, handler, timeout, ...args);
    nativeSetTimeout.call(globalThis, () => timers.delete(id), timeout);
  }
  timers.set(id, now() + delay);
  return id;
};
globalThis.setInterval = function setInterval(handler, timeout, ...args) {
  const period = Math.max(0, Number(timeout) || 0);
  let id;
  if (typeof handler === 'function') {
    id = nativeSetInterval.call(globalThis, function() {
      timers.set(id, now() + period);
      activity++;
      return handler.apply(this, args);
    }, timeout);
    timers.set(id, now() + period);
  } else {
    id = nativeSetInterval.call(globalThis, handler, timeout, ...args);
    timers.set(id, -Infinity);
  }
  return id;
};
// Timeouts and intervals share their ids, and either function clears either kind.
globalThis.clearTimeout = function clearTimeout(id) {
  timers.delete(id);
  return nativeClearTimeout.call(globalThis, id);
};
globalThis.clearInterval = function clearInterval(id) {
  timers.delete(id);
  return nativeClearInterval.call(globalThis, id);
};
const trackCallbacks = (requestName, cancelName, pending) => {
  const request = globalThis[requestName];
  const cancel = globalThis[cancelName];
  if (!request || !cancel)
    return;
  globalThis[requestName] = { [requestName](callback, ...rest) {
    let id;
    id = request.call(globalThis, function(...args) {
      pending.delete(id);
      activity++;
      return callback.apply(this, args);
    }, ...rest);
    pending.add(id);
    return id;
  } }[requestName];
  globalThis[cancelName] = { [cancelName](id) {
    pending.delete(id);
    return cancel.call(globalThis, id);
  } }[cancelName];
};
trackCallbacks('requestAnimationFrame', 'cancelAnimationFrame', frames);
trackCallbacks('requestIdleCallback', 'cancelIdleCallback', idleCallbacks);
// Schedulers (React's among them) post messages to themselves while they have work.
for (const target of [globalThis.MessagePort?.prototype, globalThis]) {
  const postMessage = target?.postMessage;
  if (postMessage) {
    target.postMessage = { postMessage(...args) {
      activity++;
      return postMessage.apply(this, args);
    } }.postMessage;
  }
}
// Playwright marks the elements it acts on with attributes; those are not the page changing.
new MutationObserver(records => {
  if (records.some(record => record.type !== 'attributes' || !record.attributeName.startsWith('__playwright')))
    activity++;
}).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
const isIdle = remaining => {
  if (frames.size || idleCallbacks.size || document.readyState !== 'complete')
    return false;
  const horizon = now() + remaining;
  for (const due of timers.values()) {
    if (due <= horizon)
      return false;
  }
  if (document.fonts?.status === 'loading')
    return false;
  if (document.getAnimations?.().some(animation => animation.playState === 'running' || animation.pending))
    return false;
  if ([...document.querySelectorAll('video, audio')].some(media => !media.paused && !media.ended))
    return false;
  if ([...document.images].some(image => !image.complete))
    return false;
  if (document.querySelector('meta[http-equiv="refresh" i]') || navigator.serviceWorker?.controller)
    return false;
  return true;
};
Object.defineProperty(globalThis, key, { value: { state: remaining => ({ idle: isIdle(remaining), activity }) } });
`;

// How long everything has to stay quiet before an assertion gives up.
const kQuietPeriod = 50;
// Timers due this soon after the deadline still count, for clock differences between processes.
const kDeadlineMargin = 20;

export class IdleDetector {
  private _page: Page;
  private _quietSince: { time: number, activity: string } | undefined;

  constructor(page: Page) {
    this._page = page;
  }

  // True once the page has been idle for the quiet period, with nothing due before the deadline.
  async isIdle(deadline: number): Promise<boolean> {
    const remaining = deadline ? deadline - monotonicTime() : Number.MAX_SAFE_INTEGER;
    if (remaining <= kQuietPeriod || !this._serverSideIdle()) {
      this._quietSince = undefined;
      return false;
    }
    const expression = `globalThis[Symbol.for('flashwright.idle')]?.state(${remaining + kDeadlineMargin})`;
    const states = await Promise.all(this._page.frames().map(frame => frame.nonStallingEvaluateInExistingContext(expression, 'main').catch(() => undefined)));
    if (!this._serverSideIdle() || states.some(state => !state?.idle)) {
      this._quietSince = undefined;
      return false;
    }
    const activity = states.map(state => state.activity).join(',');
    const time = monotonicTime();
    if (this._quietSince?.activity !== activity) {
      this._quietSince = { time, activity };
      return false;
    }
    return time - this._quietSince.time >= kQuietPeriod;
  }

  private _serverSideIdle(): boolean {
    // The assertion itself is one call; any other one (a waitForTimeout() the test races against
    // the assertion, for example) may still change the page.
    if (this._page.activeClientCalls > 1)
      return false;
    if (this._page.browserContext.pages().length > 1 || this._page.hasWorkers() || this._page.frameManager.hasOpenWebSockets())
      return false;
    return this._page.frames().every(frame => !frame.hasPendingNetworkOrNavigation());
  }
}
