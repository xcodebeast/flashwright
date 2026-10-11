import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Browser, BrowserContext, Page } = require('../packages/flashwright-core/dist/commonjs/index.js');
const { publicBrowserContexts } = require('../packages/flashwright-core/dist/commonjs/public-browsers.js');
const { installRunnerContextLifecycle } = require('../packages/flashwright-core/dist/commonjs/runner-lifecycle.js');

/** Minimal engine boundary; ownership and close events use the real source classes. */
class FakeEngineClient {
  subscriptions = new Map();
  requests = [];
  failures = new Map();
  releaseCount = 0;
  contextCount = 0;
  pageCount = 0;
  closed = false;
  releaseFailure;
  failRelease = false;
  unsubscribeFailure;
  failUnsubscribe = false;
  events = [];
  subscribeObject(identifier, listener) {
    this.subscriptions.set(identifier, listener);
    return () => {
      this.subscriptions.delete(identifier);
      if (this.failUnsubscribe) throw this.unsubscribeFailure;
    };
  }
  isClosed() { return this.closed; }
  async release() {
    this.releaseCount++;
    this.events.push('release');
    this.closed = true;
    if (this.releaseBarrier) await this.releaseBarrier;
    if (this.failRelease) throw this.releaseFailure;
  }
  async request(method, parameters) {
    this.requests.push({ method, parameters });
    if (this.failures.has(method)) throw this.failures.get(method);
    if (method === 'browser.newContext') return { identifier: `context-${++this.contextCount}` };
    if (method === 'context.newPage') {
      const identifier = `page-${++this.pageCount}`;
      const frame = { identifier: `${identifier}-frame`, parent: null, name: '', url: 'about:blank', navigationSequence: 0, loader: '' };
      return { identifier, mainFrame: frame.identifier, frames: [frame], navigationSequence: 0 };
    }
  }
}

async function fixture() {
  const client = new FakeEngineClient();
  const browser = new Browser(client, 'browser', 'pinned-host-fixture');
  const contexts = [await browser.newContext(), await browser.newContext()];
  const pages = [];
  for (const context of contexts) pages.push([await context.newPage(), await context.newPage()]);
  assert.ok(contexts.every(context => context instanceof BrowserContext));
  assert.ok(pages.flat().every(page => page instanceof Page));
  return { client, browser, contexts, pages };
}

/** Keep undefined distinguishable from successful settlement and later failures. */
async function rejectionOf(operation) {
  try { await operation(); return { rejected: false }; }
  catch (value) { return { rejected: true, value }; }
}

function thrownBy(operation) {
  try { operation(); return { threw: false }; }
  catch (value) { return { threw: true, value }; }
}

function assertContextRetired(context, pages, client) {
  assert.equal(context.closed, true);
  assert.equal(context.pages().length, 0);
  assert.equal(client.subscriptions.has(context.identifier), false);
  assert.equal(context.routeRegistry.closed, true);
  for (const page of pages) {
    assert.equal(page.isClosed(), true);
    assert.equal(client.subscriptions.has(page.identifier), false);
    assert.equal(page.routeRegistry.closed, true);
    assert.equal(page.mainFrame().isDetached(), true);
  }
}

function assertBrowserRetired(subject) {
  assert.equal(subject.browser.isConnected(), false);
  assert.equal(subject.browser.contexts().length, 0);
  assert.equal(subject.client.subscriptions.size, 0);
  assert.equal(subject.client.releaseCount, 1);
  assert.ok(subject.contexts.every(context => !publicBrowserContexts().includes(context)));
  subject.contexts.forEach((context, index) => assertContextRetired(context, subject.pages[index], subject.client));
}

test('browser closure retires all siblings and releases once while preserving the first listener failure', async () => {
  const subject = await fixture();
  const firstFailure = new Error('first page close');
  const laterFailure = new Error('later cleanup');
  let suppressedPageListener = false;
  let suppressedContextListener = false;
  let suppressedBrowserListener = false;
  subject.pages[0][0].on('close', () => { throw firstFailure; });
  subject.pages[0][0].on('close', () => { suppressedPageListener = true; });
  subject.contexts[0].on('close', () => { throw laterFailure; });
  subject.contexts[0].on('close', () => { suppressedContextListener = true; });
  subject.browser.on('disconnected', () => { throw laterFailure; });
  subject.browser.on('disconnected', () => { suppressedBrowserListener = true; });
  subject.client.failRelease = true;
  subject.client.releaseFailure = laterFailure;
  const closing = subject.browser.close();
  assert.equal(subject.browser.close(), closing);
  assert.deepEqual(await rejectionOf(() => closing), { rejected: true, value: firstFailure });
  assertBrowserRetired(subject);
  assert.equal(suppressedPageListener || suppressedContextListener || suppressedBrowserListener, false);
  assert.deepEqual(await rejectionOf(() => subject.browser.close()), { rejected: true, value: firstFailure });
  assert.equal(subject.client.releaseCount, 1);
});

test('explicit context closure completes page retirement and parent registry cleanup after a page listener throws', async () => {
  const subject = await fixture();
  const firstFailure = new Error('context first page');
  const laterFailure = new Error('context close listener');
  subject.pages[0][0].once('close', () => { throw firstFailure; });
  subject.contexts[0].once('close', () => { throw laterFailure; });
  assert.deepEqual(await rejectionOf(() => subject.contexts[0].close()), { rejected: true, value: firstFailure });
  assertContextRetired(subject.contexts[0], subject.pages[0], subject.client);
  assert.deepEqual(subject.browser.contexts(), [subject.contexts[1]]);
  assert.equal(subject.client.releaseCount, 0);
  await subject.browser.close();
  assertBrowserRetired(subject);
});

test('an undefined first thrown listener value survives later close and release failures', async () => {
  const subject = await fixture();
  subject.pages[0][0].once('close', () => { throw undefined; });
  subject.contexts[1].once('close', () => { throw new Error('later listener'); });
  subject.client.failRelease = true;
  subject.client.releaseFailure = new Error('later release');
  assert.deepEqual(await rejectionOf(() => subject.browser.close()), { rejected: true, value: undefined });
  assertBrowserRetired(subject);
});

test('native browser-close failure remains primary while host listeners and release also fail', async () => {
  const subject = await fixture();
  subject.client.failures.set('browser.close', undefined);
  subject.pages[0][0].once('close', () => { throw new Error('later host close'); });
  subject.client.failRelease = true;
  subject.client.releaseFailure = new Error('later release');
  assert.deepEqual(await rejectionOf(() => subject.browser.close()), { rejected: true, value: undefined });
  assertBrowserRetired(subject);
});

test('native context-close failure remains primary while host cleanup still retires siblings', async () => {
  const subject = await fixture();
  subject.client.failures.set('context.close', undefined);
  subject.pages[0][0].once('close', () => { throw new Error('later context retirement'); });
  assert.deepEqual(await rejectionOf(() => subject.contexts[0].close()), { rejected: true, value: undefined });
  assertContextRetired(subject.contexts[0], subject.pages[0], subject.client);
  await subject.browser.close();
  assertBrowserRetired(subject);
});

test('original transport-disconnect callback retires every sibling and starts the single driver release', async () => {
  const subject = await fixture();
  const firstFailure = new Error('transport original listener');
  subject.pages[0][0].once('close', () => { throw firstFailure; });
  subject.contexts[1].once('close', () => { throw new Error('later transport context'); });
  subject.browser.once('disconnected', () => { throw new Error('later disconnected'); });
  const originalCallback = subject.client.subscriptions.get('browser');
  assert.deepEqual(thrownBy(() => originalCallback({ event: 'transportclosed', parameters: null })), { threw: true, value: firstFailure });
  await subject.browser.close();
  assertBrowserRetired(subject);
  originalCallback({ event: 'transportclosed', parameters: null });
  assert.equal(subject.client.releaseCount, 1);
});

test('unsubscribe failure does not prevent page detach, sibling retirement or later driver release', async () => {
  const subject = await fixture();
  const firstFailure = new Error('subscription cleanup');
  subject.client.failUnsubscribe = true;
  subject.client.unsubscribeFailure = firstFailure;
  assert.deepEqual(await rejectionOf(() => subject.browser.close()), { rejected: true, value: firstFailure });
  assertBrowserRetired(subject);
});

test('healthy close event order stays children then context then browser then release', async () => {
  const subject = await fixture();
  subject.contexts.forEach((context, contextIndex) => {
    subject.pages[contextIndex].forEach((page, pageIndex) => page.on('close', () => subject.client.events.push(`page-${contextIndex}-${pageIndex}`)));
    context.on('close', () => subject.client.events.push(`context-${contextIndex}`));
  });
  subject.browser.on('disconnected', () => subject.client.events.push('browser'));
  await subject.browser.close();
  assert.deepEqual(subject.client.events, ['page-0-0', 'page-0-1', 'context-0', 'page-1-0', 'page-1-1', 'context-1', 'browser', 'release']);
  assertBrowserRetired(subject);
});

test('prepended throwing context listener cannot retain its closed object in the browser registry', async () => {
  const subject = await fixture();
  const firstFailure = new Error('prepended context close');
  let laterListenerRan = false;
  subject.contexts[0].prependListener('close', () => { throw firstFailure; });
  subject.contexts[0].on('close', () => { laterListenerRan = true; });
  assert.deepEqual(await rejectionOf(() => subject.contexts[0].close()), { rejected: true, value: firstFailure });
  assert.equal(laterListenerRan, false);
  assert.equal(subject.browser.contexts().includes(subject.contexts[0]), false);
  assertContextRetired(subject.contexts[0], subject.pages[0], subject.client);
  await subject.browser.close();
  assertBrowserRetired(subject);
});

test('prepended throwing page listener cannot retain its closed object in the context registry', async () => {
  const subject = await fixture();
  const firstFailure = new Error('prepended page close');
  let laterListenerRan = false;
  subject.pages[0][0].prependListener('close', () => { throw firstFailure; });
  subject.pages[0][0].on('close', () => { laterListenerRan = true; });
  assert.deepEqual(await rejectionOf(() => subject.pages[0][0].close()), { rejected: true, value: firstFailure });
  assert.equal(laterListenerRan, false);
  assert.equal(subject.contexts[0].pages().includes(subject.pages[0][0]), false);
  await subject.browser.close();
  assertBrowserRetired(subject);
});

test('removing all public close listeners cannot remove internal owner retirement', async () => {
  const subject = await fixture();
  subject.pages[0][0].removeAllListeners('close');
  await subject.pages[0][0].close();
  assert.equal(subject.contexts[0].pages().includes(subject.pages[0][0]), false);
  subject.contexts[0].removeAllListeners('close');
  await subject.contexts[0].close();
  assert.equal(subject.browser.contexts().includes(subject.contexts[0]), false);
  await subject.browser.close();
  assertBrowserRetired(subject);
});

test('context preparation failure stays primary through native close and listener failure', async () => {
  const subject = await fixture();
  const dispose = installRunnerContextLifecycle({
    didCreateContext() {},
    willCloseContext(context) { return context === subject.contexts[0] ? Promise.reject(undefined) : Promise.resolve(); },
  });
  try {
    subject.client.failures.set('context.close', new Error('later native close'));
    subject.pages[0][0].on('close', () => { throw new Error('later listener'); });
    assert.deepEqual(await rejectionOf(() => subject.contexts[0].close()), { rejected: true, value: undefined });
    assertContextRetired(subject.contexts[0], subject.pages[0], subject.client);
    assert.equal(subject.client.requests.filter(request => request.method === 'context.close').length, 1);
    await subject.browser.close();
    assertBrowserRetired(subject);
  } finally { dispose(); }
});

test('browser preparation retires all contexts and preserves its first rejected context value', async () => {
  const subject = await fixture();
  const preparedContexts = [];
  const dispose = installRunnerContextLifecycle({
    didCreateContext() {},
    willCloseContext(context, source) {
      assert.equal(source, 'browser');
      preparedContexts.push(context);
      return Promise.reject(context === subject.contexts[0] ? undefined : new Error('later preparation'));
    },
  });
  try {
    subject.client.failures.set('browser.close', new Error('later native close'));
    subject.pages[0][0].on('close', () => { throw new Error('later listener'); });
    subject.client.failRelease = true;
    subject.client.releaseFailure = new Error('later driver release');
    assert.deepEqual(await rejectionOf(() => subject.browser.close()), { rejected: true, value: undefined });
    assert.equal(preparedContexts.length, 2);
    assert.ok(subject.contexts.every(context => preparedContexts.includes(context)));
    assert.equal(subject.client.requests.filter(request => request.method === 'browser.close').length, 1);
    assertBrowserRetired(subject);
  } finally { dispose(); }
});

test('page native close failure stays primary and page ownership retires despite a close listener failure', async () => {
  const subject = await fixture();
  subject.client.failures.set('page.close', undefined);
  subject.pages[0][0].prependListener('close', () => { throw new Error('later page listener'); });
  const closing = subject.pages[0][0].close();
  assert.equal(subject.pages[0][0].close(), closing);
  assert.deepEqual(await rejectionOf(() => closing), { rejected: true, value: undefined });
  assert.equal(subject.pages[0][0].isClosed(), true);
  assert.equal(subject.contexts[0].pages().includes(subject.pages[0][0]), false);
  assert.deepEqual(await rejectionOf(() => subject.pages[0][0].close()), { rejected: true, value: undefined });
  assert.equal(subject.client.requests.filter(request => request.method === 'page.close').length, 1);
  await subject.browser.close();
  assertBrowserRetired(subject);
});

test('context-owning page close retires its siblings and preserves the original child failure', async () => {
  const subject = await fixture();
  const ownedPage = await subject.contexts[0].newOwnedPage();
  subject.pages[0][0].on('close', () => { throw undefined; });
  assert.deepEqual(await rejectionOf(() => ownedPage.close()), { rejected: true, value: undefined });
  assertContextRetired(subject.contexts[0], [...subject.pages[0], ownedPage], subject.client);
  assert.equal(subject.browser.contexts().includes(subject.contexts[0]), false);
  await subject.browser.close();
  assertBrowserRetired(subject);
});

test('explicit close after transport loss awaits the same pending driver release', async () => {
  const subject = await fixture();
  let finishRelease;
  subject.client.releaseBarrier = new Promise(resolve => { finishRelease = resolve; });
  const firstFailure = new Error('original transport listener');
  subject.pages[0][0].on('close', () => { throw firstFailure; });
  const originalCallback = subject.client.subscriptions.get('browser');
  assert.deepEqual(thrownBy(() => originalCallback({ event: 'disconnected', parameters: null })), { threw: true, value: firstFailure });
  assertBrowserRetired(subject);
  let closeSettled = false;
  const closing = subject.browser.close().then(() => { closeSettled = true; });
  await Promise.resolve();
  assert.equal(closeSettled, false);
  assert.equal(subject.client.releaseCount, 1);
  finishRelease();
  await closing;
  assert.equal(closeSettled, true);
  assert.equal(subject.client.releaseCount, 1);
});

test('driver release failure is reported when all earlier cleanup succeeds', async () => {
  const subject = await fixture();
  subject.client.failRelease = true;
  subject.client.releaseFailure = undefined;
  assert.deepEqual(await rejectionOf(() => subject.browser.close()), { rejected: true, value: undefined });
  assertBrowserRetired(subject);
});
