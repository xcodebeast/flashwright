import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const [engine, directory] = process.argv.slice(2);
assert(['reference', 'candidate'].includes(engine));
const { chromium } = await import(engine === 'reference' ? 'playwright' : 'flashwright');
const messages = [], contextMessages = [], order = [], checks = [];
const report = { engine, checks, status: 'running', scope: 'Live remote-frame console events and original argument ownership. Worker logs, history, broad log-source coverage and performance remain outside this fixture.' };
async function assertRetired(handle) {
  await assert.rejects(handle.jsonValue(), error => {
    assert.match(error.message, /execution context (was destroyed|is not available)|has been disposed|has been closed|frame was detached|cannot find context with specified id/i);
    if (engine === 'candidate') assert(['TargetClosedError', 'EvaluationError'].includes(error.name), error.name);
    return true;
  });
}
let port, browser, context;
const server = createServer((request, response) => {
  const label = new URL(request.url, `http://${request.headers.host}`).pathname.slice(1) || 'root';
  response.setHeader('Content-Type', 'text/html');
  response.setHeader('Cache-Control', 'no-store');
  const child = label === 'root' ? `<iframe id="child" src="http://localhost:${port}/child"></iframe>`
    : label === 'child' ? `<iframe id="nested" src="http://127.0.0.2:${port}/nested"></iframe>` : '';
  response.end(`<link rel="icon" href="data:,"><body><script>globalThis.subject={label:${JSON.stringify(label)},value:42};console.log('entry',subject,document.body);</script>${child}</body>`);
});
await new Promise(resolve => server.listen(0, '0.0.0.0', resolve));
port = server.address().port;
async function until(predicate) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('Console fixture readiness exceeded five seconds');
}
try {
  browser = await chromium.launch({ executablePath: process.env.FLASHWRIGHT_BROWSER_PATH });
  context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  const onPage = message => {
    if (message.text().startsWith('entry')) { messages.push(message); order.push(['page', message]); }
  };
  const onContext = message => {
    if (message.text().startsWith('entry')) { contextMessages.push(message); order.push(['context', message]); }
  };
  page.on('console', onPage);
  context.on('console', onContext);
  await page.goto(`http://127.0.0.1:${port}/root`);
  await until(() => messages.length === 3 && contextMessages.length === 3);
  const byLabel = new Map();
  for (const message of messages) {
    assert.equal(message.page(), page);
    assert.equal(message.worker(), null);
    assert.equal(message.type(), 'log');
    assert(Number.isFinite(message.timestamp()));
    assert(contextMessages.includes(message));
    assert.deepEqual(order.filter(item => item[1] === message).map(item => item[0]), ['page', 'context']);
    const handle = message.args()[1], value = await handle.jsonValue();
    byLabel.set(value.label, message);
    assert.equal(value.value, 42);
    assert.equal(await handle.evaluate(object => object === globalThis.subject), true);
    assert.equal(await handle.evaluate(object => ++object.value), 43);
    assert.equal(await message.args()[2].evaluate(element => element === document.body), true);
    assert(message.args()[2].asElement());
    assert.equal(new URL(message.location().url).pathname, '/' + value.label);
  }
  assert.deepEqual([...byLabel.keys()].sort(), ['child', 'nested', 'root']);
  checks.push('early-remote-console-and-original-realm-handles');

  const remoteChild = page.frames().find(frame => frame.url().endsWith('/child'));
  assert(remoteChild);
  const burstPage = [], burstContext = [], burstOrder = [];
  const recordBurst = (owner, target) => message => {
    if (message.text().startsWith('burst-')) { target.push(message); burstOrder.push([owner, message]); }
  };
  const pageBurstListener = recordBurst('page', burstPage);
  const contextBurstListener = recordBurst('context', burstContext);
  page.on('console', pageBurstListener); context.on('console', contextBurstListener);
  await remoteChild.evaluate(() => { for (let index = 0; index < 128; index++) console.log(`burst-evaluate-${index}`); });
  assert.deepEqual(burstPage.map(message => message.text()), Array.from({ length: 128 }, (_, index) => `burst-evaluate-${index}`));
  assert.deepEqual(burstContext, burstPage);
  const evaluatedHandle = await remoteChild.evaluateHandle(() => {
    for (let index = 0; index < 32; index++) console.log(`burst-handle-${index}`);
    return { answer: 42 };
  });
  assert.deepEqual(burstPage.slice(128).map(message => message.text()), Array.from({ length: 32 }, (_, index) => `burst-handle-${index}`));
  assert.deepEqual(burstContext, burstPage);
  for (const message of burstPage) {
    assert.equal(message.page(), page);
    assert.deepEqual(burstOrder.filter(item => item[1] === message).map(item => item[0]), ['page', 'context']);
    for (const handle of message.args()) await handle.dispose();
  }
  await evaluatedHandle.dispose();
  page.off('console', pageBurstListener); context.off('console', contextBurstListener);
  checks.push('remote-console-bursts-precede-evaluate-and-handle-replies');

  const originalChild = byLabel.get('child').args()[1];
  const originalNested = byLabel.get('nested').args()[1];
  await page.locator('#child').evaluate((element, url) => { element.src = url; }, `http://127.0.0.1:${port}/replacement`);
  await until(() => messages.length === 4);
  await assertRetired(originalChild);
  await assertRetired(originalNested);
  assert.equal((await byLabel.get('root').args()[1].jsonValue()).value, 43);
  checks.push('remote-to-local-navigation-retires-only-original-arguments');

  const replacement = messages[3];
  assert.equal((await replacement.args()[1].jsonValue()).label, 'replacement');
  await page.locator('#child').evaluate((element, url) => { element.src = url; }, `http://localhost:${port}/successor`);
  await until(() => messages.length === 5);
  await assertRetired(replacement.args()[1]);
  const successor = messages[4];
  assert.equal((await successor.args()[1].jsonValue()).label, 'successor');
  checks.push('local-to-remote-navigation-owns-successor-arguments');

  await page.locator('#child').evaluate(element => element.remove());
  await assertRetired(successor.args()[1]);
  assert.equal(await page.evaluate(() => subject.value), 43);
  checks.push('frame-removal-retires-arguments-keeps-root-usable');

  page.off('console', onPage);
  await page.evaluate(url => {
    const child = document.createElement('iframe'); child.src = url; document.body.append(child);
  }, `http://localhost:${port}/context-only`);
  await until(() => contextMessages.length === 6);
  assert.equal(messages.length, 5);
  const contextOnly = contextMessages[5];
  assert.equal(contextOnly.page(), page);
  const retained = contextOnly.args()[1];
  assert.equal((await retained.jsonValue()).label, 'context-only');
  checks.push('context-only-remote-subscription-retains-public-page-owner');

  context.off('console', onContext);
  const remote = page.frames().find(frame => frame.url().endsWith('/context-only'));
  assert(remote);
  await remote.evaluate(() => { console.log('unobserved-remote', { privateArgument: true }); });
  assert.equal(await retained.evaluate(object => object.label), 'context-only');
  assert.equal(contextMessages.length, 6);
  checks.push('unobserved-remote-event-leaves-live-handles-usable');

  for (const message of new Set([...messages, ...contextMessages])) {
    for (const handle of message.args()) if (handle !== retained) await handle.dispose();
  }
  assert.equal((await retained.jsonValue()).label, 'context-only');
  await context.close(); context = undefined;
  await assertRetired(retained);
  await retained.dispose();
  checks.push('context-close-retires-undisposed-original-remote-argument');
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.error = error.stack; process.exitCode = 1;
} finally {
  await context?.close(); await browser?.close();
  await new Promise(resolve => server.close(resolve));
  await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
}
