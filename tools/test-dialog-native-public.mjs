import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium } from '../packages/flashwright-core/dist/commonjs/index.js';
import { engineHandshake } from '../packages/flashwright-core/dist/commonjs/engine-contract.js';
import { sourceManifest } from './source-manifest.mjs';
import { runtimeMetadata } from './javascript-runtime.mjs';

const output = resolve(process.argv[2]);
await mkdir(output);
// Change the offered limit before any client exists; both real endpoints negotiate it.
engineHandshake.limits.pendingOperations = 2;
const report = {
  status: 'running', ...runtimeMetadata, pendingOperations: 2,
  sourceHashes: await sourceManifest(),
  driverSha256: createHash('sha256').update(await readFile(process.env.FLASHWRIGHT_DRIVER_PATH)).digest('hex'),
  cases: [],
};
const save = () => writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
const observe = promise => promise.then(value => ({ status: 'fulfilled', value }), error => ({ status: 'rejected', name: error.name, message: error.message }));
await save();
const browser = await chromium.launch({ executablePath: process.env.FLASHWRIGHT_BROWSER_PATH });
try {
  for (const laterChurn of [false, true]) for (const registration of ['page.once', 'page.waitForEvent', 'context.waitForEvent', 'context+page.once']) {
    const context = await browser.newContext();
    const page = await context.newPage();
    let handling;
    let contextDialog;
    let waiter;
    const handle = dialog => {
      assert.equal(dialog.page(), page);
      if (contextDialog) assert.equal(dialog, contextDialog);
      handling = observe(dialog.accept());
      if (laterChurn) {
        const listener = () => {};
        for (let index = 0; index < 2; index++) page.on('dialog', listener).off('dialog', listener);
      }
      return handling;
    };
    if (registration === 'context+page.once') context.once('dialog', dialog => { contextDialog = dialog; });
    if (registration.endsWith('waitForEvent')) {
      const owner = registration.startsWith('context') ? context : page;
      waiter = observe(owner.waitForEvent('dialog', { timeout: 5000 }).then(handle));
    } else page.once('dialog', handle);
    const result = { registration, laterChurn, evaluation: await observe(page.evaluate(() => confirm('native two-slot modal'))) };
    if (waiter) result.waiter = await waiter;
    result.handling = handling ? await handling : null;
    report.cases.push(result);
    await save();
    assert.deepEqual(result.evaluation, { status: 'fulfilled', value: true });
    assert.equal(result.handling?.status, 'fulfilled');
    assert.equal(await page.evaluate(() => 42), 42);
    await context.close();
  }
} finally { await browser.close(); }
assert.deepEqual(await sourceManifest(), report.sourceHashes);
assert.equal(createHash('sha256').update(await readFile(process.env.FLASHWRIGHT_DRIVER_PATH)).digest('hex'), report.driverSha256);
report.status = 'passed'; await save();
console.log(JSON.stringify({ status: report.status, cases: report.cases.length, pendingOperations: 2 }));
