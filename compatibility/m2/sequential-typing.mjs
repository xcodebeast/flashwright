import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium as referenceChromium } from 'playwright';
import { chromium as flashwrightChromium } from 'flashwright';
import { sourceManifest } from '../../tools/source-manifest.mjs';
import { identifyBrowser } from '../../tools/browser-identity.mjs';
import { createHttpFixture } from '../../tools/http-fixture.mjs';
import { runtimeMetadata, runtimeArtifactLabel } from '../../tools/javascript-runtime.mjs';

const destination = `compatibility/evidence/sequential-typing-${process.platform}-${process.arch}-${runtimeArtifactLabel}-${new Date().toISOString().replaceAll(':', '-')}`;
await mkdir(destination, { recursive: true });
const report = {
  schemaVersion: 1, reference: '1.60.0', sources: await sourceManifest(), ...runtimeMetadata,
  browser: await identifyBrowser(process.env.FLASHWRIGHT_BROWSER_PATH ?? referenceChromium.executablePath()),
  driverSha256: createHash('sha256').update(await readFile(process.env.FLASHWRIGHT_DRIVER_PATH)).digest('hex'),
  platform: process.platform, architecture: process.arch, status: 'running', outcomes: {},
  scope: 'Locator.pressSequentially and keyboard.type: native events, focus/selection, Unicode, same-process frames, pacing, method-specific completion and cancellation. No persistent keyboard state or performance claim.',
};
const save = () => writeFile(join(destination, 'report.json'), JSON.stringify(report, null, 2) + '\n');
await save();
let heldResponse;
let observeHeldRequest;
const documentSource = `<!doctype html><meta charset="utf-8"><input id="target" value="original"><input id="second"><input id="hidden" style="display:none"><input id="disabled" disabled><input id="readonly" readonly>
<textarea id="textarea"></textarea><div id="editable" contenteditable>old</div><label for="target" id="label">Target</label><div id="shadow"></div><iframe name="child" src="/child"></iframe>
<script>
globalThis.records=[];
for (const type of ['focusin','keydown','keypress','keyup','beforeinput','input']) document.addEventListener(type,event => records.push({type,target:event.target.id,key:event.key??null,code:event.code??null,keyCode:event.keyCode??null,charCode:event.charCode??null,data:event.data??null,inputType:event.inputType??null,trusted:event.isTrusted,repeat:event.repeat??null,shift:event.shiftKey??null}));
document.querySelector('#shadow').attachShadow({mode:'open'}).innerHTML='<input id="shadow-input">';
</script>`;
const fixture = createHttpFixture((request, response) => {
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (request.url === '/held') { heldResponse = response; observeHeldRequest?.(); return; }
  if (request.url === '/child') return response.end('<input id="child-input" oninput="this.dataset.trusted=String(event.isTrusted)">');
  response.end(documentSource);
});
await new Promise(resolve => fixture.server.listen(0, '127.0.0.1', resolve));
const baseURL = `http://127.0.0.1:${fixture.server.address().port}`;

/** Compare browser-observed events, not the particular native command count chosen by each engine. */
async function run(name, chromium) {
  const browser = await chromium.launch({ executablePath: report.browser.executablePath });
  const outcomes = report.outcomes[name] = {};
  try {
    const context = await browser.newContext({ baseURL });
    context.setDefaultTimeout(3000);
    const page = await context.newPage();
    const reset = () => page.goto('/');
    const snapshot = () => page.evaluate(() => ({ records, active: document.activeElement.id, value: document.querySelector('#target').value, second: document.querySelector('#second').value }));
    await reset();
    outcomes.sequences = [];
    for (const text of ['Abc+!?é中😃', '\n\t', '', 'e\u0301']) {
      await page.evaluate(() => { const target = document.querySelector('#target'); target.value = 'original'; target.blur(); records = []; });
      await page.locator('#target').pressSequentially(text);
      outcomes.sequences.push(await snapshot());
    }
    await page.locator('#target').fill('abcd');
    await page.evaluate(() => { document.querySelector('#target').setSelectionRange(1, 3); records = []; });
    await page.locator('#target').pressSequentially('Z');
    assert.equal(await page.locator('#target').inputValue(), 'aZd');
    outcomes.existingSelection = await snapshot();
    await page.evaluate(() => { document.querySelector('#target').setSelectionRange(0, 1); records = []; });
    page.setDefaultTimeout(1);
    await page.keyboard.type('é😃', { delay: 20 });
    page.setDefaultTimeout(3000);
    assert.equal(await page.locator('#target').inputValue(), 'é😃Zd');
    outcomes.pageTypingKeepsFocusAndUnboundedTimeout = await snapshot();

    await reset();
    await page.evaluate(() => document.querySelector('#target').addEventListener('keyup', () => {
      setTimeout(() => document.querySelector('#second').focus(), 20);
    }, { once: true }));
    await page.locator('#target').pressSequentially('aé', { delay: 60 });
    assert.equal(await page.locator('#target').inputValue(), 'aoriginal');
    assert.equal(await page.locator('#second').inputValue(), 'é');
    outcomes.unicodeDelayPrecedesInsertion = await snapshot();

    await reset();
    await page.evaluate(() => document.querySelector('#target').addEventListener('input', () => document.querySelector('#second').focus(), { once: true }));
    await page.locator('#target').pressSequentially('abc');
    assert.equal(await page.locator('#target').inputValue(), 'aoriginal');
    assert.equal(await page.locator('#second').inputValue(), 'bc');
    outcomes.focusMovesBetweenCharacters = await snapshot();
    await reset();
    await page.evaluate(() => document.querySelector('#target').addEventListener('input', event => {
      const replacement = document.createElement('input'); replacement.id = 'target'; event.target.replaceWith(replacement);
      document.querySelector('#second').focus();
    }, { once: true }));
    await page.locator('#target').pressSequentially('abc');
    assert.equal(await page.locator('#target').inputValue(), '');
    assert.equal(await page.locator('#second').inputValue(), 'bc');
    outcomes.replacementDoesNotRestartTyping = await snapshot();

    await reset();
    await page.locator('#textarea').pressSequentially('one\ntwo');
    await page.locator('#editable').pressSequentially('new');
    await page.locator('#shadow-input').pressSequentially('shadowé');
    await page.frame('child').locator('#child-input').pressSequentially('frame😃');
    assert.equal(await page.frame('child').locator('#child-input').getAttribute('data-trusted'), 'true');
    outcomes.editableShadowAndFrame = [await page.locator('#textarea').inputValue(), await page.locator('#editable').textContent(), await page.locator('#shadow-input').inputValue(), await page.frame('child').locator('#child-input').inputValue()];
    await page.locator('#second').focus();
    for (const selector of ['#hidden', '#disabled', 'body', '#readonly', '#label']) await page.locator(selector).pressSequentially('x');
    outcomes.methodSpecificFocus = await snapshot();
    await assert.rejects(page.locator('input').pressSequentially('x'), /strict mode violation/);
    await assert.rejects(page.locator('#missing').pressSequentially('x', { timeout: 60 }), error => error.name === 'TimeoutError');
    await page.evaluate(() => setTimeout(() => { const input = document.createElement('input'); input.id = 'late'; document.body.append(input); }, 30));
    await page.locator('#late').pressSequentially('late', { timeout: 0 });
    assert.equal(await page.locator('#late').inputValue(), 'late');
    const started = performance.now();
    await page.locator('#late').pressSequentially('aé', { delay: 25 });
    assert(performance.now() - started >= 40);
    outcomes.strictnessLateTargetAndPacing = true;

    for (const noWaitAfter of [false, true]) {
      await reset();
      await page.evaluate(() => document.querySelector('#target').addEventListener('input', () => { location.href = '/held'; }, { once: true }));
      const requested = new Promise(resolve => { observeHeldRequest = resolve; });
      try {
        await page.locator('#target').pressSequentially('n', { noWaitAfter, timeout: 700 });
        await requested;
        assert(heldResponse && !heldResponse.writableEnded);
      } finally { heldResponse?.end('<h1>released</h1>'); heldResponse = undefined; observeHeldRequest = undefined; }
      await page.waitForURL('**/held');
    }
    outcomes.typingHasNoNavigationBarrier = true;

    await reset();
    await assert.rejects(page.locator('#target').pressSequentially('abcdef', { delay: 500, timeout: 100 }), error => error.name === 'TimeoutError');
    assert.equal(await page.locator('#target').inputValue(), 'aoriginal');
    outcomes.timeoutDoesNotSendRemainingCharacters = true;
    if (name === 'flashwright') {
      await page.evaluate(() => { records = []; document.querySelector('#second').focus(); records = []; });
      for (const [text, options] of [['a\ud800', {}], ['x', { delay: -1 }], ['x', { delay: 0x100000000 }], ['x', { noWaitAfter: 'yes' }], ['x', { timeout: -1 }], ['x', { unsupported: true }]]) await assert.rejects(page.locator('#target').pressSequentially(text, options));
      await assert.rejects(page.keyboard.type('\udfff'));
      await assert.rejects(page.locator('#target').pressSequentially('a'.repeat(100001)), error => error.name === 'ResourceLimitError');
      assert.deepEqual(await page.evaluate(() => [records, document.activeElement.id]), [[], 'second']);
      await page.keyboard.type('a');
      assert.equal(await page.locator('#second').inputValue(), 'a');
    }
    await context.close();
  } finally { await browser.close(); }
}

try {
  await run('playwright', referenceChromium);
  await run('flashwright', flashwrightChromium);
  assert.deepEqual(report.outcomes.flashwright, report.outcomes.playwright);
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = error.stack ?? String(error); throw error; }
finally { await fixture.close(); await save(); console.log(destination); }
