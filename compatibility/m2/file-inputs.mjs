import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium as referenceChromium } from 'playwright';
import { chromium as flashwrightChromium } from 'flashwright';
import { sourceManifest } from '../../tools/source-manifest.mjs';
import { identifyBrowser } from '../../tools/browser-identity.mjs';
import { createHttpFixture } from '../../tools/http-fixture.mjs';
import { runtimeMetadata, runtimeArtifactLabel } from '../../tools/javascript-runtime.mjs';

const destination = `compatibility/evidence/file-inputs-${process.platform}-${process.arch}-${runtimeArtifactLabel}-${new Date().toISOString().replaceAll(':', '-')}`;
await mkdir(destination, { recursive: true });
const temporary = await mkdtemp(join(tmpdir(), 'flashwright-file-inputs-'));
const report = { schemaVersion: 1, reference: '1.60.0', sources: await sourceManifest(), ...runtimeMetadata,
  browser: await identifyBrowser(process.env.FLASHWRIGHT_BROWSER_PATH ?? referenceChromium.executablePath()),
  driverSha256: createHash('sha256').update(await readFile(process.env.FLASHWRIGHT_DRIVER_PATH)).digest('hex'),
  platform: process.platform, architecture: process.arch, status: 'running', outcomes: {},
  scope: 'Individual local paths and in-memory/clear assignment through Page, Frame, Locator and ElementHandle. Chooser events, directories and larger-than-32-MiB payloads are excluded. No performance claim.' };
const save = () => writeFile(join(destination, 'report.json'), JSON.stringify(report, null, 2) + '\n');
await save();
const fixture = createHttpFixture((_request, response) => {
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.end(`<!doctype html><input id="file" type="file" multiple><label id="label" for="file">files</label>
    <input class="many" type="file"><input class="many" type="file"><input id="single" type="file">
    <input id="hidden" type="file" style="display:none" disabled><input id="text"><div id="wrong">wrong</div>
    <input id="directory" type="file" webkitdirectory><div id="shadow"></div>
    <script>globalThis.events=[];for(const type of ['input','change'])document.addEventListener(type,event=>events.push({type,target:event.target.id,trusted:event.isTrusted,composed:event.composed,bubbles:event.bubbles}));document.querySelector('#shadow').attachShadow({mode:'open'}).innerHTML='<input id="shadow-file" type="file">';</script>`);
});
await new Promise(resolve => fixture.server.listen(0, '127.0.0.1', resolve));
const baseURL = `http://127.0.0.1:${fixture.server.address().port}`;
const path = join(temporary, 'local é.txt');
await writeFile(path, Buffer.from([0, 255, 128, 65]));
const linkedPath = join(temporary, 'linked.txt');
await symlink(path, linkedPath);
const hash = value => createHash('sha256').update(value).digest('hex');

/** Hash actual File bytes in the browser, including data larger than either control channel. */
async function snapshot(element) {
  return element.evaluate(async element => Promise.all([...element.files].map(async file => ({ name: file.name, type: file.type, size: file.size,
    hash: [...new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer()))].map(byte => byte.toString(16).padStart(2, '0')).join(''), relativePath: file.webkitRelativePath }))));
}
async function run(name, chromium) {
  const browser = await chromium.launch({ executablePath: report.browser.executablePath });
  const outcome = report.outcomes[name] = {};
  try {
    const context = await browser.newContext({ baseURL });
    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    await page.goto('/');
    await page.setInputFiles('#label', path);
    outcome.local = await snapshot(page.locator('#file'));
    assert.deepEqual(outcome.local, [{ name: 'local é.txt', type: 'text/plain', size: 4, hash: hash(Buffer.from([0, 255, 128, 65])), relativePath: '' }]);
    outcome.localEvents = await page.evaluate(() => events.splice(0));
    assert.deepEqual(outcome.localEvents.map(event => [event.type, event.trusted]), [['input', true], ['change', true]]);
    await page.locator('#file').setInputFiles([path, linkedPath], { noWaitAfter: true });
    assert.equal((await snapshot(page.locator('#file'))).length, 2);
    outcome.localSymlinkAndMultiple = true;
    await page.evaluate(() => events.length = 0);
    const payloads = [{ name: 'emoji-😃\ud800.TXT', mimeType: '', buffer: Buffer.from([0, 1, 255, 128]) }, { name: 'empty.json', mimeType: 'APPLICATION/JSON', buffer: Buffer.alloc(0) }];
    await page.mainFrame().setInputFiles('#file', payloads);
    outcome.buffers = await snapshot(page.locator('#file'));
    assert.equal(outcome.buffers[0].type, 'text/plain');
    assert.equal(outcome.buffers[0].name, 'emoji-😃�.TXT');
    assert.equal(outcome.buffers[0].hash, hash(payloads[0].buffer));
    assert.equal(outcome.buffers[1].type, 'application/json');
    outcome.bufferEvents = await page.evaluate(() => events.splice(0));
    assert.deepEqual(outcome.bufferEvents.map(event => [event.type, event.trusted, event.composed]), [['input', false, true], ['change', false, false]]);
    await page.locator('#file').setInputFiles([]);
    assert.deepEqual(await snapshot(page.locator('#file')), []);
    outcome.clearEvents = await page.evaluate(() => events.splice(0));
    assert.deepEqual(outcome.clearEvents.map(event => [event.type, event.trusted]), [['input', false], ['change', false]]);
    await page.locator('#hidden').setInputFiles(payloads[0]);
    await page.locator('#shadow-file').setInputFiles(payloads[0]);
    assert.equal((await snapshot(page.locator('#hidden')))[0].hash, hash(payloads[0].buffer));
    assert.equal((await snapshot(page.locator('#shadow-file')))[0].hash, hash(payloads[0].buffer));
    outcome.hiddenDisabledAndShadow = true;
    await assert.rejects(page.locator('.many').setInputFiles(path), /strict mode violation/);
    await page.setInputFiles('.many', path);
    assert.equal((await snapshot(page.locator('.many').first())).length, 1);
    assert.equal((await snapshot(page.locator('.many').last())).length, 0);
    await assert.rejects(page.setInputFiles('.many', path, { strict: true }), /strict mode violation/);
    await assert.rejects(page.locator('#single').setInputFiles(payloads), /Non-multiple/);
    await assert.rejects(page.locator('#wrong').setInputFiles(payloads[0]), /HTMLInputElement/);
    await assert.rejects(page.locator('#missing').setInputFiles(path, { timeout: 50 }), error => error.name === 'TimeoutError');
    const delayed = page.locator('#delayed').setInputFiles(payloads[0], { timeout: 0 });
    await page.evaluate(() => { const input = document.createElement('input'); input.type = 'file'; input.id = 'delayed'; document.body.append(input); });
    await delayed;
    outcome.strictnessValidationAndDelayedResolution = true;
    const original = await page.locator('#file').elementHandle();
    await page.evaluate(() => document.querySelector('#file').outerHTML = '<input id="file" type="file" multiple>');
    await original.setInputFiles(path);
    assert.equal((await snapshot(original))[0].name, 'local é.txt');
    assert.deepEqual(await snapshot(page.locator('#file')), []);
    await original.setInputFiles(payloads);
    assert.equal((await snapshot(original)).length, 2);
    await original.setInputFiles([]);
    assert.deepEqual(await snapshot(original), []);
    await original.dispose();
    await assert.rejects(original.setInputFiles(path), /disposed|closed/);
    outcome.detachedCapturedInputNeverRetargets = true;
    await page.evaluate(() => { const frame = document.createElement('iframe'); frame.src = '/child'; document.body.append(frame); });
    const frame = await new Promise(resolve => { const existing = page.frames().find(frame => frame.parentFrame()); if (existing && existing.url().endsWith('/child')) resolve(existing); else page.on('framenavigated', frame => { if (frame.parentFrame() && frame.url().endsWith('/child')) resolve(frame); }); });
    await frame.setInputFiles('#file', payloads);
    assert.deepEqual(await snapshot(frame.locator('#file')), outcome.buffers);
    outcome.sameProcessFrame = true;
    const large = Buffer.alloc(10 * 1024 * 1024 + 17);
    for (let index = 0; index < large.length; index++) large[index] = index * 31 % 251;
    await page.locator('#file').setInputFiles({ name: 'large.bin', mimeType: 'application/octet-stream', buffer: large });
    outcome.large = await snapshot(page.locator('#file'));
    assert.equal(outcome.large[0].hash, hash(large));
    assert.equal(outcome.large[0].size, large.length);
    if (name === 'flashwright') {
      for (const files of [[path, payloads[0]], '/missing-upload-file', '\ud800', { name: 'x', mimeType: '', buffer: new Uint8Array([1]) }]) await assert.rejects(page.locator('#file').setInputFiles(files), error => error.name === 'InvalidArgumentError');
      await assert.rejects(page.locator('#file').setInputFiles(temporary), error => error.name === 'UnsupportedFeatureError');
      await assert.rejects(page.locator('#directory').setInputFiles(path), error => error.name === 'UnsupportedFeatureError');
      await assert.rejects(page.locator('#file').setInputFiles({ name: 'too-large', mimeType: '', buffer: Buffer.alloc(32 * 1024 * 1024 + 1) }), error => error.name === 'ResourceLimitError');
      await assert.rejects(page.locator('#text').setInputFiles([]), /input\[type=file\]/);
      assert.deepEqual(await snapshot(page.locator('#file')), outcome.large);
      report.declaredDifferences = { malformedInputAndDirectoryAdmissionBeforeEffects: true, wrongInputTypeRejected: true, bufferLimit32MiB: true };
    }
  } finally { await browser.close(); }
}
try {
  await run('reference', referenceChromium);
  await run('flashwright', flashwrightChromium);
  assert.deepEqual(report.outcomes.flashwright, report.outcomes.reference);
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = String(error.stack ?? error); process.exitCode = 1; }
finally { await fixture.close(); await rm(temporary, { recursive: true, force: true }); await save(); }
console.log(JSON.stringify({ status: report.status, report: join(destination, 'report.json'), error: report.error }));
