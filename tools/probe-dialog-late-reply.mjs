import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { sourceManifest } from './source-manifest.mjs';
import { identifyBrowser } from './browser-identity.mjs';
import { runtimeMetadata } from './javascript-runtime.mjs';

const require = createRequire(import.meta.url);
const implementation = process.argv.includes('--candidate') ? 'flashwright' : 'playwright';
const { chromium } = require(implementation);
const output = resolve(process.argv[2]); await mkdir(output);
const wireDirectory = join(output, 'wire'); await mkdir(wireDirectory);
process.env.FLASHWRIGHT_PROFILE_BROWSER_PATH = process.env.FLASHWRIGHT_BROWSER_PATH;
process.env.FLASHWRIGHT_PROFILE_PROTOCOL_DIRECTORY = wireDirectory;
process.env.FLASHWRIGHT_PROFILE_CLOCK_PORT = '0';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const report = { status: 'running', implementation, ...runtimeMetadata, sourceHashes: await sourceManifest(), browser: await identifyBrowser(process.env.FLASHWRIGHT_BROWSER_PATH) };
if (implementation === 'flashwright') report.driverSha256 = hash(await readFile(process.env.FLASHWRIGHT_DRIVER_PATH));
const save = () => writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
await save();
let browser;
try {
  browser = await chromium.launch({ executablePath: resolve('tools/dialog-late-reply-proxy.py') });
  const page = await browser.newPage();
  const firstWait = page.waitForEvent('dialog');
  const evaluation = page.evaluate(() => [confirm('first occurrence'), confirm('successor occurrence')]);
  void evaluation.catch(() => {});
  const first = await firstWait;
  const secondWait = page.waitForEvent('dialog');
  let handlingSettled = false;
  const firstHandling = first.accept().then(() => { handlingSettled = true; });
  void firstHandling.catch(() => {});
  const second = await secondWait;
  for (const deadline = performance.now() + 5000; ;) {
    try { await readFile(join(wireDirectory, 'held.json')); break; }
    catch (error) { if (error.code !== 'ENOENT' || performance.now() >= deadline) throw error; await delay(10); }
  }
  assert.equal(handlingSettled, false);
  assert.equal(first.message(), 'first occurrence');
  assert.equal(second.message(), 'successor occurrence');
  assert.notEqual(first, second);
  await writeFile(join(wireDirectory, 'release'), 'release original reply\n');
  await firstHandling;
  await assert.rejects(first.dismiss(), /already handled/);
  await second.accept();
  report.values = await evaluation;
  assert.deepEqual(report.values, [true, true]);
  assert.equal(await page.evaluate(() => 42), 42);
  const readWire = async () => (await Promise.all((await readdir(wireDirectory)).filter(name => name.endsWith('.jsonl')).map(async name => (await readFile(join(wireDirectory, name), 'utf8')).trim().split('\n').map(line => JSON.parse(line))))).flat();
  let records;
  for (const deadline = performance.now() + 5000; ;) {
    records = await readWire();
    if (records.some(record => record.kind === 'releasedReply')) break;
    assert.ok(performance.now() < deadline, 'proxy release record missing'); await delay(10);
  }
  const held = records.filter(record => record.kind === 'heldReply');
  const released = records.filter(record => record.kind === 'releasedReply');
  assert.equal(held.length, 1); assert.equal(released.length, 1);
  assert.equal(held[0].rawBase64, released[0].rawBase64);
  const receivedDialogs = records.filter(record => record.kind === 'dialogWire' && record.direction === 'receive').map(record => JSON.parse(Buffer.from(record.rawBase64, 'base64')));
  assert.equal(receivedDialogs.filter(record => record.method === 'Page.javascriptDialogOpening').length, 2);
  assert.equal(receivedDialogs.filter(record => record.method === 'Page.javascriptDialogClosed').length, 2);
  report.originalReplySha256 = hash(Buffer.from(held[0].rawBase64, 'base64'));
  report.observations = { firstReplyHeldUntilSuccessorObserved: true, exactReplyBytesReleased: true, duplicateOriginalRejected: true, successorHandledAfterOriginalReply: true };
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = error.stack ?? String(error); process.exitCode = 1; }
finally {
  await writeFile(join(wireDirectory, 'release'), 'cleanup\n');
  try { await browser?.close(); }
  catch (error) { report.status = 'failed'; report.cleanupError = error.stack ?? String(error); process.exitCode = 1; }
  assert.deepEqual(await sourceManifest(), report.sourceHashes);
  if (report.driverSha256) assert.equal(hash(await readFile(process.env.FLASHWRIGHT_DRIVER_PATH)), report.driverSha256);
  await save(); console.log(JSON.stringify({ status: report.status, implementation, observations: report.observations, error: report.error }));
}
