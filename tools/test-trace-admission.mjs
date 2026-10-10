import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createRuntimeFixture } from './runtime-fixture.mjs';
import { EngineClient } from '../packages/flashwright-core/dist/commonjs/client.js';
import { TraceAdmission } from '../packages/flashwright-core/dist/commonjs/trace-admission.js';
import { failure } from '../packages/flashwright-core/dist/commonjs/errors.js';

if (process.argv[2]) await mkdir(dirname(process.argv[2]), { recursive: true });
const executable = createRuntimeFixture('compatibility/m1/dialog-admission-driver.mjs');
const report = { status: 'running', checks: [] };
async function check(name, callback) { await callback(); report.checks.push(name); }
async function transport(capacity, callback) {
  const previous = process.env.FLASHWRIGHT_DIALOG_TEST_CAPACITY;
  process.env.FLASHWRIGHT_DIALOG_TEST_CAPACITY = String(capacity);
  const client = new EngineClient(executable); client.retain();
  if (previous === undefined) delete process.env.FLASHWRIGHT_DIALOG_TEST_CAPACITY;
  else process.env.FLASHWRIGHT_DIALOG_TEST_CAPACITY = previous;
  try { await client.waitForHandshake(); await callback(client); }
  finally { await client.release(); }
}

try {
  await check('public admission wins over earlier optional work while recovery retains its slot', () => transport(2, async client => {
    const activity = client.request('context.trace.filmstrip.activity', { hold: true });
    const pull = client.request('context.trace.pull', {});
    const ordinary = client.request('page.evaluate', {});
    await assert.rejects(client.request('page.evaluate', {}), { name: 'ResourceLimitError' });
    const recovery = await client.request('dialog.dismiss', { flush: true });
    assert.deepEqual(recovery, ['context.trace.filmstrip.activity', 'dialog.dismiss']);
    await activity;
    assert.deepEqual(await ordinary, ['context.trace.filmstrip.activity', 'dialog.dismiss', 'page.evaluate']);
    assert.deepEqual(await pull, ['context.trace.filmstrip.activity', 'dialog.dismiss', 'page.evaluate', 'context.trace.pull']);
  }));
  await check('trace pulls wait behind real ordinary pressure without widening the public quota', () => transport(2, async client => {
    const ordinary = client.request('page.evaluate', { hold: true });
    const pull = client.request('context.trace.pull', {});
    await assert.rejects(client.request('page.evaluate', {}), { name: 'ResourceLimitError' });
    await client.request('dialog.dismiss', { flush: true });
    await ordinary;
    assert.deepEqual(await pull, ['page.evaluate', 'dialog.dismiss', 'context.trace.pull']);
  }));
  await check('a queued public deadline expires without dispatch and returns its waiting quota', () => transport(2, async client => {
    const activity = client.request('context.trace.filmstrip.activity', { hold: true });
    await assert.rejects(client.request('page.evaluate', {}, 25), { name: 'TimeoutError' });
    const ordinary = client.request('page.evaluate', {});
    await client.request('dialog.dismiss', { flush: true });
    await activity;
    assert.deepEqual(await ordinary, ['context.trace.filmstrip.activity', 'dialog.dismiss', 'page.evaluate']);
  }));
  await check('an optional deadline cannot cancel or replace the admitted public operation', () => transport(2, async client => {
    const ordinary = client.request('page.evaluate', { hold: true });
    await assert.rejects(client.request('context.trace.pull', {}, 25), { name: 'TimeoutError' });
    const recovery = await client.request('dialog.dismiss', { flush: true });
    assert.deepEqual(recovery, ['page.evaluate', 'dialog.dismiss']);
    await ordinary;
    assert.deepEqual(await client.request('page.evaluate', {}), ['page.evaluate', 'dialog.dismiss', 'page.evaluate']);
  }));
  await check('recovery pressure still counts when deciding whether trace work caused exhaustion', () => transport(20, async client => {
    const activity = client.request('context.trace.filmstrip.activity', { hold: true });
    const closures = Array.from({ length: 4 }, () => client.request('page.close', { hold: true }));
    await assert.rejects(client.request('page.evaluate', {}), { name: 'ResourceLimitError' });
    await client.request('browser.close', { flush: true });
    await Promise.all([activity, ...closures]);
  }));
  await check('the optional queue is bounded independently of ordinary and recovery calls', () => transport(2, async client => {
    const ordinary = client.request('page.evaluate', { hold: true });
    const pulls = Array.from({ length: 128 }, () => client.request('context.trace.pull', {}));
    await assert.rejects(client.request('context.trace.pull', {}), /trace admission queue is full/);
    await client.request('dialog.dismiss', { flush: true });
    await ordinary; await Promise.all(pulls);
    assert.equal(client.pending.size, 0);
  }));
  await check('transport failure preserves its original error for both active and queued owners', () => transport(2, async client => {
    const original = failure('ProtocolError', 'test', 'original transport failure');
    const active = assert.rejects(client.request('page.evaluate', { hold: true }), error => error === original);
    const queued = assert.rejects(client.request('context.trace.pull', {}), error => error === original);
    await assert.rejects(client.request('page.evaluate', {}), { name: 'ResourceLimitError' });
    client.rejectProtocol(original);
    await Promise.all([active, queued]);
    assert.equal(client.pending.size, 0);
    assert.equal(client.traceAdmission.traceWaiters.size, 0);
  }));
  await check('collection releases capture bytes within the same total while public recovery wins the next slot', () => transport(2, async client => {
    const ordinary = client.request('page.evaluate', { hold: true });
    const collection = client.request('context.trace.snapshot.take', { releaseAfter: 30 });
    const nextCollection = client.request('context.trace.snapshot.ingested', {});
    const recovery = client.request('dialog.dismiss', { flush: true });
    assert.deepEqual(await collection, ['page.evaluate', 'context.trace.snapshot.take']);
    assert.deepEqual(await recovery, ['page.evaluate', 'context.trace.snapshot.take', 'dialog.dismiss']);
    await ordinary;
    assert.deepEqual(await nextCollection, ['page.evaluate', 'context.trace.snapshot.take', 'dialog.dismiss', 'context.trace.snapshot.ingested']);
  }));
  await check('cancelled queued trace collection never enters native dispatch', () => transport(2, async client => {
    const ordinary = client.request('page.evaluate', { hold: true });
    const collection = client.request('context.trace.snapshot.pull', { releaseAfter: 30 });
    const cancellation = new AbortController();
    const cancelled = client.request('apiRequest.traceBody.take', {}, 2000, false, undefined, undefined, undefined, cancellation.signal);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(client.traceAdmission.collectionWaiters.size, 1);
    cancellation.abort(new Error('cancel queued original API trace transfer'));
    await collection;
    await assert.rejects(cancelled, error => error === cancellation.signal.reason);
    const accepted = await client.request('dialog.dismiss', { flush: true });
    await ordinary;
    assert.deepEqual(accepted, ['page.evaluate', 'context.trace.snapshot.pull', 'dialog.dismiss']);
    assert.equal(client.pending.size, 0);
  }));
  await check('a queued listener control preserves its ordering and does not fail because collection occupies recovery', () => transport(2, async client => {
    const ordinary = client.request('page.evaluate', { hold: true });
    const collection = client.request('context.trace.network.pull', { releaseAfter: 30 });
    const control = client.request('page.dialog.subscribe', { page: 'page', enabled: false });
    const handling = client.request('dialog.dismiss', { flush: true });
    await collection; await control;
    assert.deepEqual(await handling, ['page.evaluate', 'context.trace.network.pull', 'page.dialog.subscribe', 'dialog.dismiss']);
    await ordinary;
    assert.equal(client.isClosed(), false);
  }));
  await check('recovery waiters cannot borrow renderer-dependent trace capacity', async () => {
    const active = new Set(['trace', 'collection', 'first-recovery', 'second-recovery']);
    const admission = new TraceAdmission(4, 1, 8, () => active.size, () => ({ total: active.size, trace: Number(active.has('trace')) + Number(active.has('collection')), collection: Number(active.has('collection')) }));
    const recovery = admission.run('recovery', 'page.close', undefined, () => { active.add('third-recovery'); return Promise.resolve(); });
    assert.throws(() => admission.run('recovery', 'context.close', undefined, () => Promise.resolve()), { name: 'ResourceLimitError' });
    active.delete('collection'); admission.capacityChanged(); await recovery;
    assert.equal(active.size, 4);
  });
  await check('public replacement and recovery can each wait for their distinct optional owner', async () => {
    const active = new Set(['trace', 'collection']); const order = [];
    const admission = new TraceAdmission(2, 1, 8, () => active.size, () => ({ total: active.size, trace: Number(active.has('trace')) + Number(active.has('collection')), collection: Number(active.has('collection')) }));
    const ordinary = admission.run('ordinary', 'page.evaluate', undefined, () => { active.add('ordinary'); order.push('ordinary'); return Promise.resolve(); });
    const recovery = admission.run('recovery', 'dialog.dismiss', undefined, () => { active.add('recovery'); order.push('recovery'); return Promise.resolve(); });
    active.delete('collection'); admission.capacityChanged(); await recovery;
    assert.deepEqual(order, ['recovery']);
    active.delete('recovery'); active.delete('trace'); admission.capacityChanged(); await ordinary;
    assert.deepEqual(order, ['recovery', 'ordinary']);
  });
  await check('queued recovery deadlines neither dispatch nor reserve a successor collection slot', () => transport(2, async client => {
    const ordinary = client.request('page.evaluate', { hold: true });
    const collection = client.request('context.trace.snapshot.pull', { releaseAfter: 60 });
    await assert.rejects(client.request('page.close', {}, 20), { name: 'TimeoutError' });
    const recovery = client.request('dialog.dismiss', { flush: true });
    await collection;
    assert.deepEqual(await recovery, ['page.evaluate', 'context.trace.snapshot.pull', 'dialog.dismiss']);
    await ordinary;
  }));
  await check('capacity notification inserts the public command before later recovery can overtake it', async () => {
    const active = new Set(['trace']); const order = [];
    const admission = new TraceAdmission(2, 1, 4, () => active.size, () => ({ total: active.size, trace: Number(active.has('trace')) }));
    const publicCall = admission.run('ordinary', 'page.evaluate', undefined, () => { active.add('public'); order.push('public'); return Promise.resolve('public result'); });
    active.delete('trace'); admission.capacityChanged();
    const recovery = admission.run('recovery', 'dialog.dismiss', undefined, () => { active.add('recovery'); order.push('recovery'); return Promise.resolve(); });
    assert.deepEqual(order, ['public', 'recovery']);
    assert.equal(await publicCall, 'public result'); await recovery;
  });
  await check('a delayed timeout callback cannot let an expired grant dispatch', async () => {
    let pending = 1; let dispatched = false;
    const admission = new TraceAdmission(2, 1, 4, () => pending, () => ({ total: pending, trace: pending }));
    const deadline = performance.now() + 5;
    const result = assert.rejects(admission.run('ordinary', 'page.evaluate', deadline, () => { dispatched = true; return Promise.resolve(); }), { name: 'TimeoutError' });
    // Deliberately hold the event loop so capacity notification runs before the timer callback.
    while (performance.now() < deadline + 1) {}
    pending = 0; admission.capacityChanged(); await result;
    assert.equal(dispatched, false);
  });
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = error.stack ?? String(error); process.exitCode = 1; }
finally { if (process.argv[2]) await writeFile(process.argv[2], JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify(report, null, 2)); }
