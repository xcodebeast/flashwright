import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { chromium, request as referenceRequest } from 'playwright';

const require = createRequire(import.meta.url);
const { request } = require('../packages/flashwright-core/dist/commonjs/api-request.js');
const { runnerIntegration } = require('../packages/flashwright-core/dist/commonjs/runner-integration.js');
const { request: publicRequest } = require('../packages/flashwright-core/dist/commonjs/index.js');
const { tryAcquireTraceTransfer } = require('../packages/flashwright-core/dist/commonjs/trace-transfers.js');
const { TraceNetworkChannel } = require('../packages/flashwright-core/dist/commonjs/trace-network.js');
const { TraceResources } = require('../packages/flashwright-core/dist/commonjs/trace-resources.js');
const { server: upstreamServer } = require(resolve(dirname(require.resolve('playwright-core/package.json')), 'lib/coreBundle.js'));

const directory = await mkdtemp(join(tmpdir(), 'flashwright-api-trace-integration-'));
let announceSlowRequest;
let finishSlowRequest;
const slowRequestStarted = new Promise(resolve => { announceSlowRequest = resolve; });
const server = createServer((incoming, outgoing) => {
  if (incoming.url === '/slow') {
    finishSlowRequest = () => outgoing.end('too late');
    announceSlowRequest();
    return;
  }
  if (incoming.url === '/truncated') {
    outgoing.writeHead(200, { 'content-length': '10' });
    outgoing.write('short');
    setTimeout(() => outgoing.destroy(), 10);
    return;
  }
  if (incoming.url === '/redirect') {
    outgoing.writeHead(302, { location: '/final', 'set-cookie': 'original=1; Path=/' });
    outgoing.end();
    return;
  }
  if (incoming.url === '/post-redirect') {
    outgoing.writeHead(307, { location: '/submit' });
    incoming.resume();
    outgoing.end();
    return;
  }
  if (incoming.url === '/auth' && !incoming.headers.authorization) {
    outgoing.writeHead(401, { 'www-authenticate': 'Basic realm="trace"' });
    outgoing.end();
    return;
  }
  outgoing.writeHead(200, { 'content-type': 'text/plain', 'x-request-method': incoming.method });
  incoming.resume();
  outgoing.end('finished');
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address();
assert.ok(address && typeof address !== 'string');
const origin = `http://127.0.0.1:${address.port}`;
let context;
let archive;
let referenceContext;
let viewer;
let browser;
try {
  await assert.rejects(publicRequest.newContext(), error => error.name === 'UnsupportedFeatureError');
  context = await request.newContext({ httpCredentials: { username: 'trace-user', password: 'trace-password', send: 'unauthorized' } });
  assert.equal('tracing' in context, false);
  const tracing = runnerIntegration.requestTraceOwner(12, context);
  const startup = runnerIntegration.beginTraceRecordingWithActions(11, tracing, { snapshots: true }, { begin() { return undefined; } });
  const recording = await startup.ready;
  const response = await context.get(`${origin}/redirect`);
  assert.equal(response.status(), 200);
  assert.equal(await response.text(), 'finished');
  const authenticated = await context.get(`${origin}/auth`);
  assert.equal(authenticated.status(), 200);
  const postBody = Buffer.from([0, 1, 2, 255]);
  const posted = await context.post(`${origin}/submit`, { data: postBody, headers: { 'content-type': 'application/octet-stream' } });
  assert.equal(posted.status(), 200);
  const redirectedPost = await context.post(`${origin}/post-redirect`, { data: postBody, headers: { 'content-type': 'application/octet-stream' } });
  assert.equal(redirectedPost.status(), 200);
  const formResponse = await context.post(`${origin}/submit`, { form: { a: 'one', b: 'two' } });
  assert.equal(formResponse.status(), 200);
  archive = await recording.chunk.takeArchive();
  const destination = join(directory, 'api-trace.zip');
  await archive.export(destination, new AbortController().signal);
  const events = execFileSync('unzip', ['-p', destination, 'trace.trace'], { encoding: 'utf8' }).trim().split('\n').map(line => JSON.parse(line));
  const contextOptions = events.find(event => event.type === 'context-options');
  assert.equal(contextOptions.browserName, '');
  assert.deepEqual(contextOptions.options, {});
  const snapshots = execFileSync('unzip', ['-p', destination, 'trace.network'], { encoding: 'utf8' }).trim().split('\n').map(line => JSON.parse(line).snapshot);
  assert.equal(snapshots.length, 8);
  assert.deepEqual(snapshots.map(snapshot => snapshot.response.status), [302, 200, 401, 200, 200, 307, 200, 200]);
  assert.deepEqual(snapshots.map(snapshot => snapshot.request.url), [`${origin}/redirect`, `${origin}/final`, `${origin}/auth`, `${origin}/auth`, `${origin}/submit`, `${origin}/post-redirect`, `${origin}/submit`, `${origin}/submit`]);
  assert.ok(snapshots.every(snapshot => snapshot._apiRequest === true));
  assert.equal(snapshots[1].response.content.size, 8);
  assert.match(snapshots[1].response.content._sha1, /^[a-f0-9]{40}\.txt$/);
  assert.equal(execFileSync('unzip', ['-p', destination, `resources/${snapshots[1].response.content._sha1}`], { encoding: 'utf8' }), 'finished');
  assert.equal(snapshots[0].response.content._sha1, undefined);
  assert.equal(snapshots[2].request.headers.some(header => header.name === 'authorization'), false);
  assert.equal(snapshots[3].request.headers.some(header => header.name === 'authorization'), true);
  assert.equal(snapshots[4].request.postData.mimeType, 'application/octet-stream');
  assert.match(snapshots[4].request.postData._sha1, /^[a-f0-9]{40}\.bin$/);
  assert.deepEqual(execFileSync('unzip', ['-p', destination, `resources/${snapshots[4].request.postData._sha1}`]), postBody);
  assert.equal(snapshots[5].request.postData._sha1, snapshots[4].request.postData._sha1);
  assert.equal(snapshots[6].request.postData._sha1, snapshots[4].request.postData._sha1);
  assert.deepEqual(snapshots[7].request.postData.params, [{ name: 'a', value: 'one' }, { name: 'b', value: 'two' }]);
  assert.equal(execFileSync('unzip', ['-p', destination, `resources/${snapshots[7].request.postData._sha1}`], { encoding: 'utf8' }), 'a=one&b=two');
  referenceContext = await referenceRequest.newContext({ httpCredentials: { username: 'trace-user', password: 'trace-password', send: 'unauthorized' } });
  await referenceContext.tracing.start({ snapshots: true });
  await referenceContext.get(`${origin}/redirect`);
  await referenceContext.get(`${origin}/auth`);
  await referenceContext.post(`${origin}/submit`, { data: postBody, headers: { 'content-type': 'application/octet-stream' } });
  await referenceContext.post(`${origin}/post-redirect`, { data: postBody, headers: { 'content-type': 'application/octet-stream' } });
  await referenceContext.post(`${origin}/submit`, { form: { a: 'one', b: 'two' } });
  const referenceDestination = join(directory, 'playwright-api-trace.zip');
  await referenceContext.tracing.stop({ path: referenceDestination });
  const referenceSnapshots = execFileSync('unzip', ['-p', referenceDestination, 'trace.network'], { encoding: 'utf8' }).trim().split('\n').map(line => JSON.parse(line).snapshot).filter(snapshot => snapshot._apiRequest);
  const referenceEvents = execFileSync('unzip', ['-p', referenceDestination, 'trace.trace'], { encoding: 'utf8' }).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(events.filter(event => event.type === 'before').map(event => [event.class, event.method]), referenceEvents.filter(event => event.type === 'before').map(event => [event.class, event.method]));
  assert.deepEqual(snapshots.map(snapshot => snapshot.response.status), referenceSnapshots.map(snapshot => snapshot.response.status));
  assert.deepEqual(snapshots.map(snapshot => new URL(snapshot.request.url).pathname), referenceSnapshots.map(snapshot => new URL(snapshot.request.url).pathname));
  assert.deepEqual(snapshots.map(snapshot => snapshot.response.httpVersion), referenceSnapshots.map(snapshot => snapshot.response.httpVersion));
  if (process.env.FLASHWRIGHT_CHECK_TRACE_VIEWER === '1') {
    viewer = await upstreamServer.startTraceViewerServer({ host: '127.0.0.1', allowedFileRoots: [directory] });
    browser = await chromium.launch({ executablePath: process.env.FLASHWRIGHT_BROWSER_PATH ?? chromium.executablePath() });
    const page = await browser.newPage();
    const viewerErrors = [];
    page.on('pageerror', error => viewerErrors.push(error.message));
    const fileRoute = `file?path=${encodeURIComponent(destination)}`;
    await page.goto(`${viewer.urlPrefix('precise')}/trace/index.html?trace=${encodeURIComponent(fileRoute)}`);
    await page.getByRole('treeitem', { name: /request\.get/ }).first().waitFor({ timeout: 10000 });
    await page.getByRole('tab', { name: /^Network/ }).click();
    await page.getByText('redirect', { exact: true }).waitFor({ timeout: 10000 });
    const viewerBody = await page.locator('body').innerText();
    assert.match(viewerBody, /redirect\nGET\n302/);
    assert.match(viewerBody, /auth\nGET\n401/);
    assert.deepEqual(viewerErrors, []);
  }
  await recording.stop();
  await response.dispose();
  await authenticated.dispose();
  await posted.dispose();
  await redirectedPost.dispose();
  await formResponse.dispose();
  const metadataOnlyStartup = runnerIntegration.beginTraceRecordingWithActions(11, tracing, { snapshots: false }, { begin() { return undefined; } });
  const metadataOnlyRecording = await metadataOnlyStartup.ready;
  const metadataOnlyResponse = await context.get(`${origin}/final`);
  await metadataOnlyResponse.dispose();
  const metadataOnlyArchive = await metadataOnlyRecording.chunk.takeArchive();
  const metadataOnlyDestination = join(directory, 'metadata-only.zip');
  await metadataOnlyArchive.export(metadataOnlyDestination, new AbortController().signal);
  assert.equal(execFileSync('unzip', ['-p', metadataOnlyDestination, 'trace.network'], { encoding: 'utf8' }).length, 0);
  await metadataOnlyArchive.dispose();
  await metadataOnlyRecording.stop();
  const failedStartup = runnerIntegration.beginTraceRecordingWithActions(11, tracing, { snapshots: true }, { begin() { return undefined; } });
  const failedRecording = await failedStartup.ready;
  await assert.rejects(context.get('http://127.0.0.1:1/refused', { timeout: 1500 }));
  const failedArchive = await failedRecording.chunk.takeArchive();
  const failedDestination = join(directory, 'failed-attempt.zip');
  await failedArchive.export(failedDestination, new AbortController().signal);
  const failedSnapshots = execFileSync('unzip', ['-p', failedDestination, 'trace.network'], { encoding: 'utf8' }).trim().split('\n').map(line => JSON.parse(line).snapshot);
  assert.equal(failedSnapshots.length, 1);
  assert.equal(failedSnapshots[0].response.status, -1);
  assert.equal(failedSnapshots[0].response.content.size, -1);
  assert.equal(failedSnapshots[0].time, -1);
  await failedArchive.dispose();
  await failedRecording.stop();
  const truncatedStartup = runnerIntegration.beginTraceRecordingWithActions(11, tracing, { snapshots: true }, { begin() { return undefined; } });
  const truncatedRecording = await truncatedStartup.ready;
  await assert.rejects(context.get(`${origin}/truncated`, { timeout: 2000 }));
  const truncatedArchive = await truncatedRecording.chunk.takeArchive();
  const truncatedDestination = join(directory, 'truncated-attempt.zip');
  await truncatedArchive.export(truncatedDestination, new AbortController().signal);
  const truncatedSnapshot = JSON.parse(execFileSync('unzip', ['-p', truncatedDestination, 'trace.network'], { encoding: 'utf8' }).trim()).snapshot;
  assert.equal(truncatedSnapshot.response.status, -1);
  assert.equal(truncatedSnapshot.response.content.size, -1);
  await truncatedArchive.dispose();
  await truncatedRecording.stop();
  const sharedStartup = runnerIntegration.beginTraceRecordingWithActions(11, tracing, { snapshots: true }, { begin() { return undefined; } });
  const sharedRecording = await sharedStartup.ready;
  const browserResources = await TraceResources.create();
  const originalClientRequest = tracing.client.request;
  let releaseBrowserPoll;
  const browserPoll = new Promise(resolve => { releaseBrowserPoll = resolve; });
  tracing.client.request = (method, parameters, ...rest) => method === 'context.trace.network.pull'
    ? browserPoll.then(() => ({ recording: parameters.recording, resources: [], pending: false }))
    : originalClientRequest.call(tracing.client, method, parameters, ...rest);
  const browserCollectorOne = new TraceNetworkChannel(tracing.client, 'browser-trace-one', 'recording-one', browserResources, error => { throw error; });
  const browserCollectorTwo = new TraceNetworkChannel(tracing.client, 'browser-trace-two', 'recording-two', browserResources, error => { throw error; });
  clearTimeout(browserCollectorOne.timer);
  clearTimeout(browserCollectorTwo.timer);
  try {
    const browserDrainOne = browserCollectorOne.drain();
    const browserDrainTwo = browserCollectorTwo.drain();
    assert.equal(tryAcquireTraceTransfer(tracing.client, context.identifier), undefined);
    const disposableResponse = await context.get(`${origin}/final`);
    await disposableResponse.dispose();
    releaseBrowserPoll();
    await Promise.all([browserDrainOne, browserDrainTwo]);
  } finally {
    releaseBrowserPoll();
    tracing.client.request = originalClientRequest;
    await Promise.all([browserCollectorOne.stop(), browserCollectorTwo.stop()]);
    await browserResources.dispose();
  }
  const sharedArchive = await sharedRecording.chunk.takeArchive();
  const sharedDestination = join(directory, 'shared-transfer.zip');
  await sharedArchive.export(sharedDestination, new AbortController().signal);
  const sharedSnapshot = JSON.parse(execFileSync('unzip', ['-p', sharedDestination, 'trace.network'], { encoding: 'utf8' }).trim()).snapshot;
  assert.equal(execFileSync('unzip', ['-p', sharedDestination, `resources/${sharedSnapshot.response.content._sha1}`], { encoding: 'utf8' }), 'finished');
  await sharedArchive.dispose();
  await sharedRecording.stop();
  const closingStartup = runnerIntegration.beginTraceRecordingWithActions(11, tracing, { snapshots: true }, { begin() { return undefined; } });
  const closingRecording = await closingStartup.ready;
  const pending = context.get(`${origin}/slow`, { timeout: 5000 });
  const pendingRejection = assert.rejects(pending, error => error.name === 'TargetClosedError');
  await slowRequestStarted;
  await context.dispose();
  await pendingRejection;
  await runnerIntegration.settleClosedTraceCleanup(11, tracing);
  await assert.rejects(closingRecording.chunk.takeArchive(), error => error.name === 'TargetClosedError');
  let acceptEnrollment;
  let observeCreatedContext;
  const enrollment = new Promise(resolve => { acceptEnrollment = resolve; });
  const createdContext = new Promise(resolve => { observeCreatedContext = resolve; });
  const lifecycleEvents = [];
  const lifecycle = runnerIntegration.installArtifactRequestLifecycle(12, {
    beginRequestCreation() {
      lifecycleEvents.push('claim');
      return {
        async didCreateContext(created) { lifecycleEvents.push('enroll'); observeCreatedContext(created); await enrollment; },
        complete() { lifecycleEvents.push('complete'); },
      };
    },
    didCreateUnclaimedContext() { throw new Error('creation was reassigned'); },
    async willDisposeContext() { lifecycleEvents.push('dispose'); },
    async didCloseContext() { lifecycleEvents.push('close'); },
  });
  const pendingCreation = request.newContext();
  const closingContext = await createdContext;
  const closingDisposal = closingContext.dispose();
  acceptEnrollment();
  await assert.rejects(pendingCreation, error => error.name === 'TargetClosedError');
  await closingDisposal;
  await lifecycle.dispose();
  assert.deepEqual(lifecycleEvents, ['claim', 'enroll', 'dispose', 'close', 'complete']);
  console.log(JSON.stringify({ status: 'passed', attempts: snapshots.length, events: events.length }));
} finally {
  finishSlowRequest?.();
  await archive?.dispose();
  await context?.dispose();
  await referenceContext?.dispose();
  await browser?.close();
  await viewer?.stop();
  server.close();
  await once(server, 'close');
  await rm(directory, { recursive: true, force: true });
}
