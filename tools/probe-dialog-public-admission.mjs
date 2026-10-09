import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { EngineClient } from '../packages/flashwright-core/dist/commonjs/client.js';
import { BrowserContext, Page } from '../packages/flashwright-core/dist/commonjs/index.js';
import { createRuntimeFixture } from './runtime-fixture.mjs';
import { sourceManifest } from './source-manifest.mjs';
import { runtimeMetadata } from './javascript-runtime.mjs';

const output = resolve(process.argv[2]); await mkdir(output);
const report = { status: 'running', ...runtimeMetadata, sourceHashes: await sourceManifest(), cases: [] };
const save = () => writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
await save();
const executable = createRuntimeFixture('compatibility/m1/dialog-public-driver.mjs');
const observe = promise => promise.then(value => ({ status: 'fulfilled', value }), error => ({ status: 'rejected', name: error.name, message: error.message }));
for (const waitForInitialAcknowledgement of [true, false]) for (const laterChurn of [false, true]) for (const registration of ['page.once', 'page.waitForEvent', 'context.waitForEvent', 'context+page.once']) {
  const previous = process.env.FLASHWRIGHT_DIALOG_TEST_CAPACITY;
  process.env.FLASHWRIGHT_DIALOG_TEST_CAPACITY = '2';
  const client = new EngineClient(executable); client.retain();
  if (previous === undefined) delete process.env.FLASHWRIGHT_DIALOG_TEST_CAPACITY; else process.env.FLASHWRIGHT_DIALOG_TEST_CAPACITY = previous;
  const result = { registration, total: 2, waitForInitialAcknowledgement, laterChurn };
  report.cases.push(result);
  try {
    await client.waitForHandshake();
    const context = new BrowserContext(client, 'context', {}, null, undefined);
    const page = new Page(client, 'page', context, false, { identifier: 'page', mainFrame: 'frame', frames: [], navigationSequence: 0 });
    let subscriptionAcknowledged;
    client.subscribeObject('probe', () => { subscriptionAcknowledged?.(); subscriptionAcknowledged = undefined; });
    const nextAcknowledgement = () => new Promise(resolve => { subscriptionAcknowledged = resolve; });
    let handling;
    let dialogWait;
    let contextDialog;
    const handle = dialog => {
      if (contextDialog) assert.equal(dialog, contextDialog);
      handling = observe(dialog.accept());
      if (laterChurn) {
        const listener = () => {};
        for (let index = 0; index < 2; index++) page.on('dialog', listener).off('dialog', listener);
      }
      return handling;
    };
    let acknowledged = nextAcknowledgement();
    if (registration === 'context+page.once') {
      context.once('dialog', dialog => { contextDialog = dialog; });
      if (waitForInitialAcknowledgement) await acknowledged;
      acknowledged = nextAcknowledgement();
    }
    if (registration.endsWith('waitForEvent')) {
      const owner = registration.startsWith('context') ? context : page;
      dialogWait = observe(owner.waitForEvent('dialog', { timeout: 5000 }).then(handle));
    } else page.once('dialog', handle);
    if (waitForInitialAcknowledgement) await acknowledged;
    result.evaluation = await observe(page.evaluate(() => confirm('controlled modal')));
    if (dialogWait) result.waiter = await dialogWait;
    result.handling = handling ? await handling : null;
    result.clientClosed = client.isClosed();
    if (!result.clientClosed) result.driver = await client.request('probe.observations', {});
    page.didClose(); context.didClose();
  } catch (error) { result.error = { name: error.name, message: error.message }; }
  finally { await client.release(); await save(); }
}
assert.deepEqual(await sourceManifest(), report.sourceHashes);
report.status = 'characterized';
if (process.argv.includes('--require-success')) {
  for (const result of report.cases) {
    assert.equal(result.evaluation?.status, 'fulfilled', JSON.stringify(result));
    assert.equal(result.evaluation.value, true, JSON.stringify(result));
    assert.equal(result.handling?.status, 'fulfilled', JSON.stringify(result));
    assert.equal(result.clientClosed, false, JSON.stringify(result));
    assert.ok(result.driver.peakPending <= result.total, JSON.stringify(result));
  }
  report.status = 'passed';
}
await save();
console.log(JSON.stringify({ status: report.status, cases: report.cases }));
