import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { chromium } from 'flashwright';
import { sourceManifest } from './source-manifest.mjs';

const output = resolve(process.argv[2]); await mkdir(output);
const control = process.env.FLASHWRIGHT_SCREENSHOT_LIFETIME_DIRECTORY;
assert(control); await mkdir(control, { recursive: true });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const report = { status: 'running', scope: 'Original remote screenshot preparation/restoration ownership under held genuine native replies. No performance claim.', sources: await sourceManifest(),
  browserSha256: hash(await readFile(process.env.FLASHWRIGHT_PROFILE_BROWSER_PATH)), driverSha256: hash(await readFile(process.env.FLASHWRIGHT_DRIVER_PATH)), cases: [] };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(callback, label) {
  const deadline = Date.now() + 7000;
  while (!(await callback())) { assert(Date.now() < deadline, label); await delay(10); }
}
async function exists(path) { return readFile(path).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; }); }
let port, browser;
const server = createServer((request, response) => {
  response.setHeader('Content-Type', 'text/html');
  response.end(`<!doctype html><input style="caret-color:rgb(1, 2, 3)!important">${request.url === '/root' ? `<iframe src="http://localhost:${port}/child"></iframe>` : ''}`);
});
try {
  server.listen(0, '0.0.0.0'); await once(server, 'listening'); port = server.address().port;
  browser = await chromium.launch({ executablePath: process.env.FLASHWRIGHT_BROWSER_PATH });
  const sibling = await browser.newPage(); await sibling.goto(`http://127.0.0.1:${port}/healthy`);
  for (const [label, phase] of [['late-prepare', 'prepare'], ['unsettled-prepare', 'prepare'], ['destroyed-prepare', 'prepare'], ['unsettled-restore', 'restore']]) {
    const page = await browser.newPage(); await page.goto(`http://127.0.0.1:${port}/root`);
    const child = page.frames().find(frame => frame !== page.mainFrame()); assert(child);
    assert.equal(await child.evaluate(() => document.querySelector('input').style.caretColor), 'rgb(1, 2, 3)');
    const temporary = join(control, 'next.json');
    await writeFile(temporary, JSON.stringify({ label, phase })); await rename(temporary, join(control, 'control.json'));
    const capture = page.screenshot({ timeout: label === 'late-prepare' ? 1000 : label === 'unsettled-prepare' ? 250 : 5000 }).then(bytes => ({ bytes: bytes.length }), error => ({ error: { name: error.name, message: error.message } }));
    const heldFile = join(control, `held-${label}.json`);
    await until(() => exists(heldFile), `${label} must hold a genuine remote reply`);
    const held = JSON.parse(await readFile(heldFile)); assert.equal(held.remote, true);
    if (label === 'late-prepare') {
      // Release after the public deadline but inside the bounded original-reply recovery.
      await delay(1100); await writeFile(join(control, `release-${label}`), '');
    } else if (label === 'destroyed-prepare') {
      await page.evaluate(() => document.querySelector('iframe').remove());
    }
    const outcome = await capture;
    if (label === 'destroyed-prepare') {
      assert(outcome.bytes > 0, JSON.stringify(outcome)); assert.equal(page.isClosed(), false);
      assert.equal(await page.evaluate(() => 42), 42);
    } else if (label === 'late-prepare') {
      assert.equal(outcome.error?.name, 'TimeoutError'); assert.equal(page.isClosed(), false);
      assert.equal(await child.evaluate(() => document.querySelector('input').style.caretColor), 'rgb(1, 2, 3)');
    } else {
      assert.equal(outcome.error?.name, phase === 'restore' ? 'ProtocolError' : 'TimeoutError');
      await until(() => page.isClosed(), 'unconfirmed cleanup must retire its page');
    }
    assert.equal(await sibling.evaluate(() => 42), 42);
    await writeFile(join(control, `release-${label}`), '');
    await until(() => exists(join(control, `released-${label}`)), 'original native reply must be released');
    report.cases.push({ label, phase, held, outcome, pageRetired: page.isClosed() });
    if (!page.isClosed()) await page.close();
  }
  await sibling.close(); await browser.close(); browser = undefined;
  report.protocol = [];
  for (const file of (await readdir(process.env.FLASHWRIGHT_PROFILE_PROTOCOL_DIRECTORY)).filter(name => name.endsWith('.jsonl'))) {
    const bytes = await readFile(join(process.env.FLASHWRIGHT_PROFILE_PROTOCOL_DIRECTORY, file));
    const rows = bytes.toString().trim().split('\n').map(JSON.parse);
    const factories = new Map(rows.filter(row => row.kind === 'screenshotReply' && row.phase === 'prepare' && row.object).map(row => [`${row.session}:${row.object}`, row]));
    const restorations = rows.filter(row => row.kind === 'screenshotSent' && row.phase === 'restore');
    for (const row of restorations) assert(factories.has(`${row.session}:${row.object}`), 'restore must address the original session and factory');
    assert(restorations.some(row => row.remote));
    assert(rows.filter(row => row.kind === 'screenshotSent' && row.phase === 'prepare').every(row => typeof row.context === 'string' && row.context.length > 0));
    const recovered = report.cases.find(item => item.label === 'late-prepare').held;
    const restoredAt = rows.findIndex(row => row.kind === 'screenshotSent' && row.phase === 'restore' && row.session === recovered.session && row.object === recovered.object);
    assert(restoredAt >= 0);
    // Explicit page closure and child removal legitimately retire their renderer sessions.
    assert(!rows.slice(0, restoredAt).some(row => row.kind === 'detachRequested' && row.session === recovered.session), 'late preparation must restore through its still-owned original session');
    assert.equal(rows.filter(row => row.kind === 'screenshotReplyReleased').length, 4);
    const exit = rows.findLast(row => row.kind === 'exit'); assert.equal(exit.exitCode, 0); assert.deepEqual(exit.failures, []);
    report.protocol.push({ file, sha256: hash(bytes), factories: factories.size, restorations: restorations.length });
  }
  assert.equal(report.protocol.length, 1);
  report.status = 'passed';
} catch (error) { report.failure = { name: error.name, message: error.message, stack: error.stack }; throw error; }
finally {
  await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  report.sourceChangedDuringVerification = JSON.stringify(report.sources) !== JSON.stringify(await sourceManifest());
  if (report.sourceChangedDuringVerification) { report.status = 'failed'; process.exitCode = 1; }
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
}
