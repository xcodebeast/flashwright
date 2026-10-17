import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('../packages/flashwright-core/dist/commonjs/index.js');
const { utils, iso } = require('playwright-core/lib/coreBundle');
const output = resolve(process.argv[2]);
await mkdir(output);
const protocol = join(output, 'protocol');
await mkdir(protocol);
const realBrowser = process.env.FLASHWRIGHT_BROWSER_PATH;
process.env.FLASHWRIGHT_PROFILE_BROWSER_PATH = realBrowser;
process.env.FLASHWRIGHT_PROFILE_PROTOCOL_DIRECTORY = protocol;
process.env.FLASHWRIGHT_PROFILE_CLOCK_PORT = '0';
process.env.FLASHWRIGHT_SNAPSHOT_RETIREMENT_DIRECTORY = output;
const server = createServer((request, response) => {
  response.setHeader('content-type', 'text/html');
  response.end(`<title>${request.url}</title><div><span>original content</span></div>`);
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const origin = `http://127.0.0.1:${server.address().port}`;
const report = { status: 'running', checks: [] };
let browser;
async function waitFile(path) {
  for (let attempt = 0; attempt < 500; attempt++) {
    try { return JSON.parse(await readFile(path, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await delay(10);
  }
  throw new Error(`Native reply was not held: ${path}`);
}
try {
  browser = await chromium.launch({ executablePath: resolve('tools/snapshot-retirement-proxy.py') });
  const context = await browser.newContext();
  const page = await context.newPage();
  await context.tracing.start({ snapshots: true });
  await page.goto(`${origin}/same-document`);
  await page.title();
  const protocolEvents = async () => {
    const files = await readdir(protocol);
    assert.equal(files.length, 1);
    return (await readFile(join(protocol, files[0]), 'utf8')).trim().split('\n').map(JSON.parse);
  };
  const clearsBefore = (await protocolEvents()).filter(event => event.kind === 'nativeLifetime' && event.method === 'Runtime.executionContextsCleared').length;
  await page.setContent('<title>replacement content</title><div>replacement body</div>');
  await page.goto(`${origin}/same-document#fragment`);
  await page.evaluate(() => history.pushState({}, '', '#history'));
  assert.equal(await page.title(), 'replacement content');
  const clearsAfter = (await protocolEvents()).filter(event => event.kind === 'nativeLifetime' && event.method === 'Runtime.executionContextsCleared').length;
  assert.equal(clearsAfter, clearsBefore, 'document.open and same-document history preserve the original context');
  report.checks.push({ name: 'setContent and same-document history preserve the context' });
  // Exceed the 32-document context limit while keeping the page/session healthy.
  for (let index = 0; index < 40; index++) {
    const destination = index % 10 === 0 ? origin.replace('127.0.0.1', 'localhost') : origin;
    await page.goto(`${destination}/navigation-${index}`);
    assert.equal(await page.title(), `/navigation-${index}`);
  }
  const archivePath = join(output, 'navigation.zip');
  await context.tracing.stop({ path: archivePath });
  const archive = new utils.ZipFile(archivePath);
  try {
    const records = (await archive.read('trace.trace')).toString().trim().split('\n').map(JSON.parse);
    const snapshots = records.filter(record => record.type === 'frame-snapshot').map(record => record.snapshot);
    const storage = new iso.SnapshotStorage();
    let final;
    for (const snapshot of snapshots) final = storage.addFrameSnapshot('context', snapshot, []).render().html;
    assert.ok(final.includes('/navigation-39'));
    assert.ok(snapshots.length >= 80);
    report.checks.push({ name: '40 navigations with recapture and archive replay', snapshots: snapshots.length });
  } finally { archive.close(); }
  for (const label of ['acknowledgement', 'navigation']) {
    await context.tracing.start({ snapshots: true });
    await page.title();
    await writeFile(join(output, 'control.json'), JSON.stringify({ label }));
    let settled = false;
    const stop = context.tracing.stop().finally(() => { settled = true; });
    // Attach a rejection handler while the original promise remains under observation.
    void stop.catch(() => {});
    const held = await waitFile(join(output, `held-${label}.json`));
    await delay(100);
    assert.equal(settled, false, 'cleanup must retain ownership while its native acknowledgement is held');
    const heldEvents = await protocolEvents();
    const heldFactory = heldEvents.find(event => event.kind === 'factoryReply' && event.object === held.object && event.session === held.session);
    assert.ok(heldFactory);
    assert.equal(heldEvents.some(event => event.kind === 'groupReleased' && event.session === heldFactory.session && event.group === heldFactory.group), false);
    assert.equal(await page.title(), '/navigation-39');
    if (label === 'navigation') {
      await page.goto(`${origin}/after-held-retirement`);
      await stop;
      assert.equal(await page.title(), '/after-held-retirement');
    }
    await writeFile(join(output, `release-${label}`), 'release');
    await stop;
    report.checks.push({ name: `held retirement settles on ${label}`, session: held.session, object: held.object });
  }
  await context.tracing.start({ snapshots: true });
  await page.title();
  await context.tracing.stop();
  await context.close();
  await browser.close(); browser = undefined;
  const files = await readdir(protocol);
  assert.equal(files.length, 1);
  const events = (await readFile(join(protocol, files[0]), 'utf8')).trim().split('\n').map(JSON.parse);
  const factories = events.filter(event => event.kind === 'factoryReply');
  assert.ok(factories.length >= 40);
  const clears = events.filter(event => event.kind === 'nativeLifetime' && event.method === 'Runtime.executionContextsCleared');
  assert.ok(clears.length >= 40);
  const destroyed = events.filter(event => event.kind === 'nativeLifetime' && event.method === 'Runtime.executionContextDestroyed');
  const clearOnly = factories.filter(factory => clears.some(event => event.session === factory.session)
    && !destroyed.some(event => event.session === factory.session && event.params.executionContextUniqueId === factory.context));
  assert.ok(clearOnly.length >= 32, 'normal navigation must exercise clear without unique destruction');
  for (const label of ['acknowledgement', 'navigation']) {
    const sent = events.find(event => event.kind === 'retirementSent' && event.label === label);
    const factory = factories.find(event => event.session === sent.session && event.object === sent.object);
    assert.ok(factory, 'retirement targets the exact installed factory');
    const releaseIndex = events.findIndex(event => event.kind === 'groupReleased' && event.session === factory.session && event.group === factory.group);
    const sentIndex = events.indexOf(sent);
    assert.ok(releaseIndex > sentIndex);
    if (label === 'navigation') assert.ok(events.slice(sentIndex, releaseIndex).some(event => event.kind === 'nativeLifetime' && event.method === 'Runtime.executionContextsCleared' && event.session === factory.session));
  }
  report.native = { factories: factories.length, clears: clears.length, clearOnlyFactories: clearOnly.length };
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.error = error.stack; process.exitCode = 1;
} finally {
  for (const label of ['acknowledgement', 'navigation']) await writeFile(join(output, `release-${label}`), 'release');
  await browser?.close();
  server.close(); await once(server, 'close');
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
}
