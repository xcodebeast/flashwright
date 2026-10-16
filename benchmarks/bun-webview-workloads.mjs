import assert from 'node:assert/strict';
import { isAbsolute } from 'node:path';

export const bunWebViewPin = Object.freeze({ version: '1.4.2', revision: '744846f844374847c902b5e7fd59b4342a51ef99' });
export const bunWebViewWorkloads = Object.freeze(['noop', 'interaction', 'assertion', 'navigation', 'setup', 'backend', 'failure']);
export const bunWebViewNativeLaunchPolicy = Object.freeze({
  source: `https://github.com/oven-sh/bun/blob/${bunWebViewPin.revision}/src/runtime/webview/ChromeProcess.rs#L538`,
  argumentsEvidence: 'Pinned source expectations only; proc cmdline may be an overwritten process title and does not authenticate original argv.',
  expectedArguments: Object.freeze(['--user-data-dir=__BUN_PROFILE__', '--remote-debugging-pipe', '--headless', '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-extensions', '--disable-background-networking', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-ipc-flooding-protection', '--no-startup-window']),
  referencePolicyEquivalent: false,
});

export function bunWebViewError(error, depth = 0) {
  return { name: error?.name, message: error?.message ?? String(error), stack: error?.stack,
    ...(depth < 8 && Array.isArray(error?.errors) ? { errors: error.errors.map(child => bunWebViewError(child, depth + 1)) } : {}),
  };
}

/** Preserve the operation error as well as every cleanup failure. */
export function releaseBunWebViews(session, views, operationError) {
  const failures = operationError === undefined ? [] : [operationError];
  for (const view of views) {
    try { session.release(view); } catch (error) { failures.push(error); }
  }
  if (failures.length > 1) throw new AggregateError(failures, 'WebView operation and cleanup failures');
  if (failures.length) throw failures[0];
}

export function requireBunWebViewRuntime(runtime) {
  assert.equal(runtime?.version, bunWebViewPin.version, 'Use the pinned Bun runtime');
  assert.equal(runtime?.revision, bunWebViewPin.revision, 'Reaudit WebView before changing its source revision');
  assert.equal(typeof runtime.WebView, 'function', 'The pinned runtime must expose Bun.WebView');
  assert.equal(typeof runtime.WebView.closeAll, 'function');
}

/** Native defaults are deliberately retained; their flags are a separate admission class. */
export function bunWebViewOptions(browserPath, viewport) {
  assert.ok(typeof browserPath === 'string' && isAbsolute(browserPath) && !browserPath.includes('\0'), 'Pass an absolute pinned browser executable');
  for (const dimension of ['width', 'height']) assert.ok(Number.isInteger(viewport?.[dimension]) && viewport[dimension] >= 1 && viewport[dimension] <= 16384);
  return { width: viewport.width, height: viewport.height, dataStore: 'ephemeral', backend: { type: 'chrome', path: browserPath, url: false } };
}

/** close() has no browser acknowledgement; closeAll() is native SIGKILL, not graceful teardown. */
export function createBunWebViewSession(WebView, options) {
  const views = new Set();
  let createdViews = 0;
  return {
    createView() {
      const view = new WebView(structuredClone(options));
      views.add(view);
      createdViews++;
      return view;
    },
    release(view) {
      view.close();
      views.delete(view);
    },
    get createdViews() { return createdViews; },
    close() {
      const failures = [];
      for (const view of views) {
        try { view.close(); views.delete(view); } catch (error) { failures.push(error); }
      }
      try { WebView.closeAll(); } catch (error) { failures.push(error); }
      if (failures.length) throw new AggregateError(failures, 'WebView native cleanup requests failed');
    },
  };
}

function waitForTextInPage(selector, expected, timeout) {
  return new Promise((resolve, reject) => {
    let observer;
    let timer;
    function stop() { observer?.disconnect(); clearTimeout(timer); }
    function check() {
      const nodes = document.querySelectorAll(selector);
      if (nodes.length === 1 && nodes[0].textContent === expected) { stop(); resolve(true); return true; }
      return false;
    }
    try {
      if (check()) return;
      observer = new MutationObserver(() => {
        try { check(); } catch (error) { stop(); reject(error); }
      });
      observer.observe(document, { subtree: true, childList: true, characterData: true });
      timer = setTimeout(() => { stop(); reject(new Error(`Text predicate timed out: ${selector} = ${JSON.stringify(expected)}`)); }, timeout);
      check();
    } catch (error) { stop(); reject(error); }
  });
}

export function bunWebViewTextExpression(selector, expected, timeout = 5000) {
  assert.equal(typeof selector, 'string');
  assert.equal(typeof expected, 'string');
  assert.ok(Number.isInteger(timeout) && timeout > 0);
  return `(${waitForTextInPage.toString()})(${JSON.stringify(selector)},${JSON.stringify(expected)},${timeout})`;
}

const expectText = (view, selector, expected) => view.evaluate(bunWebViewTextExpression(selector, expected));

/** All seven fixture outcomes are drafts; a fresh view is never labelled a fresh context. */
export async function prepareBunWebViewWorkload(name, session, origin, configuration) {
  assert.ok(bunWebViewWorkloads.includes(name), `Unknown workload: ${name}`);
  assert.match(origin, /^http:\/\/127\.0\.0\.1:\d+$/);
  if (name === 'setup') {
    let freshViews = 0;
    return {
      async run() {
        const view = session.createView();
        freshViews++;
        let failure;
        try { await view.navigate(`${origin}/fixture`); await expectText(view, '[role="status"]', 'Ready'); }
        catch (error) { failure = error; }
        releaseBunWebViews(session, [view], failure);
      },
      close() {},
      observe: async () => ({ freshViews, freshContexts: null, isolation: 'unadmitted-shared-default-browser-context' }),
    };
  }
  const view = session.createView();
  try {
    await view.navigate(`${origin}/fixture`);
    let iteration = 0;
    const expectedFailures = [];
    const operations = {
      async noop() { assert.equal(await view.evaluate('42'), 42); },
      async interaction() {
        await view.click('#increment', { timeout: 5000 });
        await expectText(view, '#count', String(++iteration));
        assert.equal(await view.evaluate('window.observations.clicks.at(-1)'), true);
      },
      async assertion() {
        await view.evaluate(`window.delayStatus(${JSON.stringify(configuration.delayedAssertionMilliseconds)})`);
        await expectText(view, '[role="status"]', 'Ready');
      },
      async navigation() {
        await view.navigate(`${origin}/fixture?iteration=${++iteration}`);
        assert.equal(await view.evaluate('document.title'), 'Flashwright baseline');
        await expectText(view, '[role="status"]', 'Ready');
      },
      async backend() {
        const value = `person-${++iteration}`;
        await view.click('#name', { timeout: 5000 });
        await view.press('Home');
        await view.press('End', { modifiers: ['Shift'] });
        await view.type(value);
        assert.equal(await view.evaluate('document.querySelector("#name").value'), value);
        await view.click('#save', { timeout: 5000 });
        await expectText(view, '[role="status"]', `Saved ${value}`);
        assert.equal(await view.evaluate('window.observations.clicks.at(-1)'), true);
      },
      async failure() {
        let observed;
        try { await view.click('#missing', { timeout: configuration.expectedFailureTimeoutMilliseconds }); }
        catch (error) { observed = bunWebViewError(error); }
        assert.ok(observed, 'Missing-element native click unexpectedly succeeded');
        assert.match(observed.message, /timeout waiting for '#missing' to be actionable/);
        expectedFailures.push({ operation: 'click', selector: '#missing', timeout: configuration.expectedFailureTimeoutMilliseconds, ...observed });
      },
    };
    return {
      run: operations[name],
      close: () => session.release(view),
      observe: async () => ({ ...await view.evaluate(`({
        trustedClicks: window.observations.clicks.filter(Boolean).length,
        untrustedClicks: window.observations.clicks.filter(value => !value).length,
        trustedChanges: window.observations.changes.filter(Boolean).length,
        untrustedChanges: window.observations.changes.filter(value => !value).length,
        applicationCount: window.observations.count,
        viewport: { width: innerWidth, height: innerHeight },
        visibilityState: document.visibilityState, focused: document.hasFocus()
      })`), expectedFailures }),
    };
  } catch (error) {
    releaseBunWebViews(session, [view], error);
  }
}

export function bunWebViewDraftClassifications() {
  return bunWebViewWorkloads.map(name => ({
    name, status: name === 'setup' || name === 'failure' ? 'noncomparable' : 'unadmitted-draft',
    reasons: [
      'Native Chrome launch flags, live executable identity, input/readiness, context isolation and cleanup need original collector controls.',
      ...(name === 'setup' ? ['Creates fresh views in the shared default browser context; no fresh-context claim.'] : []),
      ...(name === 'failure' ? ['Native selector-click actionability timeout differs from the reference visibility/assertion failure and diagnostics.'] : []),
      ...(['assertion', 'interaction', 'navigation', 'backend'].includes(name) ? ['Text uses a declared evaluate/MutationObserver helper; this is not a native assertion API.'] : []),
      ...(name === 'backend' ? ['Native click + Home + Shift+End + InsertText differs from locator.fill; retain extra key/input events and independent server counts.'] : []),
      ...(name === 'navigation' || name === 'backend' ? ['High-level navigate has no HTTP response result; response status admission remains separate.'] : []),
    ],
  }));
}
