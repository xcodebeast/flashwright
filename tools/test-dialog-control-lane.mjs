import assert from 'node:assert/strict';
import { EventControlLane } from '../packages/flashwright-core/dist/commonjs/event-control-lane.js';
import { EngineClient } from '../packages/flashwright-core/dist/commonjs/client.js';
import { createRuntimeFixture } from './runtime-fixture.mjs';

const observe = promise => promise.then(value => ({ status: 'fulfilled', value }), error => ({ status: 'rejected', error }));
let checks = 0;
{
  const lane = new EventControlLane();
  const control = lane.reserve('page.dialog.subscribe', 3);
  const handling = lane.reserve('dialog.accept', 3);
  const following = lane.reserve('page.dialog.subscribe', 3);
  let followingReady = false;
  void following.predecessor.then(() => { followingReady = true; });
  control.complete(); await handling.predecessor;
  assert.equal(followingReady, false);
  handling.complete(); await following.predecessor;
  assert.equal(followingReady, true);
  following.complete(); await lane.predecessor();
  assert.equal(lane.predecessor(), undefined);
  checks++;
}
{
  const lane = new EventControlLane();
  const first = lane.reserve('page.dialog.subscribe', 3);
  const expired = lane.reserve('dialog.accept', 3);
  const following = lane.reserve('context.dialog.subscribe', 3);
  expired.complete(); following.complete();
  await new Promise(resolve => setImmediate(resolve));
  assert.throws(() => lane.reserve('page.dialog.subscribe', 3), { name: 'ResourceLimitError' });
  const tail = lane.predecessor(); first.complete(); await tail;
  const next = lane.reserve('dialog.dismiss', 3); next.complete(); await lane.predecessor();
  checks++;
}
{
  const lane = new EventControlLane();
  const control = lane.reserve('page.dialog.subscribe', 3);
  const handling = lane.reserve('dialog.accept', 3);
  const following = lane.reserve('context.dialog.subscribe', 3);
  const original = new Error('original control failure');
  control.fail(original);
  await assert.rejects(handling.predecessor, error => error === original);
  handling.complete();
  await assert.rejects(following.predecessor, error => error === original);
  const tail = lane.predecessor(); following.complete();
  await assert.rejects(tail, error => error === original);
  assert.equal(lane.predecessor(), undefined);
  checks++;
}

const executable = createRuntimeFixture('compatibility/m1/dialog-admission-driver.mjs');
async function scenario(capacity, callback) {
  const previous = process.env.FLASHWRIGHT_DIALOG_TEST_CAPACITY;
  process.env.FLASHWRIGHT_DIALOG_TEST_CAPACITY = String(capacity);
  const client = new EngineClient(executable); client.retain();
  if (previous === undefined) delete process.env.FLASHWRIGHT_DIALOG_TEST_CAPACITY; else process.env.FLASHWRIGHT_DIALOG_TEST_CAPACITY = previous;
  try { await client.waitForHandshake(); await callback(client); checks++; }
  finally { await client.release(); }
}

// A late handling reply does not serialize a later control/handler when capacity remains.
await scenario(20, async client => {
  const held = observe(client.request('dialog.accept', { hold: true }));
  await client.request('page.dialog.subscribe', { page: 'page', enabled: false });
  const accepted = await client.request('dialog.dismiss', { flush: true });
  assert.deepEqual(accepted, ['dialog.accept', 'page.dialog.subscribe', 'dialog.dismiss']);
  assert.equal((await held).status, 'fulfilled');
});

// Expiry behind a held control cannot dispatch later or reopen admission into uncertain state.
await scenario(2, async client => {
  const control = observe(client.request('page.dialog.subscribe', { page: 'page', enabled: false, hold: true }));
  const handling = observe(client.request('dialog.accept', {}, 30));
  const outcome = await handling;
  assert.equal(outcome.status, 'rejected'); assert.equal(outcome.error.name, 'TimeoutError');
  const accepted = await client.request('browser.close', { flush: true });
  assert.deepEqual(accepted, ['page.dialog.subscribe', 'browser.close']);
  assert.equal((await control).status, 'fulfilled');
  assert.deepEqual(await client.request('probe.observations', {}), ['page.dialog.subscribe', 'browser.close', 'probe.observations']);
});

// Capacity-wait cancellation retires the waiter and explicitly settles every queued follower.
await scenario(2, async client => {
  async function heldEvaluation() { return await client.request('page.evaluate', { hold: true }); }
  async function heldHandling() { return await client.request('dialog.accept', { hold: true }); }
  const evaluation = observe(heldEvaluation());
  const handling = observe(heldHandling());
  const control = observe(client.request('page.dialog.subscribe', { page: 'page', enabled: false }, 30));
  const following = observe(client.request('dialog.dismiss', {}, 1000));
  const outcome = await control;
  assert.equal(outcome.status, 'rejected'); assert.equal(outcome.error.name, 'TimeoutError');
  for (const [pending, caller] of [[evaluation, 'heldEvaluation'], [handling, 'heldHandling'], [following, undefined]]) {
    const result = await pending;
    assert.equal(result.status, 'rejected');
    assert.equal(Object.getPrototypeOf(result.error), Object.getPrototypeOf(outcome.error));
    assert.equal(result.error.name, outcome.error.name);
    assert.equal(result.error.message, outcome.error.message);
    assert.equal(result.error.details, outcome.error.details);
    if (caller) {
      assert.notEqual(result.error, outcome.error, 'A dispatched request owns its captured caller');
      assert.ok(result.error.stack.includes(`at ${caller} (`), result.error.stack);
    } else {
      assert.equal(result.error, outcome.error, 'A queued control predecessor retains the original rejection');
    }
  }
  assert.equal(client.isClosed(), true);
  assert.equal(client.controlCapacityWaiters.size, 0);
});
// Synchronous subscription changes precede an immediately invoked trigger at the two-slot minimum.
await scenario(2, async client => {
  client.setConsoleSubscription('page', 'page', true);
  client.setDialogSubscription('page', 'page', true);
  assert.deepEqual(await client.request('page.evaluate', {}), ['page.console.subscribe', 'page.dialog.subscribe', 'page.evaluate']);
});

// A final console listener can disappear while its trigger remains blocked by a JavaScript modal.
await scenario(2, async client => {
  const evaluation = client.request('page.evaluate', { hold: true });
  client.setConsoleSubscription('page', 'page', false);
  client.setConsoleSubscription('context', 'context', false);
  const handled = await client.request('dialog.accept', { flush: true });
  await evaluation;
  assert.deepEqual(handled, ['page.evaluate', 'page.console.subscribe', 'context.console.subscribe', 'dialog.accept']);
  assert.equal(client.isClosed(), false);
});

// A pending original handling reply may free the control slot without releasing the renderer.
await scenario(2, async client => {
  const evaluation = client.request('page.evaluate', { hold: true });
  const firstHandling = client.request('dialog.accept', { releaseAfter: 30 });
  const unsubscribed = await client.request('page.console.subscribe', { page: 'page', enabled: false });
  assert.deepEqual(unsubscribed, ['page.evaluate', 'dialog.accept', 'page.console.subscribe']);
  await firstHandling;
  await client.request('dialog.dismiss', { flush: true });
  await evaluation;
  assert.equal(client.controlCapacityWaiters.size, 0);
});
console.log(JSON.stringify({ status: 'passed', checks, scope: 'Bounded dialog/console control tickets, trigger ordering, independent handling replies, deadlines and failed-predecessor settlement.' }));
