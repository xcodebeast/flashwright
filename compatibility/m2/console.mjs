import { runtimeMetadata, runtimeArtifactLabel } from '../../tools/javascript-runtime.mjs';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium as referenceChromium } from 'playwright';
import { chromium as flashwrightChromium, ConsoleMessage, JSHandle } from 'flashwright';
import { sourceManifest } from '../../tools/source-manifest.mjs';
import { identifyBrowser } from '../../tools/browser-identity.mjs';

const destination = `compatibility/evidence/console-${process.platform}-${process.arch}-${runtimeArtifactLabel}-${new Date().toISOString().replaceAll(':', '-')}`;
await mkdir(destination, { recursive: true });
const report = {
  schemaVersion: 1, reference: '1.60.0', sources: await sourceManifest(),
  browser: await identifyBrowser(process.env.FLASHWRIGHT_BROWSER_PATH ?? referenceChromium.executablePath()),
  driverSha256: createHash('sha256').update(await readFile(process.env.FLASHWRIGHT_DRIVER_PATH)).digest('hex'),
  ...runtimeMetadata, platform: process.platform, architecture: process.arch, outcomes: {}, referenceDifferences: {}, status: 'running',
  scope: 'Live page/context console delivery, argument ownership, message diagnostics, main-world same-process frames and listener lifecycle. Workers, out-of-process frames and console history remain outside this slice. No performance claim.',
};
await writeFile(join(destination, 'report.json'), JSON.stringify(report, null, 2) + '\n');
const scripts = new Map([
  ['primitives', 'console.log("plain", 42, -0, NaN, Infinity, -Infinity, undefined, null, true, "é😃\\ud800_\\udfff\\u0000");'],
  ['format', 'console.log("%s:%d", "word", 7);'],
  ['object', 'globalThis.consoleObject = {answer: 42, nested: {value: 7}, get getter() { throw new Error("getter"); }, "é\\ud800": "\\udfff"};\nconsole.log(consoleObject, consoleObject);'],
  ['sparse', 'console.log([1, , , 4], Array.from({length: 150}, (_, index) => index));'],
  ['classes', 'console.log(new Map([["key", 7]]), /hello/gi, Symbol("unique"), value => value + 1);'],
  ['node', 'console.log(document.body);'],
  ['levels', 'console.warn("warning"); console.error("error"); console.info("info"); console.debug("debug");\nconsole.assert(false, "assertion", 42); console.trace("trace"); console.dir({answer: 42}); console.dirxml(document.body);\nconsole.table([{column: 1}]); console.group("group"); console.groupCollapsed("collapsed"); console.groupEnd(); console.groupEnd();\nconsole.count("count"); console.countReset("count");'],
  ['clear', 'console.clear(); console.log("after clear");'],
  ['bigint', 'console.log(12345678901234567890n);'],
  ['child', 'globalThis.childObject = {label: "original child"}; console.log("child", childObject);'],
]);
const sockets = new Set();
const server = createServer((request, response) => {
  const url = new URL(request.url, 'http://fixture');
  if (url.pathname === '/console.js') {
    response.setHeader('content-type', 'text/javascript; charset=utf-8'); response.end(scripts.get(url.searchParams.get('case'))); return;
  }
  if (url.pathname === '/missing') { response.writeHead(404); response.end('missing'); return; }
  response.setHeader('content-type', 'text/html; charset=utf-8');
  response.end('<!doctype html><title>Console</title>' + (url.pathname === '/child' ? '<script src="/console.js?case=child"></script>' : ''));
});
server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const origin = `http://127.0.0.1:${server.address().port}`;
async function loadScript(page, label) {
  await page.evaluate(url => new Promise(resolve => {
    const script = document.createElement('script'); script.src = url;
    script.onload = () => resolve(true); document.body.appendChild(script);
  }), `${origin}/console.js?case=${label}`);
}
function snapshot(message, page, name) {
  assert.equal(message.page(), page); assert.equal(message.worker(), null);
  assert(Number.isFinite(message.timestamp()) && Math.abs(message.timestamp() - Date.now()) < 60000);
  assert.notEqual(message.args(), message.args()); assert.deepEqual(message.args(), message.args());
  const location = message.location(); assert.notEqual(location, message.location());
  assert.equal(location.line, location.lineNumber); assert.equal(location.column, location.columnNumber);
  const original = location.url; location.url = 'modified'; assert.equal(message.location().url, original);
  if (name === 'flashwright') { assert(message instanceof ConsoleMessage); for (const handle of message.args()) assert(handle instanceof JSHandle); }
  return { type: message.type(), text: message.text(), previews: message.args().map(handle => handle.toString()), location: { ...message.location(), url: original.replaceAll(origin, '<origin>') } };
}
async function disposeMessages(messages) { for (const message of messages) for (const handle of message.args()) await handle.dispose(); }

async function run(name, chromium) {
  const browser = await chromium.launch({ executablePath: report.browser.executablePath });
  const outcome = report.outcomes[name] = {};
  try {
    const context = await browser.newContext(); context.setDefaultTimeout(5000);
    const page = await context.newPage(); await page.goto(origin);
    const messages = []; const contextMessages = []; const delivery = [];
    const pageListener = message => { messages.push(message); delivery.push(['page', message]); };
    const contextListener = message => { contextMessages.push(message); delivery.push(['context', message]); };
    page.on('console', pageListener); context.on('console', contextListener);
    outcome.messages = {};
    for (const label of ['primitives', 'format', 'object', 'sparse', 'classes', 'node', 'levels']) {
      console.log(`${name}: message ${label}`);
      const start = messages.length;
      const count = label === 'levels' ? 14 : 1;
      const received = page.waitForEvent('console', () => messages.length === start + count);
      await loadScript(page, label); await received;
      const current = messages.slice(start);
      assert.equal(current.length, count);
      outcome.messages[label] = current.map(message => snapshot(message, page, name));
    }
    assert.deepEqual(contextMessages, messages);
    for (let index = 0; index < messages.length; index++) assert.deepEqual(delivery.slice(index * 2, index * 2 + 2), [['page', messages[index]], ['context', messages[index]]]);
    outcome.pageBeforeContextWithSharedIdentity = true;
    console.log(`${name}: arguments`);
    const primitiveArguments = messages[0].args();
    const primitiveValues = ['plain', 42, -0, NaN, Infinity, -Infinity, undefined, null, true, 'é😃\ud800_\udfff\u0000'];
    for (let index = 0; index < primitiveValues.length; index++) assert.deepEqual(await primitiveArguments[index].jsonValue(), primitiveValues[index]);
    outcome.exactPrimitiveArguments = primitiveValues.length;

    console.log(`${name}: objects`);
    const objectMessage = messages[2]; const [first, second] = objectMessage.args();
    assert.equal(await page.evaluate(([first, second]) => first === second && first === consoleObject, [first, second]), true);
    await first.dispose();
    assert.equal(await second.evaluate(value => value.nested.value), 7);
    const property = await second.getProperty('nested'); await second.dispose();
    assert.deepEqual(await property.jsonValue(), { value: 7 }); await property.dispose();
    console.log(`${name}: classes`);
    const classes = messages[4].args();
    assert.equal(await classes[0].evaluate(value => value.get('key')), 7);
    assert.deepEqual(await classes[1].jsonValue(), /hello/gi);
    assert.equal(await classes[2].evaluate(value => value.description), 'unique');
    assert.equal(await classes[3].evaluate(value => value(41)), 42);
    const element = messages[5].args()[0]; assert.equal(element.asElement(), element);
    assert.equal(await element.evaluate(value => value === document.body), true);
    await disposeMessages(messages); outcome.independentLiveArgumentsAndProperties = true;

    console.log(`${name}: clear`);
    const invalidated = page.waitForEvent('console');
    await page.evaluate(() => console.log({ invalidated: true }));
    const obsoleteArgument = (await invalidated).args()[0];
    const privateHandle = await page.evaluateHandle(() => ({ owned: true }));
    const cleared = page.waitForEvent('console', message => message.text() === 'after clear');
    const beforeClear = messages.length; await loadScript(page, 'clear'); await cleared;
    outcome.messages.clear = messages.slice(beforeClear).map(message => snapshot(message, page, name));
    await disposeMessages(messages.slice(beforeClear));
    await assert.rejects(obsoleteArgument.jsonValue(), /context|object/i);
    await obsoleteArgument.dispose();
    assert.deepEqual(await privateHandle.jsonValue(), { owned: true }); await privateHandle.dispose();
    assert.equal(await page.evaluate(() => 42), 42);
    outcome.clearInvalidatesConsoleReferencesWithoutClosingPage = true;
    const big = page.waitForEvent('console'); await loadScript(page, 'bigint'); const bigMessage = await big;
    const bigValue = await bigMessage.args()[0].jsonValue();
    report.referenceDifferences[name] = { text: bigMessage.text(), preview: bigMessage.args()[0].toString(), valueType: typeof bigValue, valueText: String(bigValue), argument: await page.evaluate(value => ({ type: typeof value, text: String(value) }), bigMessage.args()[0]) };
    await disposeMessages([bigMessage]);

    console.log(`${name}: listeners`);
    const beforeBurst = messages.length;
    await page.evaluate(() => { for (let index = 0; index < 128; index++) console.log(`burst-${index}`); });
    assert.deepEqual(messages.slice(beforeBurst).map(message => message.text()), Array.from({ length: 128 }, (_, index) => `burst-${index}`));
    await disposeMessages(messages.slice(beforeBurst)); outcome.consoleEventsPrecedeEvaluationReply = 128;
    const beforeHandleBurst = messages.length;
    const evaluatedHandle = await page.evaluateHandle(() => { for (let index = 0; index < 32; index++) console.log(`handle-${index}`); return { answer: 42 }; });
    assert.deepEqual(messages.slice(beforeHandleBurst).map(message => message.text()), Array.from({ length: 32 }, (_, index) => `handle-${index}`));
    await evaluatedHandle.dispose(); await disposeMessages(messages.slice(beforeHandleBurst)); outcome.consoleEventsPrecedeHandleReply = 32;
    page.off('console', pageListener); context.off('console', contextListener);
    outcome.listenerForms = [];
    for (const owner of [page, context]) {
      for (const registration of ['on', 'addListener', 'once', 'prependListener', 'prependOnceListener']) {
        const observed = []; const listener = message => observed.push(message);
        assert.equal(owner[registration]('console', listener), owner);
        await page.evaluate(() => console.log('registered'));
        // A second ordinary call drains transport events without introducing a timer dependency.
        await page.evaluate(() => 42);
        assert.deepEqual(observed.map(message => message.text()), ['registered']);
        owner.removeListener('console', listener); assert.equal(owner.listenerCount('console'), 0);
        await page.evaluate(() => console.log('removed')); await page.evaluate(() => 42);
        assert.equal(observed.length, 1); await disposeMessages(observed);
        outcome.listenerForms.push(`${owner === page ? 'page' : 'context'}.${registration}`);
      }
      const observed = []; const listener = message => observed.push(message);
      owner.on('console', listener); owner.removeAllListeners('console');
      assert.equal(owner.listenerCount('console'), 0);
      owner.on('console', listener); await page.evaluate(() => console.log('reattached')); await page.evaluate(() => 42);
      assert.deepEqual(observed.map(message => message.text()), ['reattached']);
      owner.off('console', listener); await disposeMessages(observed);
    }
    // The pinned reference stores its close resolver as a public context listener.
    // Isolate removeAllListeners() here; browser teardown owns this context afterward.
    const allListenersContext = await browser.newContext();
    const allListenersPage = await allListenersContext.newPage();
    for (const owner of [allListenersPage, allListenersContext]) {
      const observed = []; const listener = message => observed.push(message);
      owner.on('console', listener); owner.removeAllListeners();
      assert.equal(owner.listenerCount('console'), 0);
      owner.on('console', listener); await allListenersPage.evaluate(() => console.log('after removeAll'));
      await allListenersPage.evaluate(() => 42);
      assert.deepEqual(observed.map(message => message.text()), ['after removeAll']);
      owner.off('console', listener); await disposeMessages(observed);
    }
    outcome.removeAllAndReattach = true;
    console.log(`${name}: predicates`);
    const wait = context.waitForEvent('console', { predicate: async message => message.text() === 'accepted' });
    await page.evaluate(() => { console.log('ignored'); console.log('accepted'); });
    const accepted = await wait; assert.equal(accepted.page(), page); await disposeMessages([accepted]);
    assert.equal(context.listenerCount('console'), 0);
    const failure = new Error('predicate failed');
    const rejected = assert.rejects(page.waitForEvent('console', () => { throw failure; }), error => error === failure);
    await page.evaluate(() => console.log('rejected')); await rejected;
    await assert.rejects(context.waitForEvent('console', { timeout: 25 }), error => error.name === 'TimeoutError');
    assert.equal(page.listenerCount('console'), 0); assert.equal(context.listenerCount('console'), 0);
    outcome.predicateFailureTimeoutAndCleanup = true;

    console.log(`${name}: concurrent`);
    const pendingEvaluation = page.evaluate(() => new Promise(resolve => { globalThis.completeConsoleEvaluation = resolve; console.log('pending', { answer: 42 }); }));
    // Install before a fresh emission so neither backend relies on retained message history.
    const duringEvaluation = context.waitForEvent('console');
    await page.evaluate(async () => { while (!globalThis.completeConsoleEvaluation) await new Promise(resolve => setTimeout(resolve, 0)); console.log('concurrent', { answer: 42 }); });
    const concurrent = await duringEvaluation;
    // The initial pending message may be delivered after the subscription reaches Chromium.
    assert(['pending', 'concurrent'].includes(concurrent.args()[0].toString()));
    assert.equal(await concurrent.args()[1].evaluate(value => value.answer), 42);
    await page.evaluate(() => completeConsoleEvaluation(42)); assert.equal(await pendingEvaluation, 42);
    await disposeMessages([concurrent]); outcome.concurrentEvaluation = true;

    console.log(`${name}: frames`);
    const childWait = context.waitForEvent('console', message => message.text().startsWith('child '));
    await page.evaluate(url => new Promise(resolve => { const frame = document.createElement('iframe'); frame.name = 'child'; frame.src = url; frame.onload = () => resolve(true); document.body.appendChild(frame); }), origin + '/child');
    const child = await childWait; const childObject = child.args()[1];
    assert.equal(child.page(), page); assert.equal(await childObject.evaluate(value => value === childObject), true);
    await assert.rejects(page.evaluate(value => value, childObject), /context/i);
    outcome.childFrame = snapshot(child, page, name);
    await page.evaluate(() => document.querySelector('iframe').remove());
    await assert.rejects(childObject.jsonValue(), /context|detach|closed/i); await disposeMessages([child]);
    const future = context.waitForEvent('console'); const sibling = await context.newPage(); await sibling.goto(origin);
    await sibling.evaluate(() => console.log('future page')); const futureMessage = await future;
    assert.equal(futureMessage.page(), sibling); await disposeMessages([futureMessage]); outcome.futurePagesAndFrameOwnership = true;
    console.log(`${name}: successor`);
    const successor = page.waitForEvent('console'); await page.goto(origin); await page.evaluate(() => console.log('successor'));
    assert.equal((await successor).text(), 'successor'); await disposeMessages([await successor]); outcome.successorDocument = true;

    console.log(`${name}: network`);
    const networkLog = page.waitForEvent('console', message => message.type() === 'error' && message.location().url.endsWith('/missing'));
    await page.evaluate(async url => { await fetch(url); }, origin + '/missing'); const log = await networkLog;
    assert.equal(log.args().length, 0); outcome.browserLog = snapshot(log, page, name);
    console.log(`${name}: close`);
    const closedPage = assert.rejects(page.waitForEvent('console'), /closed/i);
    await page.close(); await closedPage;
    const closedContext = assert.rejects(context.waitForEvent('console'), /closed/i);
    await context.close(); await closedContext; outcome.closeRejectsWaits = true;
  } finally { await browser.close(); }
}
try {
  await run('reference', referenceChromium); await run('flashwright', flashwrightChromium);
  assert.deepEqual(report.outcomes.flashwright, report.outcomes.reference);
  assert.deepEqual(report.referenceDifferences.reference, { text: 'undefined', preview: 'undefined', valueType: 'undefined', valueText: 'undefined', argument: { type: 'undefined', text: 'undefined' } });
  assert.deepEqual(report.referenceDifferences.flashwright, { text: '12345678901234567890', preview: '12345678901234567890', valueType: 'bigint', valueText: '12345678901234567890', argument: { type: 'bigint', text: '12345678901234567890' } });
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.failure = { name: error.name, message: error.message, stack: error.stack }; throw error;
} finally {
  for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve));
  report.sourceChangedDuringVerification = JSON.stringify(report.sources) !== JSON.stringify(await sourceManifest());
  if (report.sourceChangedDuringVerification) { report.status = 'failed'; process.exitCode = 1; }
  await writeFile(join(destination, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`Console differential ${report.status}: ${destination}/report.json`);
}
