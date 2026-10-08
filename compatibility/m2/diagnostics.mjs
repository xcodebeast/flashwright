import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium as referenceChromium } from 'playwright';
import { chromium as flashwrightChromium } from 'flashwright';
import { sourceManifest } from '../../tools/source-manifest.mjs';
import { identifyBrowser } from '../../tools/browser-identity.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const destination = `compatibility/evidence/diagnostics-${process.platform}-${process.arch}-${process.versions.node}-${new Date().toISOString().replaceAll(':', '-')}`;
await mkdir(destination, { recursive: true });
const report = { schemaVersion: 1, reference: '1.60.0', sources: await sourceManifest(), browser: await identifyBrowser(process.env.FLASHWRIGHT_BROWSER_PATH ?? referenceChromium.executablePath()), driverSha256: hash(await readFile(process.env.FLASHWRIGHT_DRIVER_PATH)), node: process.version, platform: process.platform, architecture: process.arch, outcomes: {}, status: 'running', scope: 'Page error names, messages, exact stacks, UTF-16 and same-process event lifecycle. Workers and out-of-process frames remain outside this slice. No performance claim.' };
await writeFile(join(destination, 'report.json'), JSON.stringify(report, null, 2) + '\n');
const scripts = new Map([
  ['ordinary', 'function innerFailure() { throw new Error("ordinary failure"); }\nfunction outerFailure() { innerFailure(); }\nouterFailure();'],
  ['type', 'throw new TypeError("type failure");'],
  ['multiline', 'throw new Error("line one\\nline two: detail");'],
  ['unicode', 'throw new Error("é😃\\ud800\\udfff\\u0000");'],
  ['customName', 'const namedError = new Error("named failure"); namedError.name = "CustomFailure"; throw namedError;'],
  ['customStack', 'const stackedError = new Error("original"); stackedError.stack = "Custom: replacement\\n    at testFunction (custom.js:4:2)"; throw stackedError;'],
  ['emptyStack', 'const emptyError = new Error("without stack"); emptyError.stack = ""; throw emptyError;'],
  ['string', 'throw "string failure: extra";'],
  ['number', 'throw 42;'],
  ['boolean', 'throw false;'],
  ['null', 'throw null;'],
  ['undefined', 'throw undefined;'],
  ['bigint', 'throw 42n;'],
  ['symbol', 'throw Symbol("symbol failure");'],
  ['object', 'throw {answer: 42};'],
  ['array', 'throw [1, 2];'],
  ['promise', 'Promise.reject(new RangeError("unhandled rejection"));'],
  ['promiseString', 'Promise.reject("unhandled string");'],
  ['large', 'throw new Error("z".repeat(20000));'],
  ['syntax', 'function invalid( {'],
]);
const sockets = new Set();
const server = createServer((request, response) => {
  const url = new URL(request.url, 'http://fixture');
  if (url.pathname === '/error.js') {
    response.setHeader('content-type', 'text/javascript; charset=utf-8');
    response.end(scripts.get(url.searchParams.get('case')) ?? 'throw new Error("sentinel");'); return;
  }
  response.setHeader('content-type', 'text/html; charset=utf-8');
  response.end(url.pathname === '/child' ? '<!doctype html><script src="/error.js?case=type"></script>' : '<!doctype html><title>Page errors</title>');
});
server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const origin = `http://127.0.0.1:${server.address().port}`;
function errorRecord(error) {
  assert(error instanceof Error);
  return { name: error.name, message: error.message, stack: error.stack.replaceAll(origin, '<origin>') };
}
async function loadScript(page, label) {
  await page.evaluate(url => new Promise(resolve => {
    const script = document.createElement('script'); script.src = url;
    script.onload = () => resolve(true); document.body.appendChild(script);
  }), `${origin}/error.js?case=${label}`);
}
async function run(name, chromium) {
  const browser = await chromium.launch({ executablePath: report.browser.executablePath });
  const result = report.outcomes[name] = { errors: {}, lifecycle: {} };
  try {
    const context = await browser.newContext(); context.setDefaultTimeout(5000);
    const page = await context.newPage(); await page.goto(origin);
    const observed = [];
    page.on('pageerror', error => observed.push(error));
    for (const label of scripts.keys()) {
      const pending = page.waitForEvent('pageerror');
      await loadScript(page, label);
      const error = await pending;
      assert.equal(error, observed.at(-1));
      result.errors[label] = errorRecord(error);
    }
    assert.equal(observed.length, scripts.size);
    assert.equal(result.errors.unicode.message, 'é😃\ud800\udfff\u0000');
    assert.equal(result.errors.large.message.length, 20000);
    const errorCount = observed.length;
    await page.evaluate(() => { try { throw new Error('caught'); } catch {} Promise.reject(new Error('handled')).catch(() => {}); });
    await assert.rejects(page.evaluate(() => { throw new Error('evaluation failure'); }), /evaluation failure/);
    const sentinel = page.waitForEvent('pageerror'); await loadScript(page, 'sentinel'); await sentinel;
    assert.equal(observed.length, errorCount + 1, 'caught and evaluated exceptions are not uncaught page errors');
    result.lifecycle.caughtAndEvaluatedExcluded = true;

    let onceCount = 0; let firstIdentity;
    page.once('pageerror', error => { onceCount++; firstIdentity = error; });
    const listenersBefore = page.listenerCount('pageerror');
    const next = page.waitForEvent('pageerror', { predicate: async error => error.message === 'type failure' });
    await loadScript(page, 'sentinel');
    assert.equal(onceCount, 1); assert.equal(firstIdentity, observed.at(-1));
    await loadScript(page, 'type'); await next;
    assert.equal(onceCount, 1); assert.equal(page.listenerCount('pageerror'), listenersBefore - 1);
    result.lifecycle.onceIdentityAndPredicate = true;

    const originalCount = page.listenerCount('pageerror');
    const predicateFailure = new Error('predicate rejected');
    const rejected = assert.rejects(page.waitForEvent('pageerror', () => { throw predicateFailure; }), error => error === predicateFailure);
    await loadScript(page, 'sentinel'); await rejected;
    assert.equal(page.listenerCount('pageerror'), originalCount);
    await assert.rejects(page.waitForEvent('pageerror', { timeout: 25 }), error => error.name === 'TimeoutError');
    assert.equal(page.listenerCount('pageerror'), originalCount);
    result.lifecycle.waitCleanup = true;

    const pendingEvaluation = page.evaluate(() => new Promise(resolve => { globalThis.completePendingEvaluation = resolve; }));
    await page.evaluate(async () => { while (!globalThis.completePendingEvaluation) await new Promise(resolve => setTimeout(resolve, 0)); });
    const duringEvaluation = page.waitForEvent('pageerror'); await loadScript(page, 'ordinary'); await duringEvaluation;
    await page.evaluate(() => { completePendingEvaluation(42); }); assert.equal(await pendingEvaluation, 42);
    result.lifecycle.concurrentEvaluation = true;

    const childError = page.waitForEvent('pageerror');
    await page.evaluate(url => new Promise(resolve => { const frame = document.createElement('iframe'); frame.onload = () => resolve(true); frame.src = url; document.body.appendChild(frame); }), origin + '/child');
    result.lifecycle.childFrame = errorRecord(await childError);
    const successorError = page.waitForEvent('pageerror');
    await page.goto(origin + '/successor'); await loadScript(page, 'ordinary');
    result.lifecycle.successor = errorRecord(await successorError);

    const sibling = await context.newPage(); await sibling.goto(origin);
    const siblingErrors = []; sibling.on('pageerror', error => siblingErrors.push(error));
    const ownCount = observed.length;
    const siblingWait = sibling.waitForEvent('pageerror'); await loadScript(sibling, 'type'); await siblingWait;
    assert.equal(observed.length, ownCount);
    const ownWait = page.waitForEvent('pageerror'); await loadScript(page, 'ordinary'); await ownWait;
    assert.equal(siblingErrors.length, 1); result.lifecycle.pageIsolation = true;

    const burstCount = observed.length;
    const burst = page.waitForEvent('pageerror', error => error.message === 'burst-31');
    await page.evaluate(() => { for (let index = 0; index < 32; index++) setTimeout(() => { throw new Error(`burst-${index}`); }, 0); });
    await burst;
    assert.deepEqual(observed.slice(burstCount).map(error => error.message), Array.from({ length: 32 }, (_, index) => `burst-${index}`));
    result.lifecycle.orderedBurst = 32;

    const closed = assert.rejects(page.waitForEvent('pageerror'), /closed/i);
    await page.close(); await closed;
    assert.equal(page.listenerCount('pageerror'), originalCount);
    assert.equal(await sibling.evaluate(() => 42), 42);
    result.lifecycle.closeSettlesWaitAndSiblingSurvives = true;
  } finally { await browser.close(); }
}
try {
  await run('reference', referenceChromium);
  await run('flashwright', flashwrightChromium);
  assert.deepEqual(report.outcomes.flashwright, report.outcomes.reference);
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.failure = { name: error.name, message: error.message, stack: error.stack }; throw error; }
finally {
  for (const socket of sockets) socket.destroy();
  await new Promise(resolve => server.close(resolve));
  report.sourceChangedDuringVerification = JSON.stringify(report.sources) !== JSON.stringify(await sourceManifest());
  if (report.sourceChangedDuringVerification) { report.status = 'failed'; process.exitCode = 1; }
  await writeFile(join(destination, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`Diagnostic differential ${report.status}: ${destination}/report.json`);
}
