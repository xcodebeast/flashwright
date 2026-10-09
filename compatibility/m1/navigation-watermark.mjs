import assert from 'node:assert/strict';
import { Page } from '../../packages/flashwright-core/dist/commonjs/index.js';
import { failure } from '../../packages/flashwright-core/dist/commonjs/errors.js';

/** Hold journal events ahead of host delivery, independently of command acceptance. */
function fixture({ delay = 0, initialSequence = 10 } = {}) {
  const protocolErrors = [];
  const respond = value => delay ? new Promise(resolve => setTimeout(() => resolve(value), delay)) : Promise.resolve(value);
  const journal = [];
  const commands = [];
  const closedTracePages = [];
  let listener;
  let pending;
  let sequence = 10;
  const snapshot = url => ({ identifier: 'frame', parent: null, name: '', url, navigationSequence: sequence });
  const dispatch = () => {
    if (!pending) return;
    const event = journal.find(event => event.sequence > pending.cursor);
    if (!event) return;
    const waiting = pending; pending = undefined;
    if (event.error) waiting.reject(failure('NavigationError', 'page.navigation.next', event.error));
    else waiting.resolve({ frame: 'frame', sequence: event.sequence, url: event.url });
  };
  const client = {
    subscribeObject(identifier, callback) { listener = callback; return () => {}; },
    setConsoleSubscription() {},
    rejectProtocol(error) { protocolErrors.push(error); listener?.({ event: 'transportclosed', parameters: null }); },
    request(method, parameters) {
      commands.push({ method, parameters });
      if (method === 'page.navigation.capture') return respond({ frame: 'frame', sequence: parameters.sequence });
      if (method === 'page.navigation.next') return new Promise((resolve, reject) => { pending = { cursor: parameters.sequence, resolve, reject }; dispatch(); });
      if (method === 'page.navigation.complete') return respond({ response: null, frames: [snapshot(journal.at(-1).url)] });
      throw new Error(`Unexpected fake request ${method}`);
    },
  };
  const page = new Page(client, 'page', { baseURL: 'http://fixture.test', timeout: () => 1000, navigationTimeout: () => 1000, recordTracePageClosed: page => closedTracePages.push(page) }, false, { identifier: 'page', mainFrame: 'frame', navigationSequence: initialSequence, frames: [snapshot('http://fixture.test/initial')] });
  return {
    page, commands, protocolErrors, closedTracePages,
    record(url, error) { const event = { sequence: ++sequence, url, error, kind: error ? 'failed' : 'sameDocument' }; journal.push(event); dispatch(); return event; },
    deliver(event, publicEvent = false) {
      listener({ event: 'navigation', parameters: event });
      if (publicEvent) listener({ event: 'framenavigated', parameters: { ...snapshot(event.url), navigationSequence: event.sequence } });
    },
  };
}
{
  const { page, record, commands } = fixture();
  record('http://fixture.test/in-flight');
  assert.equal(await page.waitForNavigation(), null);
  assert.equal(commands[0].parameters.sequence, 10);
  assert.equal(page.url(), 'http://fixture.test/in-flight');
}
{
  const { page, record, commands } = fixture();
  record('http://fixture.test/failure', 'in-flight failure');
  await assert.rejects(page.waitForNavigation({ url: '**/unrelated' }), error => error.name === 'NavigationError');
  assert.equal(commands[0].parameters.sequence, 10);
}
{
  const { page, record, deliver, commands } = fixture();
  deliver(record('http://fixture.test/observed-failure', 'old failure'));
  const waiting = page.waitForNavigation();
  record('http://fixture.test/next');
  assert.equal(await waiting, null);
  assert.equal(commands[0].parameters.sequence, 11);
}
{
  const { page, record, deliver, commands } = fixture();
  let next;
  page.once('framenavigated', () => { next = page.waitForNavigation(); });
  deliver(record('http://fixture.test/observed-success'), true);
  record('http://fixture.test/after-listener');
  assert.equal(await next, null);
  assert.equal(commands[0].parameters.sequence, 11);
}
{
  const { page, record } = fixture();
  record('http://fixture.test/first'); record('http://fixture.test/second');
  const urls = [];
  assert.equal(await page.waitForNavigation({ url: url => { urls.push(url.pathname); return url.pathname === '/first'; } }), null);
  assert.deepEqual(urls, ['/first']);
}
{
  const { page, record } = fixture();
  const sentinel = new Error('predicate sentinel');
  const waiting = assert.rejects(page.waitForNavigation({ url: () => { throw sentinel; } }), error => error === sentinel);
  record('http://fixture.test/reject'); await waiting;
  assert.equal(page.listenerCount('close'), 0); assert.equal(page.listenerCount('crash'), 0);
}
{
  const { page, record } = fixture();
  const waiting = assert.rejects(page.waitForNavigation({ timeout: 30, url: () => new Promise(() => {}) }), error => error.name === 'TimeoutError');
  record('http://fixture.test/pending-callback'); await waiting;
  assert.equal(page.listenerCount('close'), 0); assert.equal(page.listenerCount('crash'), 0);
}
{
  const { page, record } = fixture({ delay: 25 });
  record('http://fixture.test/one-budget');
  await assert.rejects(page.waitForNavigation({ timeout: 40 }), error => error.name === 'TimeoutError');
}
{
  const { page, record, closedTracePages } = fixture();
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const waiting = assert.rejects(page.waitForNavigation({ timeout: 0, url: () => { entered(); return new Promise(() => {}); } }), error => error.name === 'TargetClosedError');
  record('http://fixture.test/close-during-callback');
  await started; page.didClose(); await waiting;
  assert.deepEqual(closedTracePages, ['page']);
  assert.equal(page.listenerCount('close'), 0); assert.equal(page.listenerCount('crash'), 0);
}
{
  assert.throws(() => fixture({ initialSequence: Number.NaN }), error => error.name === 'ProtocolError');
  const { page, deliver, protocolErrors } = fixture();
  deliver({ sequence: -1, url: 'http://fixture.test/invalid', kind: 'sameDocument' });
  assert.equal(protocolErrors[0].name, 'ProtocolError'); assert.equal(page.isClosed(), true);
}
console.log('Host navigation watermark, in-flight success/failure, callback identity and deadline checks passed.');
