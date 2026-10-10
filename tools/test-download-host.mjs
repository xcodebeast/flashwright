import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { BrowserContext, Download, Page } from '../packages/flashwright-core/dist/commonjs/index.js';
import { runtimeMetadata } from './javascript-runtime.mjs';
import { sourceManifest } from './source-manifest.mjs';

const output = process.argv[2] ? resolve(process.argv[2]) : undefined;
const report = {
  status: 'running', ...runtimeMetadata,
  scope: 'Controlled public Download stream ownership and filesystem lifecycle; no Chromium parity claim.',
  intentionalDifference: 'Context closure and deletion terminate streams with TargetClosedError. The pinned reference context-close probe instead produced an unhandled asynchronous _read rejection and hung.',
  outcomes: [],
};
const compiledHashes = async () => Object.fromEntries(await Promise.all((await readdir('packages/flashwright-core/dist/commonjs')).filter(name => name.endsWith('.js') || name.endsWith('.cjs')).sort().map(async name => [name, createHash('sha256').update(await readFile(join('packages/flashwright-core/dist/commonjs', name))).digest('hex')])));
if (output) {
  await mkdir(output);
  report.sourceHashes = await sourceManifest();
  report.compiledHashes = await compiledHashes();
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
}

const directory = await mkdtemp(join(tmpdir(), 'flashwright-download-host-'));
const artifactPath = join(directory, 'artifact');
const contents = Buffer.from('download stream contents\n\u0000é');
await writeFile(artifactPath, contents);

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

/** Publish through the actual Page facade while controlling only the native path reply. */
function fixture(pathResponse = async () => artifactPath) {
  const events = new Map();
  const commands = [];
  const client = {
    async request(method, parameters) {
      commands.push({ method, parameters });
      return method === 'download.path' ? pathResponse() : null;
    },
    subscribeObject(identifier, listener) { events.set(identifier, listener); return () => events.delete(identifier); },
    rejectProtocol(error) { throw error; },
  };
  const context = new BrowserContext(client, 'original-context', {}, null, undefined);
  const page = new Page(client, 'original-page', context, false, { mainFrame: 'original-frame', frames: [], navigationSequence: 0 });
  let download;
  page.once('download', received => { download = received; });
  events.get('original-page')({ event: 'download', parameters: {
    context: 'original-context', download: 'original-download',
    downloadJson: JSON.stringify({ guid: 'original-download', url: 'blob:original', suggestedFilename: 'original.txt' }),
  } });
  assert.ok(download instanceof Download);
  return { context, page, download, commands };
}

async function consume(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function streamClosed(stream) { return new Promise(resolve => stream.once('close', resolve)); }

function closeListenerRemoved(context) {
  return new Promise(resolve => {
    const removed = event => {
      if (event !== 'close') return;
      context.off('removeListener', removed);
      resolve();
    };
    context.on('removeListener', removed);
  });
}

async function check(name, operation) {
  try { await operation(); report.outcomes.push({ name, status: 'passed' }); }
  catch (error) {
    report.outcomes.push({ name, status: 'failed', error: { name: error.name, message: error.message, stack: error.stack } });
    throw error;
  }
}

try {
  await check('complete-after-page-close', async () => {
    const state = fixture();
    state.page.didClose();
    assert.deepEqual(await consume(await state.download.createReadStream()), contents);
    assert.equal(state.context.listenerCount('close'), 0);
    assert.equal(state.download.page(), state.page);
    assert.deepEqual(state.commands, [{ method: 'download.path', parameters: { context: 'original-context', download: 'original-download' } }]);
    state.context.didClose();
  });
  await check('context-close-before-consumption', async () => {
    const state = fixture();
    const unread = await state.download.createReadStream();
    const observed = await state.download.createReadStream();
    assert.equal(state.context.listenerCount('close'), 1);
    const errors = [];
    observed.on('error', error => errors.push(error));
    const closed = Promise.all([streamClosed(unread), streamClosed(observed)]);
    state.context.didClose();
    await closed;
    // The unread stream has no caller error listener, even after its error event has fired.
    await assert.rejects(() => consume(unread), { name: 'TargetClosedError' });
    await assert.rejects(() => consume(observed), { name: 'TargetClosedError' });
    assert.equal(errors.length, 1);
    assert.equal(errors[0].name, 'TargetClosedError');
    assert.equal(unread.destroyed, true);
    assert.equal(state.context.listenerCount('close'), 0);
    assert.equal(state.download.suggestedFilename(), 'original.txt');
    assert.equal(state.download.url(), 'blob:original');
    assert.equal(state.download.page(), state.page);
  });
  await check('delete-before-consumption', async () => {
    const state = fixture();
    const stream = await state.download.createReadStream();
    const closed = streamClosed(stream);
    await state.download.delete();
    await closed;
    await assert.rejects(() => consume(stream), { name: 'TargetClosedError' });
    assert.equal(state.context.listenerCount('close'), 0);
    state.context.didClose();
  });
  await check('context-close-before-path-reply', async () => {
    const path = deferred();
    const state = fixture(() => path.promise);
    const rejected = assert.rejects(state.download.createReadStream(), { name: 'TargetClosedError' });
    state.context.didClose();
    path.resolve(artifactPath);
    await rejected;
    assert.equal(state.context.listenerCount('close'), 0);
  });
  for (const ending of ['context-close', 'delete']) {
    await check(`${ending}-before-stream-open`, async () => {
      const state = fixture();
      const subscribed = deferred();
      const registered = event => { if (event === 'close') subscribed.resolve(); };
      state.context.on('newListener', registered);
      const removed = closeListenerRemoved(state.context);
      const rejected = assert.rejects(state.download.createReadStream(), { name: 'TargetClosedError' });
      await subscribed.promise;
      state.context.off('newListener', registered);
      assert.equal(state.context.listenerCount('close'), 1);
      if (ending === 'context-close') state.context.didClose();
      else await state.download.delete();
      await rejected;
      await removed;
      assert.equal(state.context.listenerCount('close'), 0);
      state.context.didClose();
    });
  }
  await check('missing-file-open-rejects', async () => {
    const state = fixture(async () => join(directory, 'missing'));
    await assert.rejects(state.download.createReadStream(), { code: 'ENOENT' });
    assert.equal(state.context.listenerCount('close'), 0);
    state.context.didClose();
  });
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  throw error;
} finally {
  await rm(directory, { recursive: true, force: true });
  if (output) {
    report.implementationChangedDuringVerification = JSON.stringify(await sourceManifest()) !== JSON.stringify(report.sourceHashes);
    report.compiledChangedDuringVerification = JSON.stringify(await compiledHashes()) !== JSON.stringify(report.compiledHashes);
    if (report.implementationChangedDuringVerification || report.compiledChangedDuringVerification) report.status = 'failed';
    await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    assert.equal(report.implementationChangedDuringVerification, false);
    assert.equal(report.compiledChangedDuringVerification, false);
  }
}
console.log(JSON.stringify({ status: report.status, checks: report.outcomes.length, scope: report.scope, intentionalDifference: report.intentionalDifference }));
