import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { sourceManifest } from './source-manifest.mjs';
import { runtimeMetadata } from './javascript-runtime.mjs';
import { createRuntimeFixture } from './runtime-fixture.mjs';
import { EngineClient } from '../packages/flashwright-core/dist/commonjs/client.js';
import { Dialog, receivedDialog, handleUnobservedDialog } from '../packages/flashwright-core/dist/commonjs/dialog.js';
import { failure } from '../packages/flashwright-core/dist/commonjs/errors.js';
import { BrowserContext, Page } from '../packages/flashwright-core/dist/commonjs/index.js';

const output = process.argv[2] ? resolve(process.argv[2]) : undefined;
const report = { status: 'running', ...runtimeMetadata, scope: 'Controlled dialog host ownership and real transport admission; no Chromium behavior claim.' };
const compiledHashes = async () => Object.fromEntries(await Promise.all((await readdir('packages/flashwright-core/dist/commonjs')).filter(name => name.endsWith('.js') || name.endsWith('.cjs')).sort().map(async name => [name, createHash('sha256').update(await readFile(join('packages/flashwright-core/dist/commonjs', name))).digest('hex')])));

if (output) {
  await mkdir(output);
  report.sourceHashes = await sourceManifest();
  report.compiledHashes = await compiledHashes();
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
}

const executable = createRuntimeFixture('compatibility/m1/dialog-admission-driver.mjs');
let checks = 0;
async function scenario(capacity, run) {
  const previous = process.env.FLASHWRIGHT_DIALOG_TEST_CAPACITY;
  process.env.FLASHWRIGHT_DIALOG_TEST_CAPACITY = String(capacity);
  const client = new EngineClient(executable); client.retain();
  if (previous === undefined) delete process.env.FLASHWRIGHT_DIALOG_TEST_CAPACITY;
  else process.env.FLASHWRIGHT_DIALOG_TEST_CAPACITY = previous;
  try { await run(client); checks++; } finally { await client.release(); }
}
for (const capacity of [2, 17, 20]) {
  await scenario(capacity, async client => {
    await client.waitForHandshake();
    const ordinaryLimit = capacity - Math.min(16, capacity - 1);
    const pending = Array.from({ length: ordinaryLimit }, () => client.request('page.evaluate', { hold: true }));
    await assert.rejects(client.request('page.evaluate', {}), { name: 'ResourceLimitError' });
    await assert.rejects(client.request('dialog.accept.extra', {}), { name: 'ResourceLimitError' });
    const accepted = await client.request('dialog.dismiss', { flush: true });
    await Promise.all(pending);
    assert.deepEqual(accepted, [...Array(ordinaryLimit).fill('page.evaluate'), 'dialog.dismiss']);
  });
  await scenario(capacity, async client => {
    await client.waitForHandshake();
    const ordinaryLimit = capacity - Math.min(16, capacity - 1);
    const pending = [client.request('dialog.accept', { hold: true })];
    for (let index = 1; index < ordinaryLimit; index++) pending.push(client.request('page.evaluate', { hold: true }));
    await assert.rejects(client.request('page.evaluate', {}), { name: 'ResourceLimitError' });
    for (let index = ordinaryLimit; index < capacity - 1; index++) pending.push(client.request('page.close', { hold: true }));
    const recovery = client.request('dialog.dismiss', { flush: true });
    await assert.rejects(client.request('browser.close', {}), { name: 'ResourceLimitError' });
    assert.equal((await recovery).length, capacity);
    await Promise.all(pending);
  });
}
await scenario(1, async client => {
  await assert.rejects(client.waitForHandshake(), /at least two pending operation slots/);
});
await scenario(18, async client => {
  await client.waitForHandshake();
  client.setFileChooserSubscription('page', true);
  const ordinary = client.request('page.evaluate', { page: 'page' });
  const recovery = await client.request('dialog.dismiss', { page: 'page', flush: true });
  assert.deepEqual(recovery, ['page.fileChooser.subscribe', 'dialog.dismiss']);
  assert.deepEqual(await ordinary, ['page.fileChooser.subscribe', 'dialog.dismiss', 'page.evaluate']);
});
await scenario(3, async client => {
  await client.waitForHandshake();
  client.setFileChooserSubscription('page', true);
  const ordinary = assert.rejects(client.request('page.evaluate', { page: 'page' }), { name: 'ResourceLimitError' });
  const recovery = client.request('dialog.dismiss', { page: 'page', flush: true, holdReply: true });
  await ordinary;
  const accepted = await client.request('browser.close', { flush: true });
  await recovery;
  assert.deepEqual(accepted, ['page.fileChooser.subscribe', 'dialog.dismiss', 'browser.close']);
});

function fixture() {
  const commands = [];
  let closed = false;
  let rejection;
  const client = { async request(method, parameters) { commands.push({ method, parameters }); if (rejection && method !== 'page.close') throw rejection; } };
  const page = { isClosed: () => closed };
  const dialog = receivedDialog(page, client, { page: 'original-page', dialog: 'original-dialog', dialogJson: JSON.stringify({ type: 'prompt', message: '\ud800\u0000\udfff', defaultPrompt: '\udffe' }) });
  return { commands, client, page, dialog, close: () => { closed = true; }, reject: error => { rejection = error; } };
}
{
  const state = fixture();
  assert.equal(state.dialog.page(), state.page);
  assert.equal(state.dialog.message(), '\ud800\u0000\udfff');
  assert.equal(state.dialog.defaultValue(), '\udffe');
  await assert.rejects(state.dialog.accept(42), { name: 'InvalidArgumentError' });
  const first = state.dialog.accept('\ud800');
  await assert.rejects(state.dialog.dismiss(), /already handled/);
  await first;
  assert.deepEqual(state.commands, [{ method: 'dialog.accept', parameters: { page: 'original-page', dialog: 'original-dialog', promptTextJson: '"\\ud800"' } }]);
  checks++;
}
{
  const state = fixture();
  state.reject(failure('ResourceLimitError', 'dialog.accept', 'no admission'));
  await assert.rejects(state.dialog.accept(), { name: 'ResourceLimitError' });
  state.reject(undefined);
  await assert.rejects(state.dialog.dismiss(), /already handled/);
  assert.equal(state.commands.length, 2);
  assert.equal(state.commands[1].method, 'page.close');
  checks++;
}
{
  const state = fixture();
  const error = failure('ResourceLimitError', 'dialog.accept', 'claimed owner retired'); error.details.cleanup = 'resourceDisposed';
  state.reject(error);
  await assert.rejects(state.dialog.accept(), error);
  await assert.rejects(state.dialog.accept(), /already handled/);
  assert.equal(state.commands.length, 1);
  checks++;
}
{
  const state = fixture(); state.close();
  await state.dialog.dismiss();
  await assert.rejects(state.dialog.accept(), { name: 'TargetClosedError' });
  assert.equal(state.dialog.message(), '\ud800\u0000\udfff');
  assert.equal(state.commands.length, 0);
  checks++;
}
{
  let rejected;
  const client = { request: async () => { throw failure('ResourceLimitError', 'dialog.dismiss', 'full recovery lane'); }, rejectProtocol: error => { rejected = error; } };
  handleUnobservedDialog(new Dialog(null, client, 'page', 'dialog', 'confirm', 'message', ''), client);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(rejected?.name, 'ResourceLimitError');
  assert.equal(rejected?.details.cleanup, 'guardianContinuingCleanup');
  checks++;
}
{
  const state = fixture();
  state.reject(failure('TargetClosedError', 'dialog.dismiss', 'original target closed'));
  await state.dialog.dismiss();
  await assert.rejects(state.dialog.accept(), { name: 'TargetClosedError' });
  await state.dialog.dismiss();
  assert.equal(state.commands.length, 1);
  checks++;
}
{
  const commands = [];
  const client = { request: async (method, parameters) => { commands.push({ method, parameters }); }, subscribeObject: () => () => {} };
  const context = new BrowserContext(client, 'context', {}, null, undefined);
  const page = new Page(client, 'page', context, false, { mainFrame: 'frame', frames: [], navigationSequence: 0 });
  for (const [closeOptions, name] of [[{ runBeforeUnload: true }, 'UnsupportedFeatureError'], [{ runBeforeUnload: 'false' }, 'InvalidArgumentError'], [{ reason: 'unsupported reason' }, 'UnsupportedFeatureError'], [null, 'InvalidArgumentError']]) {
    await assert.rejects(Promise.resolve().then(() => page.close(closeOptions)), { name });
    assert.equal(page.isClosed(), false);
    assert.equal(commands.length, 0);
  }
  await page.close({ runBeforeUnload: false });
  assert.equal(page.isClosed(), true);
  assert.deepEqual(commands, [{ method: 'page.close', parameters: { page: 'page' } }]);
  context.didClose(); checks++;
}
if (output) {
  assert.deepEqual(await sourceManifest(), report.sourceHashes);
  assert.deepEqual(await compiledHashes(), report.compiledHashes);
  report.status = 'passed'; report.checks = checks;
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
}
console.log(JSON.stringify({ status: 'passed', checks, scope: report.scope }));
