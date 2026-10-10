import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setImmediate } from 'node:timers/promises';

const require = createRequire(resolve('packages/flashwright-runner/package.json'));
const { screenshotPolicy } = require(resolve('packages/flashwright-runner/dist/commonjs/screenshot-policy.js'));
const { ScreenshotLifecycle, ScreenshotScopes } = require(resolve('packages/flashwright-runner/dist/commonjs/screenshot-recorder.js'));
const { didCreateRunnerContext, willCloseRunnerContext } = require(resolve('packages/flashwright-core/dist/commonjs/runner-lifecycle.js'));
const { runnerIntegration } = require('@flashwright/core/runner-integration');
const root = await mkdtemp(join(tmpdir(), 'flashwright-screenshot-unit-'));
let nextTest = 0;
function information(status = 'passed', expectedStatus = 'passed') {
  const outputDir = join(root, `test-${++nextTest}`);
  return { status, expectedStatus, retry: 0, project: { outputDir: root }, outputDir, attachments: [], _onDidFinishTestFunctionCallbacks: new Set(), outputPath: name => join(outputDir, name) };
}
async function context(pages) {
  const result = new EventEmitter();
  result.pages = () => pages;
  result.browser = () => ({ contexts: () => [result] });
  await didCreateRunnerContext(result);
  return result;
}
function page(behavior) {
  return { screenshot: async options => {
    await behavior?.(options);
    await mkdir(resolve(options.path, '..'), { recursive: true });
    await writeFile(options.path, Buffer.from('complete-image'));
    return Buffer.from('complete-image');
  } };
}
try {
  for (const mode of ['off', 'on', 'only-on-failure', 'on-first-failure']) assert.equal(screenshotPolicy(mode).mode, mode);
  assert.deepEqual(screenshotPolicy({ mode: 'on', fullPage: true, omitBackground: false }).options, { fullPage: true, omitBackground: false });
  for (const invalid of [null, [], 1, false, 'unknown', {}, { mode: 'on', fullPage: 1 }]) assert.throws(() => screenshotPolicy(invalid), error => error.name === 'InvalidArgumentError');
  assert.throws(() => screenshotPolicy({ mode: 'on', mask: [] }), error => error.name === 'UnsupportedFeatureError');
  assert.equal(willCloseRunnerContext(await context([])), undefined);
  assert.throws(() => runnerIntegration.installContextLifecycle(2, {}), error => error.name === 'ProtocolError');
  assert.throws(() => runnerIntegration.installContextLifecycle(1, {}), error => error.name === 'ProtocolError');

  let created = 0;
  const uninstall = runnerIntegration.installContextLifecycle(1, { didCreateContext: () => { created++; }, willCloseContext: async () => {} });
  await context([]); assert.equal(created, 1);
  assert.throws(() => runnerIntegration.installContextLifecycle(1, { didCreateContext() {}, async willCloseContext() {} }), error => error.name === 'ProtocolError');
  uninstall(); uninstall();
  assert.equal(willCloseRunnerContext(await context([])), undefined);

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
    await lifecycle.ready;
    const testInfo = information();
    const releases = [];
    let firstBatchStarted, lastBatchStarted;
    const firstBatch = new Promise(resolve => { firstBatchStarted = resolve; });
    const lastBatch = new Promise(resolve => { lastBatchStarted = resolve; });
    let active = 0;
    let maximumActive = 0;
    const pages = Array.from({ length: 6 }, () => page(async options => {
      assert.equal(options.caret, 'initial'); assert.ok(options.timeout > 0 && options.timeout <= 5000);
      maximumActive = Math.max(maximumActive, ++active);
      await new Promise(resolve => {
        releases.push(resolve);
        if (releases.length === 4) firstBatchStarted();
        if (releases.length === 6) lastBatchStarted();
      }); active--;
    }));
    const liveContext = await context(pages);
    const recorder = lifecycle.start(testInfo);
    const closing = willCloseRunnerContext(liveContext);
    await firstBatch;
    let finished = false;
    const finishing = lifecycle.finish(recorder).then(() => { finished = true; });
    await setImmediate(); assert.equal(finished, false);
    for (const release of releases.slice()) release();
    await lastBatch;
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
    const failedContext = await context([page(async () => { throw originalError; })]);
    const failedRecorder = lifecycle.start(failureInfo);
    await lifecycle.finish(failedRecorder);
    assert.equal(failureInfo.status, 'failed');
    assert.equal(failureInfo.attachments.length, 1);
    assert.equal(failureInfo.attachments[0].name, 'screenshot-error');
    assert.match(failureInfo.attachments[0].body.toString(), /ExampleCaptureError: original capture failure/);
    assert.ok(failureInfo.attachments[0].body.toString().includes('test-runner-screenshots.mjs'));
    failedContext.emit('close');

    const manyErrorsInfo = information('failed');
    const manyErrorsContext = await context(Array.from({ length: 40 }, () => page(async () => { throw new Error('bounded original failure'); })));
    const manyErrorsRecorder = lifecycle.start(manyErrorsInfo);
    await lifecycle.finish(manyErrorsRecorder);
    assert.equal(manyErrorsInfo.attachments.length, 1, 'many failed pages share a bounded diagnostic attachment');
    assert.match(manyErrorsInfo.attachments[0].body.toString(), /24 additional screenshot errors omitted/);
    assert.ok(manyErrorsInfo.attachments[0].body.byteLength < 65536);
    assert.equal(manyErrorsInfo.status, 'failed');
    manyErrorsContext.emit('close');

    const retentionInfo = information();
    const retainedContext = await context([page()]);
    const retainedRecorder = lifecycle.start(retentionInfo);
    await willCloseRunnerContext(retainedContext); retainedContext.emit('close');
    retentionInfo.status = 'failed';
    await lifecycle.finish(retainedRecorder);
    assert.equal(retentionInfo.attachments.length, 1);
    assert.equal(retentionInfo.attachments[0].name, 'screenshot');
    assert.equal(await readFile(retentionInfo.attachments[0].path, 'utf8'), 'complete-image');
    assert.ok(retentionInfo.attachments[0].path.endsWith('test-failed-1.png'));
  } finally { await lifecycle.dispose(); }
  assert.equal(willCloseRunnerContext(await context([])), undefined);
  const sharedContexts = new Set();
  const sharedScopes = new ScreenshotScopes(screenshotPolicy('only-on-failure'), sharedContexts);
  const observeSharedContext = value => {
    sharedContexts.add(value);
    value.once('close', () => sharedContexts.delete(value));
  };
  const sharedRegistration = runnerIntegration.installArtifactContextLifecycle(9, {
    beginContextCreation: () => {
      const claim = sharedScopes.claim();
      return { didCreateContext: async value => { claim?.didCreateContext(value); observeSharedContext(value); }, complete() {} };
    },
    didCreateUnclaimedContext: observeSharedContext,
    willCloseContext: value => sharedScopes.beforeContextClose(value),
  });
  let releaseEarlyCapture;
  const earlyCaptureReleased = new Promise(resolve => { releaseEarlyCapture = resolve; });
  let earlyCaptureStarted;
  const earlyCapture = new Promise(resolve => { earlyCaptureStarted = resolve; });
  let earlyCaptures = 0;
  let finishCaptures = 0;
  try {
    await sharedRegistration.ready;
    const earlyContext = await context([page(async () => { earlyCaptures++; earlyCaptureStarted(); await earlyCaptureReleased; })]);
    const sharedInfo = information();
    const sharedRecorder = sharedScopes.start(sharedInfo);
    assert.equal(earlyCaptures, 0, 'shared scopes observe available contexts without starting capture');
    const finishContext = await context([page(async () => { finishCaptures++; })]);
    assert.deepEqual([...sharedContexts], [earlyContext, finishContext], 'the external observer owns shared context availability');
    const closing = willCloseRunnerContext(earlyContext);
    await earlyCapture;
    sharedInfo.status = 'failed';
    let finished = false;
    const finishing = sharedScopes.finish(sharedRecorder).then(() => { finished = true; });
    await setImmediate();
    assert.equal(finished, false, 'shared finish retains the external pre-close capture');
    releaseEarlyCapture();
    await closing; earlyContext.emit('close');
    await finishing;
    assert.equal(earlyCaptures, 1); assert.equal(finishCaptures, 1);
    assert.equal(sharedInfo.attachments.length, 2, 'pre-close and newly available finish pages retain screenshots');
    for (const attachment of sharedInfo.attachments) {
      assert.equal(attachment.name, 'screenshot');
      assert.equal(await readFile(attachment.path, 'utf8'), 'complete-image');
    }
    assert.equal(sharedInfo._onDidFinishTestFunctionCallbacks.size, 0);
    const repeatedRecorder = sharedScopes.start(sharedInfo);
    await sharedScopes.finish(repeatedRecorder);
    await sharedScopes.beforeContextClose(finishContext);
    assert.equal(finishCaptures, 1, 'repeated original-TestInfo scopes preserve captured-page identity');
    finishContext.emit('close');
    assert.equal(sharedContexts.size, 0);
  } finally { releaseEarlyCapture(); await sharedRegistration.dispose(); }
  console.log('Screenshot policy, lifecycle identity, bounded concurrency, pending cleanup, outcome retention and error diagnostics passed.');
} finally { await rm(root, { recursive: true, force: true }); }
