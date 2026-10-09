import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setImmediate } from 'node:timers/promises';

const require = createRequire(resolve('packages/flashwright-runner/package.json'));
const { screenshotPolicy } = require(resolve('packages/flashwright-runner/dist/commonjs/screenshot-policy.js'));
const { ScreenshotLifecycle } = require(resolve('packages/flashwright-runner/dist/commonjs/screenshot-recorder.js'));
const { didCreateRunnerContext, willCloseRunnerContext } = require(resolve('packages/flashwright-core/dist/commonjs/runner-lifecycle.js'));
const { runnerIntegration } = require('@flashwright/core/runner-integration');
const root = await mkdtemp(join(tmpdir(), 'flashwright-screenshot-unit-'));
let nextTest = 0;
function information(status = 'passed', expectedStatus = 'passed') {
  const outputDir = join(root, `test-${++nextTest}`);
  return { status, expectedStatus, retry: 0, project: { outputDir: root }, outputDir, attachments: [], _onDidFinishTestFunctionCallbacks: new Set(), outputPath: name => join(outputDir, name) };
}
function context(pages) {
  const result = new EventEmitter(); result.pages = () => pages; didCreateRunnerContext(result); return result;
}
function page(behavior) {
  return { screenshot: async options => {
    await behavior?.(options);
    await mkdir(resolve(options.path, '..'), { recursive: true });
    await writeFile(options.path, Buffer.from('complete-image'));
    return Buffer.from('complete-image');
  } };
}
async function until(condition) {
  for (let attempt = 0; attempt < 1000; attempt++) { if (condition()) return; await setImmediate(); }
  throw new Error('deterministic screenshot scheduling did not settle');
}
try {
  for (const mode of ['off', 'on', 'only-on-failure', 'on-first-failure']) assert.equal(screenshotPolicy(mode).mode, mode);
  assert.deepEqual(screenshotPolicy({ mode: 'on', fullPage: true, omitBackground: false }).options, { fullPage: true, omitBackground: false });
  for (const invalid of [null, [], 1, false, 'unknown', {}, { mode: 'on', fullPage: 1 }]) assert.throws(() => screenshotPolicy(invalid), error => error.name === 'InvalidArgumentError');
  assert.throws(() => screenshotPolicy({ mode: 'on', mask: [] }), error => error.name === 'UnsupportedFeatureError');
  assert.equal(willCloseRunnerContext(context([])), undefined);
  assert.throws(() => runnerIntegration.installContextLifecycle(2, {}), error => error.name === 'ProtocolError');
  assert.throws(() => runnerIntegration.installContextLifecycle(1, {}), error => error.name === 'ProtocolError');

  let created = 0;
  const uninstall = runnerIntegration.installContextLifecycle(1, { didCreateContext: () => { created++; }, willCloseContext: async () => {} });
  context([]); assert.equal(created, 1);
  assert.throws(() => runnerIntegration.installContextLifecycle(1, { didCreateContext() {}, async willCloseContext() {} }), error => error.name === 'ProtocolError');
  uninstall(); uninstall();
  assert.equal(willCloseRunnerContext(context([])), undefined);

  const { Browser } = require('@flashwright/core');
  const { publicBrowserContexts } = require(resolve('packages/flashwright-core/dist/commonjs/public-browsers.js'));
  const requests = [];
  const client = {
    isClosed: () => false,
    subscribeObject: () => () => {},
    setConsoleSubscription() {},
    async release() {},
    async request(method) {
      requests.push(method);
      if (method === 'browser.newContext') return { identifier: 'existing-context' };
      if (method === 'context.newPage') return { identifier: 'existing-page', frames: [{ identifier: 'main-frame', parent: null, url: 'about:blank', name: '' }], mainFrame: 'main-frame', navigationSequence: 0 };
      return {};
    },
  };
  const publicBrowser = new Browser(client, 'existing-browser', 'test');
  const existingContext = await publicBrowser.newContext();
  await existingContext.newPage();
  assert.deepEqual(requests, ['browser.newContext', 'context.newPage'], 'weak registration adds no native request with screenshot observation off');
  const observed = [];
  const removeExisting = runnerIntegration.installContextLifecycle(1, { didCreateContext: value => observed.push(value), async willCloseContext() {} });
  assert.deepEqual(observed, [existingContext], 'observation enumerates a context created before fixture setup');
  didCreateRunnerContext(existingContext);
  assert.equal(observed.length, 1, 'publication and enumeration use the same identity deduplication');
  assert.deepEqual(requests, ['browser.newContext', 'context.newPage'], 'enumeration itself sends no native request');
  removeExisting();
  await existingContext.close();
  await publicBrowser.close();
  assert.deepEqual(requests, ['browser.newContext', 'context.newPage', 'context.close', 'browser.close'], 'off lifecycle retains the exact direct request sequence');
  assert.deepEqual(publicBrowserContexts(), [], 'disconnect unregisters the browser');

  const lifecycle = new ScreenshotLifecycle(screenshotPolicy('only-on-failure'));
  try {
    const testInfo = information();
    const releases = [];
    let active = 0;
    let maximumActive = 0;
    const pages = Array.from({ length: 6 }, () => page(async options => {
      assert.equal(options.caret, 'initial'); assert.ok(options.timeout > 0 && options.timeout <= 5000);
      maximumActive = Math.max(maximumActive, ++active);
      await new Promise(resolve => releases.push(resolve)); active--;
    }));
    const liveContext = context(pages);
    const recorder = lifecycle.start(testInfo);
    const closing = willCloseRunnerContext(liveContext);
    await until(() => releases.length === 4);
    let finished = false;
    const finishing = lifecycle.finish(recorder).then(() => { finished = true; });
    await setImmediate(); assert.equal(finished, false);
    for (const release of releases.slice()) release();
    await until(() => releases.length === 6);
    assert.equal(finished, false, 'scope finalization must include queued pages, not only the first active batch');
    for (const release of releases.slice(4)) release();
    await closing; await finishing;
    assert.equal(maximumActive, 4);
    assert.equal(testInfo.attachments.length, 0, 'passing scope discards early-close screenshots');
    liveContext.emit('close');
    assert.equal(testInfo._onDidFinishTestFunctionCallbacks.size, 0);
    assert.equal((await readdir(root)).filter(name => name.startsWith('.flashwright-screenshots-')).length, 0);

    const failureInfo = information('failed');
    const originalError = new Error('original capture failure'); originalError.name = 'ExampleCaptureError';
    const failedContext = context([page(async () => { throw originalError; })]);
    const failedRecorder = lifecycle.start(failureInfo);
    await lifecycle.finish(failedRecorder);
    assert.equal(failureInfo.status, 'failed');
    assert.equal(failureInfo.attachments.length, 1);
    assert.equal(failureInfo.attachments[0].name, 'screenshot-error');
    assert.match(failureInfo.attachments[0].body.toString(), /ExampleCaptureError: original capture failure/);
    assert.ok(failureInfo.attachments[0].body.toString().includes('test-runner-screenshots.mjs'));
    failedContext.emit('close');

    const manyErrorsInfo = information('failed');
    const manyErrorsContext = context(Array.from({ length: 40 }, () => page(async () => { throw new Error('bounded original failure'); })));
    const manyErrorsRecorder = lifecycle.start(manyErrorsInfo);
    await lifecycle.finish(manyErrorsRecorder);
    assert.equal(manyErrorsInfo.attachments.length, 1, 'many failed pages share a bounded diagnostic attachment');
    assert.match(manyErrorsInfo.attachments[0].body.toString(), /24 additional screenshot errors omitted/);
    assert.ok(manyErrorsInfo.attachments[0].body.byteLength < 65536);
    assert.equal(manyErrorsInfo.status, 'failed');
    manyErrorsContext.emit('close');

    const retentionInfo = information();
    const retainedContext = context([page()]);
    const retainedRecorder = lifecycle.start(retentionInfo);
    await willCloseRunnerContext(retainedContext); retainedContext.emit('close');
    retentionInfo.status = 'failed';
    await lifecycle.finish(retainedRecorder);
    assert.equal(retentionInfo.attachments.length, 1);
    assert.equal(retentionInfo.attachments[0].name, 'screenshot');
    assert.equal(await readFile(retentionInfo.attachments[0].path, 'utf8'), 'complete-image');
    assert.ok(retentionInfo.attachments[0].path.endsWith('test-failed-1.png'));
  } finally { lifecycle.dispose(); }
  assert.equal(willCloseRunnerContext(context([])), undefined);
  console.log('Screenshot policy, lifecycle identity, bounded concurrency, pending cleanup, outcome retention and error diagnostics passed.');
} finally { await rm(root, { recursive: true, force: true }); }
