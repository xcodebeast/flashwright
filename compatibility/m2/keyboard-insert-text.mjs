import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium as referenceChromium } from 'playwright';
import { chromium as flashwrightChromium } from 'flashwright';
import { identifyBrowser } from '../../tools/browser-identity.mjs';
import { createHttpFixture } from '../../tools/http-fixture.mjs';
import { runtimeMetadata, runtimeArtifactLabel } from '../../tools/javascript-runtime.mjs';
import { sourceManifest } from '../../tools/source-manifest.mjs';

const directory = process.argv[2] ?? `compatibility/evidence/keyboard-insert-text-${process.platform}-${process.arch}-${runtimeArtifactLabel}-${new Date().toISOString().replaceAll(':', '-')}`;
await mkdir(directory, { recursive: true });
const report = {
  schemaVersion: 1, reference: '1.60.0', ...runtimeMetadata,
  sources: await sourceManifest(),
  browser: await identifyBrowser(process.env.FLASHWRIGHT_BROWSER_PATH ?? referenceChromium.executablePath()),
  driverSha256: createHash('sha256').update(await readFile(process.env.FLASHWRIGHT_DRIVER_PATH)).digest('hex'),
  platform: process.platform, architecture: process.arch, status: 'running', outcomes: {},
  scope: 'One native keyboard.insertText payload, focus/selection, browser-observed Unicode/events and same-process frames. No persistent modifiers, remote-input or performance claim.',
};
const save = () => writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
await save();

const eventRecorder = `
globalThis.records = [];
for (const type of ['keydown','keypress','keyup','beforeinput','input']) document.addEventListener(type, event => {
  records.push({ type, target: event.target.id, data: event.data ?? null, inputType: event.inputType ?? null, trusted: event.isTrusted });
});`;
const documentSource = `<!doctype html><meta charset="utf-8"><input id="target" value="original"><input id="second">
<textarea id="textarea">original</textarea><div id="editable" contenteditable>original</div><input id="readonly" readonly value="original">
<div id="shadow"></div><iframe name="child" src="/child"></iframe><script>
${eventRecorder}
document.querySelector('#shadow').attachShadow({ mode: 'open' }).innerHTML = '<input id="shadow-input">';
</script>`;
let heldResponse;
let observeHeldRequest;
const fixture = createHttpFixture((request, response) => {
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (request.url === '/held') { heldResponse = response; observeHeldRequest?.(); return; }
  if (request.url === '/child') return response.end(`<input id="child-input"><script>${eventRecorder}</script>`);
  response.end(documentSource);
});
await new Promise(resolve => fixture.server.listen(0, '127.0.0.1', resolve));
const baseURL = `http://127.0.0.1:${fixture.server.address().port}`;

async function run(name, chromium) {
  const browser = await chromium.launch({ executablePath: report.browser.executablePath });
  const outcomes = report.outcomes[name] = {};
  try {
    const context = await browser.newContext({ baseURL });
    const page = await context.newPage();
    const reset = () => page.goto('/');
    const snapshot = () => page.evaluate(() => ({
      records, active: document.activeElement.id,
      value: document.querySelector('#target').value, second: document.querySelector('#second').value,
      selection: [document.querySelector('#target').selectionStart, document.querySelector('#target').selectionEnd],
    }));
    outcomes.text = [];
    for (const text of ['whole payload', 'é中😃', 'e\u0301', '', '\u0000', '\r\n\t', '\u2028\u2029']) {
      await reset();
      await page.locator('#target').focus();
      await page.evaluate(() => { document.querySelector('#target').setSelectionRange(1, 5); records = []; });
      await page.keyboard.insertText(text);
      const observed = await snapshot();
      assert(observed.records.every(event => !['keydown', 'keypress', 'keyup'].includes(event.type)));
      assert(observed.records.every(event => event.trusted));
      if (text === 'whole payload') {
        assert.equal(observed.value, 'owhole payloadnal');
        assert.equal(observed.records.filter(event => event.type === 'input').length, 1);
      }
      outcomes.text.push({ text, observed });
    }

    await reset();
    await page.locator('#target').focus();
    await page.evaluate(() => { records = []; document.querySelector('#target').addEventListener('beforeinput', event => event.preventDefault(), { once: true }); });
    await page.keyboard.insertText('cancelled');
    outcomes.prevented = await snapshot();
    assert.equal(outcomes.prevented.value, 'original');
    assert(outcomes.prevented.records.some(event => event.type === 'beforeinput'));
    assert(!outcomes.prevented.records.some(event => event.type === 'input'));

    await reset(); await page.locator('#target').focus();
    await page.evaluate(() => {
      records = [];
      document.querySelector('#target').addEventListener('beforeinput', () => {
        const finish = Date.now() + 60; while (Date.now() < finish) {}
      }, { once: true });
    });
    page.setDefaultTimeout(1);
    await page.keyboard.insertText('unbounded');
    page.setDefaultTimeout(3000);
    outcomes.unboundedPublicTimeout = await snapshot();
    assert.equal(outcomes.unboundedPublicTimeout.value, 'unboundedoriginal');

    for (const eventType of ['beforeinput', 'input']) {
      await reset();
      await page.locator('#target').focus();
      await page.evaluate(type => {
        records = [];
        document.querySelector('#target').addEventListener(type, () => document.querySelector('#second').focus(), { once: true });
      }, eventType);
      await page.keyboard.insertText('one payload');
      outcomes[`focusMovesOn${eventType}`] = await snapshot();
      await page.keyboard.insertText('next');
      outcomes[`subsequentInsertionOn${eventType}`] = await snapshot();
      assert.equal(outcomes[`subsequentInsertionOn${eventType}`].second.endsWith('next'), true);
    }

    await reset();
    await page.locator('#target').focus();
    await page.evaluate(() => {
      records = [];
      document.querySelector('#target').addEventListener('input', event => {
        const replacement = document.createElement('input'); replacement.id = 'target';
        event.target.replaceWith(replacement); document.querySelector('#second').focus();
      }, { once: true });
    });
    await page.keyboard.insertText('whole payload');
    outcomes.replacement = await snapshot();
    assert.equal(outcomes.replacement.value, '');
    assert.equal(outcomes.replacement.second, '');

    await reset();
    await page.keyboard.insertText('unfocused');
    outcomes.unfocused = await snapshot();
    assert.equal(outcomes.unfocused.value, 'original');
    await page.locator('#readonly').focus();
    await page.evaluate(() => { records = []; });
    await page.keyboard.insertText('readonly');
    outcomes.readonly = { observed: await snapshot(), value: await page.locator('#readonly').inputValue() };
    assert.equal(outcomes.readonly.value, 'original');

    outcomes.editable = [];
    for (const selector of ['#textarea', '#editable', '#shadow-input']) {
      await reset(); await page.locator(selector).focus();
      await page.evaluate(() => { records = []; });
      await page.keyboard.insertText('one\ntwo😃');
      outcomes.editable.push({ selector, observed: await snapshot(), value: selector === '#editable' ? await page.locator(selector).textContent() : await page.locator(selector).inputValue() });
    }
    await reset();
    const child = page.frame('child');
    await child.locator('#child-input').focus();
    await page.keyboard.insertText('child😃');
    outcomes.child = await child.evaluate(() => ({ records, value: document.querySelector('#child-input').value }));
    assert.equal(outcomes.child.value, 'child😃');
    assert(outcomes.child.records.some(event => event.type === 'input' && event.trusted));

    await reset(); await page.locator('#target').focus();
    await page.evaluate(() => document.querySelector('#target').addEventListener('input', () => { location.href = '/held'; }, { once: true }));
    const requested = new Promise(resolve => { observeHeldRequest = resolve; });
    try {
      await page.keyboard.insertText('navigate'); await requested;
      assert(heldResponse && !heldResponse.writableEnded);
    } finally { heldResponse?.end('<h1>released</h1>'); heldResponse = undefined; observeHeldRequest = undefined; }
    await page.waitForURL('**/held');
    outcomes.noNavigationBarrier = true;

    await reset(); await page.locator('#target').focus();
    await page.evaluate(() => { document.querySelector('#target').setSelectionRange(1, 5); records = []; });
    await context.tracing.start({ snapshots: true, sources: true });
    await page.keyboard.insertText('traceé😃');
    if (name === 'flashwright') await assert.rejects(page.keyboard.insertText('\ud800'), error => error.name === 'UnsupportedFeatureError');
    await context.tracing.stop({ path: join(directory, `${name}-trace.zip`) });
    outcomes.traced = await snapshot();
    assert.equal(outcomes.traced.value, 'otraceé😃nal');

    if (name === 'flashwright') {
      await reset(); await page.locator('#second').focus();
      await page.evaluate(() => { records = []; });
      for (const text of [undefined, null, 42, {}]) await assert.rejects(page.keyboard.insertText(text), error => error.name === 'InvalidArgumentError');
      for (const text of ['\ud800', '\udfff', 'prefix\ud800', '\udfff\ud800']) await assert.rejects(page.keyboard.insertText(text), error => error.name === 'UnsupportedFeatureError');
      await assert.rejects(page.keyboard.insertText('x'.repeat(100001)), error => error.name === 'ResourceLimitError');
      assert.deepEqual((await snapshot()).records, []);
      assert.equal((await snapshot()).active, 'second');
      assert.equal((await snapshot()).second, '');
    }
    await context.close();
    await assert.rejects(page.keyboard.insertText('closed'), error => error.name === 'TargetClosedError' || /closed/i.test(error.message));
  } finally { await browser.close(); }
}

try {
  await run('playwright', referenceChromium); await run('flashwright', flashwrightChromium);
  assert.deepEqual(report.outcomes.flashwright, report.outcomes.playwright);
  report.traceVerification = JSON.parse(execFileSync('python3', [
    'tools/verify-keyboard-insert-text-traces.py', join(directory, 'playwright-trace.zip'), join(directory, 'flashwright-trace.zip'),
  ], { encoding: 'utf8' }));
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = error.stack ?? String(error); throw error; }
finally { await fixture.close(); await save(); console.log(directory); }
