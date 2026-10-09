import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { EventEmitter } from 'node:events';
import { Route, RouteRegistry } from '../packages/flashwright-core/dist/commonjs/routing.js';
import { Request } from '../packages/flashwright-core/dist/commonjs/network.js';

function deferred() {
  let resolve;
  const promise = new Promise(settle => { resolve = settle; });
  return { promise, resolve };
}
function fixture() {
  const commands = [];
  const client = {
    async request(method, parameters) { commands.push({ method, parameters }); },
    async requestWithInput(method, parameters, bodies) { commands.push({ method, parameters, bodies }); },
  };
  const page = new EventEmitter(); page.isClosed = () => false;
  const pageRoutes = new RouteRegistry(client, 'page', 'page');
  const contextRoutes = new RouteRegistry(client, 'context', 'context');
  let identity = 0;
  function createRoute(pathname = '/request') {
    const request = new Request(client, 'page', { identifier: 'request', identity: String(++identity), url: 'https://example.test' + pathname, method: 'GET', headers: {}, postDataEntries: null, resourceType: 'Fetch', navigation: false, frame: null, loader: '' });
    const route = new Route(client, 'page', page, request, () => { pageRoutes.finished(route); contextRoutes.finished(route); });
    return route;
  }
  const operations = () => commands.filter(command => command.method.startsWith('route.'));
  return { page, pageRoutes, contextRoutes, createRoute, operations };
}

// Updating a nonempty scope changes future matching without releasing its already running callback.
{
  const state = fixture(), entered = deferred(), release = deferred();
  await state.pageRoutes.route('**/unrelated', route => route.abort());
  await state.pageRoutes.route('**/request', async route => { entered.resolve(); await release.promise; await route.fulfill({ body: 'still owned' }); });
  const dispatch = state.createRoute().dispatch([state.pageRoutes, state.contextRoutes]);
  await entered.promise;
  await state.pageRoutes.unroute('**/unrelated');
  assert.equal(state.operations().length, 0);
  release.resolve(); await dispatch;
  assert.deepEqual(state.operations().map(command => command.method), ['route.fulfill']);
}

// A removed page callback cannot operate a later context handling stage on the same public Route.
{
  const state = fixture(), pageEntered = deferred(), contextEntered = deferred(), releaseOld = deferred(), releaseContext = deferred(), oldDone = deferred();
  let oldError;
  await state.contextRoutes.route('**/*', async route => { contextEntered.resolve(); await releaseContext.promise; await route.fulfill({ body: 'context' }); });
  await state.pageRoutes.route('**/*', async route => {
    pageEntered.resolve(); await releaseOld.promise;
    try { await route.abort(); } catch (error) { oldError = error; } finally { oldDone.resolve(); }
  });
  const dispatch = state.createRoute().dispatch([state.pageRoutes, state.contextRoutes]);
  await pageEntered.promise; await state.pageRoutes.unrouteAll(); await contextEntered.promise;
  releaseOld.resolve(); await oldDone.promise;
  assert.match(oldError.message, /abort: Route is already handled/);
  assert.equal(state.operations().length, 0);
  releaseContext.resolve(); await dispatch;
  // The bypass dispatch is independent of the removed callback's completion.
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(state.operations().map(command => command.method), ['route.fulfill']);
}

{
  const state = fixture(), entered = deferred(), release = deferred();
  await state.pageRoutes.route('**/*', async route => { entered.resolve(); await release.promise; await route.continue(); });
  const dispatch = state.createRoute().dispatch([state.pageRoutes]);
  await entered.promise;
  let removed = false;
  const removal = state.pageRoutes.unrouteAll({ behavior: 'wait' }).then(() => { removed = true; });
  await Promise.resolve(); assert.equal(removed, false);
  release.resolve(); await Promise.all([dispatch, removal]);
  assert.deepEqual(state.operations().map(command => command.method), ['route.continue']);
}

// Registration captures the user's async context; concurrent requests cannot spend a one-shot twice.
{
  const state = fixture(), local = new AsyncLocalStorage(), entered = deferred(), release = deferred();
  let calls = 0;
  await local.run('registration', () => state.pageRoutes.route('**/*', async route => {
    assert.equal(local.getStore(), 'registration'); calls++; entered.resolve(); await release.promise; await route.abort();
  }, { times: 1 }));
  const first = state.createRoute().dispatch([state.pageRoutes]); await entered.promise;
  await local.run('dispatch', () => state.createRoute().dispatch([state.pageRoutes]));
  assert.equal(calls, 1); release.resolve(); await first;
  assert.deepEqual(state.operations().map(command => command.method), ['route.continue', 'route.abort']);
}

{
  const state = fixture(), entered = deferred(), release = deferred();
  const route = state.createRoute();
  await state.pageRoutes.route('**/*', async route => { entered.resolve(); await release.promise; await route.fulfill({ body: 'too late' }); });
  const dispatch = route.dispatch([state.pageRoutes]); await entered.promise;
  route.requestEnded(); release.resolve(); await dispatch;
  assert.equal(state.operations().length, 0);
  assert.equal(state.page.listenerCount('close'), 0);
  assert.equal(state.page.listenerCount('crash'), 0);
}

// Validation does not claim a pause, so the same callback can recover with one valid operation.
{
  const state = fixture();
  await state.pageRoutes.route('**/*', async route => {
    await assert.rejects(route.continue({ headers: { Test: 'bad\nheader' } }), { name: 'InvalidArgumentError' });
    await assert.rejects(route.continue({ url: 'http://example.test/wrong-protocol' }), { name: 'InvalidArgumentError' });
    await route.fallback({ method: 'POST', postData: Buffer.from([255, 0, 128]) });
  });
  await state.createRoute().dispatch([state.pageRoutes]);
  assert.equal(state.operations().length, 1);
  assert.deepEqual(state.operations()[0].bodies, [Buffer.from([255, 0, 128])]);
}
console.log('Six controlled route ownership, removal, callback-context and validation cases passed.');
