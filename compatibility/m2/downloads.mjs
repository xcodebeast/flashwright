import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { sourceManifest } from '../../tools/source-manifest.mjs';
const engine = process.argv[3] ?? 'playwright';
assert.ok(['playwright', 'flashwright'].includes(engine));
const traced = process.argv[4] === '--trace';
const { chromium } = await import(engine);
const sources = await sourceManifest();
const unhandledRejections = [];
process.on('unhandledRejection', error => unhandledRejections.push({ name: error.name, message: error.message, stack: error.stack }));

const destination = resolve(process.argv[2]);
await mkdir(destination, { recursive: true });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const pending = new Map();
const contents = Buffer.from('download fixture\n\u0000\u00e9\n'.repeat(1024));
const server = createServer((request, response) => {
  if (request.url.startsWith('/file')) {
    response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="fixture.txt"', 'content-length': contents.length });
    response.end(contents);
  } else if (request.url.startsWith('/pending')) {
    response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="pending.bin"', 'content-length': contents.length });
    response.write(contents.subarray(0, 4096));
    pending.set(request.url, () => { pending.delete(request.url); response.end(contents.subarray(4096)); });
    response.on('close', () => pending.delete(request.url));
  } else {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<!doctype html><a id="link" href="/file">Download</a>');
  }
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const origin = `http://127.0.0.1:${server.address().port}`;
const browserPath = process.env.FLASHWRIGHT_BROWSER_PATH;
assert.ok(browserPath);
const report = { schemaVersion: 1, traced, traces: [], checks: [], scope: 'Common Download methods and original context ownership on pinned Chromium. Stream consumption after closure is a separately asserted reference difference; no performance or release claim.', status: 'running', reference: '1.60.0', engine, sources, unhandledRejections, driverSha256: process.env.FLASHWRIGHT_DRIVER_PATH ? hash(await readFile(process.env.FLASHWRIGHT_DRIVER_PATH)) : null, runtime: { name: process.versions.bun ? 'bun' : 'node', version: process.versions.bun ?? process.version }, browserSha256: hash(await readFile(browserPath)), sourceSha256: hash(await readFile(new URL(import.meta.url))), outcomes: [] };
const browser = await chromium.launch({ executablePath: browserPath });
async function outcome(operation) {
  try { return { status: 'fulfilled', value: await operation() }; }
  catch (error) { return { status: 'rejected', errorName: error.name, message: error.message, stack: error.stack ?? null }; }
}
const activeTraces = new Map();
async function closeContext(context) {
  const path = activeTraces.get(context);
  if (path) { await context.tracing.stop({ path }); activeTraces.delete(context); report.traces.push(path); }
  await context.close();
}
async function withPage(name, options, operation) {
  const context = await browser.newContext(options);
  // A pending Download call cannot drain into a finalized trace before its context is closed.
  if (traced && name !== 'context-close-active') {
    await context.tracing.start({ snapshots: true, screenshots: false, sources: false });
    activeTraces.set(context, join(destination, `${name}.zip`));
  }
  const page = await context.newPage();
  page.setDefaultTimeout(3000);
  try {
    await page.goto(origin);
    report.activeCase = name;
    await writeFile(join(destination, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    report.outcomes.push({ name, ...(await outcome(() => operation(page, context))) });
    report.activeCase = null;
    await writeFile(join(destination, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  } finally { await closeContext(context); }
}
async function download(page, path = '/file') {
  await page.locator('#link').evaluate((element, path) => { element.href = path; }, path);
  const [event] = await Promise.all([page.waitForEvent('download'), page.locator('#link').click()]);
  return event;
}
try {
  await withPage('events-and-predicates', {}, async page => {
    const observed = [];
    let once;
    const listener = file => observed.push(file);
    page.on('download', listener);
    page.once('download', file => { once = file; });
    const predicate = file => file.url().endsWith('?second');
    const filtered = page.waitForEvent('download', { timeout: 3000, predicate: async file => predicate(file) });
    const direct = page.waitForEvent('download', predicate);
    const first = await download(page, '/file?first');
    const second = await download(page, '/file?second');
    const selected = await filtered;
    const selectedDirect = await direct;
    page.off('download', listener);
    return { count: observed.length, firstIdentity: observed[0] === first && once === first,
      secondIdentity: observed[1] === second && selected === second && selectedDirect === second,
      originalPage: second.page() === page, failure: await second.failure(),
      timeout: await outcome(() => page.waitForEvent('download', { timeout: 20 })) };
  });
  await withPage('completed-default', {}, async (page, context) => {
    const file = await download(page);
    const path = await file.path();
    const bytes = await readFile(path);
    const savedPath = join(destination, 'saved', 'copy.txt');
    await file.saveAs(savedPath);
    const chunks = [];
    for await (const chunk of await file.createReadStream()) chunks.push(chunk);
    const beforeClose = { pageIdentity: file.page() === page, url: file.url().replace(origin, '<origin>'), filename: file.suggestedFilename(), byteLength: bytes.length, sha256: hash(bytes), savedSha256: hash(await readFile(savedPath)), streamedSha256: hash(Buffer.concat(chunks)), failure: await file.failure(), cancelAfterCompletion: await outcome(() => file.cancel()) };
    await closeContext(context);
    return { ...beforeClose, temporaryPathExistsAfterClose: await stat(path).then(() => true, () => false), savedPathExistsAfterClose: await stat(savedPath).then(() => true, () => false), failureAfterClose: await outcome(() => file.failure()), pathAfterClose: await outcome(() => file.path()) };
  });
  await withPage('accept-downloads-false', { acceptDownloads: false }, async page => {
    const file = await download(page);
    return { filename: file.suggestedFilename(), failure: await file.failure(), path: await outcome(() => file.path()), saveAs: await outcome(() => file.saveAs(join(destination, 'denied.txt'))), stream: await outcome(() => file.createReadStream()), delete: await outcome(() => file.delete()) };
  });
  await withPage('cancel-active', {}, async page => {
    const file = await download(page, '/pending?cancel');
    await file.cancel();
    return { failure: await file.failure(), secondCancel: await outcome(() => file.cancel()), path: await outcome(() => file.path()), stream: await outcome(() => file.createReadStream()) };
  });
  await withPage('save-before-completion', {}, async page => {
    const file = await download(page, '/pending?save');
    let settled = false;
    const saving = file.saveAs(join(destination, 'pending-copy.bin')).then(() => { settled = true; });
    await new Promise(resolve => setTimeout(resolve, 50));
    const settledBeforeCompletion = settled;
    pending.get('/pending?save')();
    await saving;
    return { settledBeforeCompletion, savedSha256: hash(await readFile(join(destination, 'pending-copy.bin'))), failure: await file.failure() };
  });
  await withPage('delete-completed', {}, async page => {
    const file = await download(page);
    const path = await file.path();
    await file.delete();
    return { temporaryPathExists: await stat(path).then(() => true, () => false), failure: await outcome(() => file.failure()), path: await outcome(() => file.path()), secondDelete: await outcome(() => file.delete()), saveAs: await outcome(() => file.saveAs(join(destination, 'deleted.txt'))) };
  });
  await withPage('context-close-active', {}, async (page, context) => {
    const file = await download(page, '/pending?context');
    const waitingPath = outcome(() => file.path());
    const saving = outcome(() => file.saveAs(join(destination, 'closed.txt')));
    await closeContext(context);
    return { path: await waitingPath, saveAs: await saving, failure: await outcome(() => file.failure()) };
  });
  await withPage('page-close-active', {}, async page => {
    const file = await download(page, '/pending?page');
    await page.close();
    pending.get('/pending?page')?.();
    return { pageIdentity: file.page() === page, failure: await outcome(() => file.failure()), path: await outcome(async () => hash(await readFile(await file.path()))) };
  });
  await withPage('stream-after-context-close', {}, async (page, context) => {
    const file = await download(page);
    const stream = await file.createReadStream();
    const errors = [];
    stream.on('error', error => errors.push({ name: error.name, message: error.message }));
    await closeContext(context);
    const consuming = outcome(async () => {
      const chunks = [];
      for await (const chunk of stream) chunks.push(chunk);
      return { bytes: Buffer.concat(chunks).length, sha256: hash(Buffer.concat(chunks)) };
    });
    const result = await Promise.race([consuming, new Promise(resolve => setTimeout(() => resolve({ status: 'pending-after-observation-window', milliseconds: 500 }), 500))]);
    stream.destroy();
    return { result, errors, destroyed: stream.destroyed };
  });
  await withPage('delete-active', {}, async page => {
    const file = await download(page, '/pending?delete');
    let settled = false;
    const deleting = file.delete().then(() => { settled = true; });
    await new Promise(resolve => setTimeout(resolve, 50));
    const settledBeforeCompletion = settled;
    pending.get('/pending?delete')();
    await deleting;
    return { settledBeforeCompletion, pathAfterDelete: await outcome(() => file.path()) };
  });
  await withPage('denied-after-delete', { acceptDownloads: false }, async page => {
    const file = await download(page);
    await file.delete();
    return { failure: await outcome(() => file.failure()), cancel: await outcome(() => file.cancel()), filename: file.suggestedFilename() };
  });
  await withPage('same-name-independent-files', {}, async page => {
    const first = await download(page);
    const second = await download(page);
    const firstPath = await first.path();
    const secondPath = await second.path();
    await first.delete();
    return { distinctPaths: firstPath !== secondPath, namesMatch: first.suggestedFilename() === second.suggestedFilename(), secondSha256: hash(await readFile(secondPath)) };
  });
  await withPage('iframe-origin', {}, async page => {
    await page.evaluate(() => {
      const frame = document.createElement('iframe');
      frame.srcdoc = '<a download="child.txt">Child</a>';
      document.body.append(frame);
    });
    await page.frameLocator('iframe').locator('a').evaluate(element => { element.href = URL.createObjectURL(new Blob(['child-bytes'])); });
    const [file] = await Promise.all([page.waitForEvent('download'), page.frameLocator('iframe').locator('a').click()]);
    return { originalPage: file.page() === page, filename: file.suggestedFilename(), text: await readFile(await file.path(), 'utf8') };
  });
  await withPage('blob-and-suggested-name', {}, async page => {
    await page.locator('#link').evaluate(element => {
      element.href = URL.createObjectURL(new Blob(['<svg></svg>'], { type: 'image/svg+xml' }));
      element.download = 'example-\u00e9.svg';
    });
    const event = page.waitForEvent('download');
    await page.locator('#link').click();
    const file = await event;
    return { filename: file.suggestedFilename(), urlScheme: file.url().split(':')[0], text: await readFile(await file.path(), 'utf8'), failure: await file.failure() };
  });
  validateOutcomes();
  report.status = 'passed';
  if (report.status === 'failed') process.exitCode = 1;
} catch (error) {
  report.status = 'failed';
  report.error = { name: error.name, message: error.message, stack: error.stack };
  process.exitCode = 1;
} finally {
  await browser.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  report.implementationChangedDuringVerification = JSON.stringify(sources) !== JSON.stringify(await sourceManifest());
  report.sourceChangedDuringVerification = report.sourceSha256 !== hash(await readFile(new URL(import.meta.url)));
  report.browserChangedDuringVerification = report.browserSha256 !== hash(await readFile(browserPath));
  await writeFile(join(destination, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  if (report.implementationChangedDuringVerification || report.sourceChangedDuringVerification || report.browserChangedDuringVerification) { report.status = 'failed'; process.exitCode = 1; await writeFile(join(destination, 'report.json'), JSON.stringify(report, null, 2) + '\n'); }
  console.log(JSON.stringify({ status: report.status, engine, traced, cases: report.outcomes.length, checks: report.checks.length }));
}

/** Categorize only expected diagnostics; keep original errors and stacks in outcomes. */
function semantic(value) {
  if (Array.isArray(value)) return value.map(semantic);
  if (!value || typeof value !== 'object') return value;
  if (value.status === 'rejected') {
    let category;
    if (value.errorName === 'TimeoutError') category = 'timeout';
    else if (/acceptDownloads: true/.test(value.message)) category = 'policy';
    else if (/canceled/.test(value.message)) category = 'canceled';
    else if (/closed|deleted/.test(value.message)) category = 'closed';
    assert.ok(category, `Unexpected rejection: ${value.message}`);
    assert.equal(value.errorName, category === 'timeout' ? 'TimeoutError' : engine === 'flashwright' && category === 'closed' ? 'TargetClosedError' : 'Error');
    return { status: 'rejected', category };
  }
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).map(([key, item]) => [key, semantic(item)]));
}
function validateOutcomes() {
  const fulfilled = { status: 'fulfilled' };
  const rejected = category => ({ status: 'rejected', category });
  const closed = rejected('closed');
  const canceled = rejected('canceled');
  const policy = rejected('policy');
  const digest = '52e6b3377526ef8d35202f9688b0353530b56fe390303320003bddd4554ba6fa';
  const expected = {
    'events-and-predicates': { count: 2, firstIdentity: true, secondIdentity: true, originalPage: true, failure: null, timeout: rejected('timeout') },
    'completed-default': { pageIdentity: true, url: '<origin>/file', filename: 'fixture.txt', byteLength: 21504, sha256: digest, savedSha256: digest, streamedSha256: digest, failure: null, cancelAfterCompletion: fulfilled, temporaryPathExistsAfterClose: false, savedPathExistsAfterClose: true, failureAfterClose: closed, pathAfterClose: closed },
    'accept-downloads-false': { filename: 'fixture.txt', failure: 'Pass { acceptDownloads: true } when you are creating your browser context.', path: policy, saveAs: policy, stream: policy, delete: fulfilled },
    'cancel-active': { failure: 'canceled', secondCancel: fulfilled, path: canceled, stream: canceled },
    'save-before-completion': { settledBeforeCompletion: false, savedSha256: digest, failure: null },
    'delete-completed': { temporaryPathExists: false, failure: closed, path: closed, secondDelete: closed, saveAs: closed },
    'context-close-active': { path: canceled, saveAs: canceled, failure: closed },
    'page-close-active': { pageIdentity: true, failure: { ...fulfilled, value: null }, path: { ...fulfilled, value: digest } },
    'delete-active': { settledBeforeCompletion: false, pathAfterDelete: closed },
    'denied-after-delete': { failure: closed, cancel: closed, filename: 'fixture.txt' },
    'same-name-independent-files': { distinctPaths: true, namesMatch: true, secondSha256: digest },
    'iframe-origin': { originalPage: true, filename: 'child.txt', text: 'child-bytes' },
    'blob-and-suggested-name': { filename: 'example-é.svg', urlScheme: 'blob', text: '<svg></svg>', failure: null },
  };
  assert.equal(report.outcomes.length, 14);
  for (const result of report.outcomes) {
    assert.equal(result.status, 'fulfilled', JSON.stringify(result));
    if (result.name === 'stream-after-context-close') {
      assert.equal(result.value.destroyed, true);
      if (engine === 'playwright') {
        assert.deepEqual(result.value.result, { status: 'pending-after-observation-window', milliseconds: 500 });
        assert.deepEqual(result.value.errors, []);
      } else {
        assert.deepEqual(semantic(result.value.result), closed);
        assert.equal(result.value.errors.length, 1);
        assert.equal(result.value.errors[0].name, 'TargetClosedError');
      }
      report.checks.push({ name: result.name, status: 'passed', classification: 'intentional-reference-difference' });
    } else {
      assert.ok(Object.hasOwn(expected, result.name));
      assert.deepEqual(semantic(result.value), expected[result.name], result.name);
      report.checks.push({ name: result.name, status: 'passed', classification: 'shared-outcome' });
    }
  }
  assert.equal(report.unhandledRejections.length, engine === 'playwright' ? 1 : 0);
  if (engine === 'playwright') assert.match(report.unhandledRejections[0].message, /_read: Target page, context or browser has been closed/);
}
