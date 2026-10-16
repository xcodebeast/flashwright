import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { bunWebViewPin, bunWebViewError, requireBunWebViewRuntime, bunWebViewOptions, createBunWebViewSession, bunWebViewTextExpression, bunWebViewDraftClassifications, prepareBunWebViewWorkload } from '../benchmarks/bun-webview-workloads.mjs';
import { probeBunWebViewIsolation } from '../benchmarks/bun-webview-controls.mjs';

const configuration = { delayedAssertionMilliseconds: 8, expectedFailureTimeoutMilliseconds: 25 };
const origin = 'http://127.0.0.1:12345';

test('draft refuses a different runtime/source revision before creating a browser', () => {
  class WebView { static closeAll() {} }
  requireBunWebViewRuntime({ ...bunWebViewPin, WebView });
  for (const change of [{ version: '1.4.3' }, { revision: 'unknown' }, { WebView: undefined }]) {
    assert.throws(() => requireBunWebViewRuntime({ ...bunWebViewPin, WebView, ...change }));
  }
});

test('explicit native Chrome options cannot auto-attach or switch backend', () => {
  const options = bunWebViewOptions('/browser/chrome-headless-shell', { width: 1280, height: 720 });
  assert.deepEqual(options, { width: 1280, height: 720, dataStore: 'ephemeral', backend: { type: 'chrome', path: '/browser/chrome-headless-shell', url: false } });
  for (const path of ['chrome', '', '/browser\0other']) assert.throws(() => bunWebViewOptions(path, { width: 1280, height: 720 }));
  for (const width of [0, 1.5, 16385]) assert.throws(() => bunWebViewOptions('/browser', { width, height: 720 }));
});

test('cleanup attempts every view and native browser shutdown, preserving all failures', () => {
  const first = new Error('first view close failed');
  const third = new Error('browser closeAll failed');
  let count = 0;
  const closed = [];
  class WebView {
    constructor() { this.id = ++count; }
    close() { closed.push(this.id); if (this.id === 1) throw first; }
    static closeAll() { closed.push('closeAll'); throw third; }
  }
  const session = createBunWebViewSession(WebView, {});
  session.createView(); session.createView();
  assert.throws(() => session.close(), error => error instanceof AggregateError && error.errors[0] === first && error.errors[1] === third);
  assert.deepEqual(closed, [1, 2, 'closeAll']);
});

function textEnvironment(nodes) {
  let changed;
  let disconnected = 0;
  class MutationObserver {
    constructor(callback) { changed = callback; }
    observe() {}
    disconnect() { disconnected++; }
  }
  const environment = { document: { querySelectorAll: () => nodes }, MutationObserver, setTimeout, clearTimeout };
  return { environment, change: () => changed(), disconnected: () => disconnected };
}

test('text predicate refuses duplicate matches and resolves only after a unique exact match', async () => {
  const nodes = [{ textContent: 'Ready' }, { textContent: 'Ready' }];
  const state = textEnvironment(nodes);
  let settled = false;
  const pending = runInNewContext(bunWebViewTextExpression('#status', 'Ready', 1000), state.environment).then(value => { settled = true; return value; });
  await Promise.resolve();
  assert.equal(settled, false);
  nodes.pop();
  state.change();
  assert.equal(await pending, true);
  assert.equal(state.disconnected(), 1);
});

test('text predicate preserves quoted selector/value as data and disconnects on timeout', async () => {
  let received;
  const state = textEnvironment([]);
  state.environment.document.querySelectorAll = selector => { received = selector; return []; };
  const selector = '#a[title="\');throw new Error(\"injected\")//"]';
  await assert.rejects(runInNewContext(bunWebViewTextExpression(selector, '"\\\nReady', 5), state.environment), /Text predicate timed out/);
  assert.equal(received, selector);
  assert.equal(state.disconnected(), 1);
});

test('text predicate retains query failure and disconnects its observer', async () => {
  const state = textEnvironment([]);
  const failure = new Error('document detached');
  const pending = runInNewContext(bunWebViewTextExpression('#status', 'Ready', 1000), state.environment);
  state.environment.document.querySelectorAll = () => { throw failure; };
  state.change();
  await assert.rejects(pending, error => error === failure);
  assert.equal(state.disconnected(), 1);
});

test('a fresh-view setup never claims fresh-context isolation', async () => {
  let released = 0;
  const session = { createView: () => ({ navigate: async () => {}, evaluate: async () => true }), release: () => released++ };
  const workload = await prepareBunWebViewWorkload('setup', session, origin, configuration);
  await workload.run(); await workload.run();
  assert.deepEqual(await workload.observe(), { freshViews: 2, freshContexts: null, isolation: 'unadmitted-shared-default-browser-context' });
  assert.equal(released, 2);
  assert.equal(bunWebViewDraftClassifications().find(item => item.name === 'setup').status, 'noncomparable');
});

test('preparation retains both the original failure and a failed cleanup', async () => {
  const operation = new Error('navigation failed');
  const cleanup = new Error('close failed');
  const session = { createView: () => ({ navigate: async () => { throw operation; } }), release: () => { throw cleanup; } };
  await assert.rejects(prepareBunWebViewWorkload('noop', session, origin, configuration), error => error instanceof AggregateError && error.errors[0] === operation && error.errors[1] === cleanup);
});

for (const mode of ['resolved', 'browser-closed', 'expected-timeout']) {
  test(`native missing-selector outcome ${mode} retains failures honestly`, async () => {
    const native = new Error(mode === 'expected-timeout' ? "timeout waiting for '#missing' to be actionable" : 'WebView closed');
    const view = {
      navigate: async () => {},
      click: async (selector, options) => {
        assert.equal(selector, '#missing'); assert.equal(options.timeout, 25);
        if (mode !== 'resolved') throw native;
      },
      evaluate: async () => ({}),
    };
    const workload = await prepareBunWebViewWorkload('failure', { createView: () => view, release() {} }, origin, configuration);
    if (mode !== 'expected-timeout') await assert.rejects(workload.run());
    else {
      await workload.run();
      const observation = await workload.observe();
      assert.equal(observation.expectedFailures[0].stack, native.stack);
      assert.equal(observation.expectedFailures[0].operation, 'click');
    }
  });
}

test('isolation probe retains leaked state after live and closed views without normalization', async () => {
  let storage = null;
  let cookies = '';
  const order = [];
  let id = 0;
  const session = {
    createView() {
      const current = ++id;
      order.push(`create-${current}`);
      return { id: current, navigate: async () => {}, evaluate: async expression => {
        if (expression.includes('localStorage.setItem')) { storage = 'first'; cookies = 'fw_webview_isolation=first'; return; }
        return { storage, cookies };
      } };
    },
    release(view) { order.push(`close-${view.id}`); },
  };
  const result = await probeBunWebViewIsolation(session, origin);
  assert.deepEqual(result.firstBefore, { storage: null, cookies: '' });
  assert.deepEqual(result.secondWhileFirstLive, { storage: 'first', cookies: 'fw_webview_isolation=first' });
  assert.deepEqual(result.reopenedAfterBothCloseRequests, result.secondWhileFirstLive);
  assert.deepEqual(order, ['create-1', 'create-2', 'close-1', 'close-2', 'create-3', 'close-3']);
});

test('all seven workload classifications stay unadmitted or noncomparable', () => {
  const classifications = bunWebViewDraftClassifications();
  assert.equal(classifications.length, 7);
  assert.ok(classifications.every(item => ['unadmitted-draft', 'noncomparable'].includes(item.status)));
  assert.equal(classifications.find(item => item.name === 'failure').status, 'noncomparable');
});

test('retained error receipts preserve nested operation and cleanup errors', () => {
  const operation = new Error('original navigation error');
  const cleanup = new Error('native cleanup error');
  const receipt = JSON.parse(JSON.stringify(bunWebViewError(new AggregateError([operation, cleanup], 'both failed'))));
  assert.deepEqual(receipt.errors.map(error => error.message), ['original navigation error', 'native cleanup error']);
  assert.equal(receipt.errors[0].stack, operation.stack);
});

test('backend replaces one-line input using native Home then Shift+End before every insertion', async () => {
  const nativeCalls = [];
  let selected = false;
  let value = '';
  const view = {
    async navigate() {},
    async click(selector) { nativeCalls.push(['click', selector]); },
    async press(key, options) {
      nativeCalls.push(['press', key, options]);
      if (key === 'End' && options?.modifiers?.[0] === 'Shift') selected = true;
    },
    async type(text) { nativeCalls.push(['type', text]); value = selected ? text : value + text; selected = false; },
    async evaluate(expression) {
      if (expression === 'document.querySelector("#name").value') return value;
      if (expression === 'window.observations.clicks.at(-1)') return true;
      assert.match(expression, /^\(function waitForTextInPage/);
      return true;
    },
  };
  const workload = await prepareBunWebViewWorkload('backend', { createView: () => view, release() {} }, origin, configuration);
  await workload.run(); await workload.run();
  assert.equal(value, 'person-2');
  assert.deepEqual(nativeCalls, [1, 2].flatMap(iteration => [
    ['click', '#name'], ['press', 'Home', undefined], ['press', 'End', { modifiers: ['Shift'] }], ['type', `person-${iteration}`], ['click', '#save'],
  ]));
});
