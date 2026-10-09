import assert from 'node:assert/strict';
import { BrowserContext, Page } from '../packages/flashwright-core/dist/commonjs/index.js';

function fixture() {
  const subscribers = new Map(), failures = [];
  let rawHeaders = [];
  const client = {
    subscribeObject(identifier, callback) { subscribers.set(identifier, callback); return () => subscribers.delete(identifier); },
    rejectProtocol(error) { failures.push(error); },
    async request(method) { assert.equal(method, 'network.headers'); return rawHeaders; },
  };
  const context = new BrowserContext(client, 'context', null, null, undefined);
  const page = new Page(client, 'page', context, false, { identifier: 'page', frames: [], mainFrame: 'frame', navigationSequence: 0 });
  const emit = (event, parameters) => subscribers.get('page')({ event, parameters });
  const requests = []; page.on('request', request => requests.push(request));
  function request(identity, bytes = 0, predecessor) {
    emit('request', { identifier: identity, identity, url: 'https://example.test/' + identity, method: 'GET', headers: {}, postDataEntries: null, resourceType: 'Fetch', navigation: false, frame: null, loader: '', ...(predecessor ? { redirectedFrom: predecessor } : {}) });
    const request = requests.at(-1);
    if (bytes) request.applyOverrides({ postDataBuffer: Buffer.alloc(bytes) });
    return request;
  }
  const finish = (identity, redirecting = false) => emit('requestfinished', { identifier: identity, identity, redirecting });
  const close = () => { page.didClose(); context.didClose(); };
  return { page, failures, request, finish, emit, close, setHeaders(value) { rawHeaders = value; } };
}
const mebibyte = 1024 * 1024;

{
  const state = fixture();
  const first = state.request('first', 28 * mebibyte); state.finish('first', true);
  const second = state.request('second', 28 * mebibyte, 'first'); state.finish('second');
  state.request('third', 12 * mebibyte); state.finish('third');
  assert.equal(state.failures.length, 0);
  assert.deepEqual([...state.page.requests.keys()], ['third'], 'eviction releases the entire strongly linked chain');
  assert.equal(first.redirectedTo(), second); assert.equal(second.redirectedFrom(), first);
  assert.equal(first.postDataBuffer().length, 28 * mebibyte, 'external owners retain their public data');
  state.close();
}
{
  const state = fixture();
  const first = state.request('first', 29 * mebibyte); state.finish('first');
  const second = state.request('second', 29 * mebibyte);
  state.emit('response', { identifier: 'second', request: { identifier: 'second', identity: 'second' }, url: second.url(), status: 200, statusText: 'OK', headers: {}, fromServiceWorker: false });
  state.finish('second');
  state.setHeaders([{ name: 'X-Large', value: 'x'.repeat(4 * mebibyte) }]);
  await second.allHeaders();
  assert.equal(state.failures.length, 0);
  assert.deepEqual([...state.page.requests.keys()], ['second'], 'lazy request headers participate in history eviction');
  assert.equal(first.postDataBuffer().length, 29 * mebibyte);
  const response = await second.response();
  const before = second.retainedBytes(); await response.allHeaders();
  assert(second.retainedBytes() > before + 7 * mebibyte, 'response raw headers belong to their request history owner');
  state.close();
}
{
  const state = fixture();
  state.request('first', 32 * mebibyte); state.finish('first', true);
  state.request('second', 32 * mebibyte, 'first'); state.finish('second', true);
  assert(state.failures.length > 0);
  assert(state.failures.every(error => error.name === 'ResourceLimitError'));
  assert.equal(state.page.requests.size, 2, 'pinned redirect metadata is never silently dropped');
  state.close();
}
{
  const state = fixture();
  state.request('first', 30 * mebibyte); state.finish('first', true);
  state.request('active', 1, 'first');
  state.request('disposable', 32 * mebibyte); state.finish('disposable');
  state.request('newest', 4 * mebibyte); state.finish('newest');
  assert.equal(state.failures.length, 0);
  assert(state.page.requests.has('first'), 'an active redirect successor still retains its predecessor');
  assert(!state.page.requests.has('disposable'));
  state.close();
}
console.log('Four controlled history cases passed: whole redirect chains, lazy headers, pinned overflow and active successors.');
