import { setTimeout } from 'node:timers/promises';
import { bunWebViewError, releaseBunWebViews } from './bun-webview-workloads.mjs';

const storageSnapshot = '({ storage: localStorage.getItem("flashwright-webview-isolation"), cookies: document.cookie })';

/** Observe the suspected Chrome storage sharing without erasing it or changing native ownership. */
export async function probeBunWebViewIsolation(session, origin, observeLifetime = async () => null) {
  const active = new Set();
  const open = async () => {
    const view = session.createView();
    active.add(view);
    await view.navigate(`${origin}/fixture`);
    return view;
  };
  const close = view => { session.release(view); active.delete(view); };
  let failure;
  try {
    const first = await open();
    const firstBefore = await first.evaluate(storageSnapshot);
    await first.evaluate('(() => { localStorage.setItem("flashwright-webview-isolation", "first"); document.cookie = "fw_webview_isolation=first; path=/"; })()');
    const second = await open();
    const secondWhileFirstLive = await second.evaluate(storageSnapshot);
    close(first);
    close(second);
    const afterBothCloseRequests = await observeLifetime('after-both-view-close-requests');
    const reopened = await open();
    const reopenedAfterBothCloseRequests = await reopened.evaluate(storageSnapshot);
    close(reopened);
    return { firstBefore, secondWhileFirstLive, reopenedAfterBothCloseRequests, afterBothCloseRequests,
      conclusion: 'Raw observations only; synchronous close requests do not establish native target destruction or isolated browser contexts.' };
  } catch (error) { failure = error; }
  finally { releaseBunWebViews(session, active, failure); }
}

async function outcome(operation) {
  try { await operation(); return { status: 'resolved' }; }
  catch (error) { return { status: 'rejected', ...bunWebViewError(error) }; }
}

/** Separate diagnostic page: never bypass native selector readiness or synthesize browser input. */
export async function probeBunWebViewInput(session, origin) {
  const view = session.createView();
  let failure;
  try {
    await view.navigate(`${origin}/fixture`);
    await view.evaluate(`(() => {
      const root = document.createElement('div');
      root.innerHTML = '<button id="disabled-probe" disabled>Disabled</button><button id="covered-probe">Covered</button><div id="overlay-probe"></div><button class="duplicate-probe">First</button><button class="duplicate-probe">Second</button>';
      document.body.append(root);
      const box = document.querySelector('#covered-probe').getBoundingClientRect();
      Object.assign(document.querySelector('#overlay-probe').style, { position: 'fixed', zIndex: '99999', left: box.left+'px', top: box.top+'px', width: box.width+'px', height: box.height+'px', background: 'red' });
      window.webViewInputEvents = [];
      for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click', 'keydown', 'keyup', 'beforeinput', 'input']) {
        document.addEventListener(type, event => window.webViewInputEvents.push({ type: event.type, trusted: event.isTrusted, target: event.target.id || event.target.textContent, inputType: event.inputType || null }), true);
      }
    })()`);
    const disabled = await outcome(() => view.click('#disabled-probe', { timeout: 100 }));
    const covered = await outcome(() => view.click('#covered-probe', { timeout: 100 }));
    const duplicate = await outcome(() => view.click('.duplicate-probe', { timeout: 5000 }));
    await view.click('#name', { timeout: 5000 });
    await view.type('first');
    await view.press('a', { modifiers: ['Control'] });
    await view.type('replacement');
    const replacement = await view.evaluate('document.querySelector("#name").value');
    const events = await view.evaluate('window.webViewInputEvents');
    const eventOffset = events.length;
    await view.press('Home');
    await view.press('End', { modifiers: ['Shift'] });
    await view.type('home-end-replacement');
    const homeShiftEndReplacement = {
      value: await view.evaluate('document.querySelector("#name").value'),
      events: await view.evaluate(`window.webViewInputEvents.slice(${eventOffset})`),
    };
    return { disabled, covered, duplicate, replacement, events, homeShiftEndReplacement,
      conclusion: 'Observed native input only. These controls do not establish full Playwright readiness, scrolling, strictness, frames, navigation barriers or deadline/cancellation equivalence.' };
  } catch (error) { failure = error; }
  finally { releaseBunWebViews(session, [view], failure); }
}

export async function probeBunWebViewLifetime(session, origin, observeLifetime) {
  const view = session.createView();
  await view.navigate(`${origin}/fixture`);
  const beforeClose = await observeLifetime('before-view-close');
  // Keep the rejection observed before requesting synchronous close.
  const pending = outcome(() => view.evaluate('new Promise(() => {})'));
  session.release(view);
  const pendingAfterClose = await pending;
  const operationAfterClose = await outcome(() => view.evaluate('42'));
  const immediatelyAfterClose = await observeLifetime('immediately-after-view-close');
  await setTimeout(50);
  const afterCloseDelay = await observeLifetime('50ms-after-view-close');
  return { beforeClose, pendingAfterClose, operationAfterClose, immediatelyAfterClose, afterCloseDelay,
    conclusion: 'A rejected JS promise and close() return do not prove target/process drain. Original collector teardown evidence is required.' };
}
