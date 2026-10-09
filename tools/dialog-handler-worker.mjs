import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { identifyBrowser } from './browser-identity.mjs';
import { runtimeMetadata } from './javascript-runtime.mjs';
import { sourceManifest } from './source-manifest.mjs';

// Run each owner/failure combination in its own externally supervised process.
const require = createRequire(import.meta.url);
const implementation = process.argv.includes('--candidate') ? 'flashwright' : 'playwright';
const option = name => process.argv[process.argv.indexOf(name) + 1];
const owner = option('--owner');
const failureMode = option('--failure');
assert(['page', 'context'].includes(owner));
assert(['sync', 'async'].includes(failureMode));
assert(process.argv[2] && process.env.FLASHWRIGHT_BROWSER_PATH, 'report directory and explicit browser are required');
const output = resolve(process.argv[2]);
await mkdir(output);
const { chromium } = require(implementation);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const expectedMessage = 'deliberate dialog handler failure';
const report = { status: 'running', implementation, owner, failureMode, ...runtimeMetadata, scope: 'Isolated user-handler failure semantics; no crash, beforeunload or performance claim.' };
const errors = [];
let resolveFailure;
const handlerFailure = new Promise(resolve => { resolveFailure = resolve; });
const recordFailure = (channel, error) => {
  errors.push({ channel, message: error?.message ?? String(error) });
  resolveFailure();
};
const onUncaughtException = error => recordFailure('uncaughtException', error);
const onUnhandledRejection = error => recordFailure('unhandledRejection', error);
process.on('uncaughtException', onUncaughtException);
process.on('unhandledRejection', onUnhandledRejection);
let browser;
let timer;
try {
  report.sourceHashes = await sourceManifest();
  report.browser = await identifyBrowser(process.env.FLASHWRIGHT_BROWSER_PATH);
  if (implementation === 'flashwright') {
    assert(process.env.FLASHWRIGHT_DRIVER_PATH, 'an explicit candidate driver is required');
    report.driverSha256 = hash(await readFile(process.env.FLASHWRIGHT_DRIVER_PATH));
  }
  browser = await chromium.launch({ executablePath: process.env.FLASHWRIGHT_BROWSER_PATH });
  const context = await browser.newContext();
  const page = await context.newPage();
  let dialog;
  let laterPageCalls = 0;
  (owner === 'page' ? page : context).once('dialog', value => {
    dialog = value;
    const error = new Error(expectedMessage);
    if (failureMode === 'sync') throw error;
    return Promise.reject(error);
  });
  page.on('dialog', () => { laterPageCalls++; });
  let settled = false;
  const operation = page.evaluate(() => confirm('handler failure')).then(
    value => { settled = true; return { status: 'fulfilled', value }; },
    error => { settled = true; return { status: 'rejected', error }; },
  );
  await Promise.race([
    handlerFailure,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Expected application handler failure was not observed')), 3000); }),
  ]);
  clearTimeout(timer);
  assert(dialog);
  assert.equal(dialog.page(), page);
  assert.equal(settled, false, 'a rejected handler must not automatically release its dialog');
  assert.equal(laterPageCalls, failureMode === 'sync' ? 0 : 1);
  assert.deepEqual(errors, [{ channel: failureMode === 'sync' ? 'uncaughtException' : 'unhandledRejection', message: expectedMessage }]);
  await dialog.dismiss();
  assert.deepEqual(await operation, { status: 'fulfilled', value: false });
  assert.equal(await page.evaluate(() => 42), 42);
  report.applicationFailures = errors;
  report.laterPageCalls = laterPageCalls;
  report.originalDialogReleasedExplicitly = true;
  await context.close();
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = error.stack ?? String(error); process.exitCode = 1; }
finally {
  clearTimeout(timer);
  try { await browser?.close(); }
  catch (error) { report.status = 'failed'; report.cleanupError = error.stack ?? String(error); process.exitCode = 1; }
  try {
    if (report.sourceHashes) assert.deepEqual(await sourceManifest(), report.sourceHashes);
    if (report.browser) assert.deepEqual(await identifyBrowser(process.env.FLASHWRIGHT_BROWSER_PATH), report.browser);
    if (report.driverSha256) assert.equal(hash(await readFile(process.env.FLASHWRIGHT_DRIVER_PATH)), report.driverSha256);
    assert.equal(errors.length, 1, 'an isolated case must not conceal additional application failures');
  } catch (error) { report.status = 'failed'; report.verificationError = error.stack ?? String(error); process.exitCode = 1; }
  process.off('uncaughtException', onUncaughtException);
  process.off('unhandledRejection', onUnhandledRejection);
  report.applicationFailures = errors;
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, implementation, owner, failureMode, error: report.error, verificationError: report.verificationError }));
}
