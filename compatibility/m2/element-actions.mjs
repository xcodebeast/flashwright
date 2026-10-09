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

const destination = `compatibility/evidence/element-actions-${process.platform}-${process.arch}-${runtimeArtifactLabel}-${new Date().toISOString().replaceAll(':', '-')}`;
await mkdir(destination, { recursive: true });
const report = {
  schemaVersion: 1, reference: '1.60.0', sources: await sourceManifest(), ...runtimeMetadata,
  browser: await identifyBrowser(process.env.FLASHWRIGHT_BROWSER_PATH ?? referenceChromium.executablePath()),
  driverSha256: createHash('sha256').update(await readFile(process.env.FLASHWRIGHT_DRIVER_PATH)).digest('hex'),
  platform: process.platform, architecture: process.arch, status: 'running', outcomes: {},
  scope: 'Locator and ElementHandle selectText/scrollIntoViewIfNeeded with captured-node ownership, action deadlines, same-process frames and native scrolling. No other ElementHandle actions or performance claim.',
};
const save = () => writeFile(join(destination, 'report.json'), JSON.stringify(report, null, 2) + '\n');
await save();
const fixture = createHttpFixture((request, response) => {
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (request.url === '/child') return response.end('<input id="child" value="child text"><div style="height:1800px"></div><button id="child-bottom">bottom</button>');
  response.end(`<!doctype html><style>body{margin:8px}#outer{height:220px;overflow:auto;border:2px solid black;margin-top:1500px}#inner{height:150px;overflow:auto;margin-top:450px;border:2px solid blue}#bottom{display:block;margin-top:800px}#moving{position:absolute;top:900px}</style>
    <input id="input" value="Hello é😃"><textarea id="textarea">line one\nline two</textarea>
    <label id="label" for="input">input label</label><div id="editable" contenteditable>editable <b>text</b></div>
    <div id="text">ordinary <span>text</span></div><div class="many">one</div><div class="many">two</div>
    <input id="hidden" style="display:none" value="hidden text"><button id="reveal" onclick="document.querySelector('#hidden').style.display='block'">reveal</button>
    <div id="shadow"></div><button id="moving">moving target</button>
    <div id="outer"><div id="inner"><button id="bottom">nested bottom</button><div style="height:500px"></div></div><div style="height:500px"></div></div>
    <script>globalThis.focusEvents=[];document.addEventListener('focus',event=>focusEvents.push([event.target.id,event.isTrusted]),true);document.querySelector('#shadow').attachShadow({mode:'open'}).innerHTML='<input id="shadow-input" value="shadow text">';</script>`);
});
await new Promise(resolve => fixture.server.listen(0, '127.0.0.1', resolve));
const baseURL = `http://127.0.0.1:${fixture.server.address().port}`;

/** Compare selected ranges and native focus without depending on asynchronous selectionchange cadence. */
async function selectedInput(page, selector) {
  return page.locator(selector).evaluate(element => ({ start: element.selectionStart, end: element.selectionEnd, value: element.value,
    focused: element.getRootNode().activeElement === element }));
}

async function run(name, chromium) {
  const browser = await chromium.launch({ executablePath: report.browser.executablePath });
  const outcomes = report.outcomes[name] = {};
  try {
    const context = await browser.newContext({ baseURL, viewport: { width: 800, height: 600 } });
    const page = await context.newPage();
    page.setDefaultTimeout(3000);
    await page.goto('/');
    outcomes.selection = {};
    for (const selector of ['#input', '#textarea']) {
      await page.locator(selector).selectText();
      const selected = await selectedInput(page, selector);
      assert.equal(selected.start, 0); assert.equal(selected.end, selected.value.length); assert.equal(selected.focused, true);
      outcomes.selection[selector] = selected;
    }
    await page.locator('#label').selectText();
    outcomes.selection.label = await selectedInput(page, '#input');
    assert.equal(outcomes.selection.label.focused, true);
    for (const selector of ['#editable', '#text']) {
      await page.locator(selector).selectText();
      outcomes.selection[selector] = await page.evaluate(() => String(getSelection()));
    }
    assert.equal(outcomes.selection['#editable'], 'editable text');
    assert.equal(outcomes.selection['#text'], 'ordinary text');
    outcomes.selection.focusEvents = await page.evaluate(() => focusEvents);
    assert(outcomes.selection.focusEvents.every(([, trusted]) => trusted));
    const textNode = await page.locator('#text').evaluateHandle(element => element.firstChild);
    await textNode.selectText();
    assert.equal(await page.evaluate(() => String(getSelection())), 'ordinary text');
    await textNode.dispose();
    outcomes.textNodeRetargeting = true;

    await assert.rejects(page.locator('#hidden').selectText({ timeout: 80 }), error => error.name === 'TimeoutError');
    await page.locator('#hidden').selectText({ force: true });
    outcomes.hiddenForce = await selectedInput(page, '#hidden');
    assert.equal(outcomes.hiddenForce.end, 'hidden text'.length);
    const selecting = page.locator('#hidden').selectText();
    await page.locator('#reveal').click();
    await selecting;
    assert.equal((await selectedInput(page, '#hidden')).focused, true);
    outcomes.concurrentActionCanRevealCapturedTarget = true;
    await assert.rejects(page.locator('.many').selectText(), /strict mode violation/);
    await assert.rejects(page.locator('.many').scrollIntoViewIfNeeded(), /strict mode violation/);
    await assert.rejects(page.locator('#missing').selectText({ timeout: 50 }), error => error.name === 'TimeoutError');
    await assert.rejects(page.locator('#missing').scrollIntoViewIfNeeded({ timeout: 50 }), error => error.name === 'TimeoutError');
    const delayed = page.locator('#delayed').selectText({ timeout: 0 });
    await page.evaluate(() => { const input = document.createElement('input'); input.id = 'delayed'; input.value = 'delayed'; document.body.prepend(input); });
    await delayed;
    assert.equal((await selectedInput(page, '#delayed')).end, 7);
    outcomes.strictnessMissingAndUnboundedResolution = true;

    const original = await page.locator('#input').elementHandle();
    await original.selectText();
    assert.equal(await original.evaluate(element => element.selectionEnd), 'Hello é😃'.length);
    await original.scrollIntoViewIfNeeded();
    await page.evaluate(() => { document.querySelector('#input').outerHTML = '<input id="input" value="replacement">'; });
    await assert.rejects(original.selectText(), /not attached|detached/i);
    await assert.rejects(original.scrollIntoViewIfNeeded(), /not attached|detached/i);
    assert.equal(await original.evaluate(element => element.isConnected), false);
    await original.evaluate(element => element.setSelectionRange(1, 1));
    await original.selectText({ force: true });
    assert.deepEqual(await original.evaluate(element => [element.selectionStart, element.selectionEnd]), [0, 'Hello é😃'.length]);
    assert.deepEqual(await page.locator('#input').evaluate(element => [element.selectionStart, element.selectionEnd]), [0, 0]);
    await page.locator('#input').selectText();
    assert.equal((await selectedInput(page, '#input')).end, 'replacement'.length);
    await original.dispose();
    await assert.rejects(original.selectText(), /disposed|closed/i);
    outcomes.borrowedHandleSurvivesPrivateCleanupAndCannotRetarget = true;

    await page.locator('#shadow-input').selectText();
    assert.equal((await selectedInput(page, '#shadow-input')).end, 'shadow text'.length);
    const childResponse = page.waitForResponse(response => response.url().endsWith('/child'));
    await page.evaluate(() => { const frame = document.createElement('iframe'); frame.src = '/child'; document.body.prepend(frame); });
    await childResponse;
    const frame = page.frames().find(frame => frame.parentFrame() === page.mainFrame());
    assert(frame);
    const child = await frame.waitForSelector('#child');
    await child.selectText();
    assert.equal(await child.evaluate(element => element.selectionEnd), 'child text'.length);
    await frame.locator('#child-bottom').scrollIntoViewIfNeeded();
    assert.equal(await frame.evaluate(() => scrollY > 0), true);
    await page.evaluate(() => document.querySelector('iframe').remove());
    await assert.rejects(child.selectText(), /context|closed|detached/i);
    await child.dispose();
    outcomes.shadowAndSameProcessFrameOwnership = true;

    await page.goto('/scroll');
    const bottom = await page.locator('#bottom').elementHandle();
    await bottom.scrollIntoViewIfNeeded();
    const geometry = await page.evaluate(() => {
      const outer = document.querySelector('#outer'); const inner = document.querySelector('#inner'); const target = document.querySelector('#bottom');
      const targetRectangle = target.getBoundingClientRect(); const innerRectangle = inner.getBoundingClientRect(); const outerRectangle = outer.getBoundingClientRect();
      return { windowScrolled: scrollY > 0, outerScrolled: outer.scrollTop > 0, innerScrolled: inner.scrollTop > 0,
        visibleInWindow: targetRectangle.top >= 0 && targetRectangle.bottom <= innerHeight,
        visibleInOuter: targetRectangle.top >= outerRectangle.top && targetRectangle.bottom <= outerRectangle.bottom,
        visibleInInner: targetRectangle.top >= innerRectangle.top && targetRectangle.bottom <= innerRectangle.bottom };
    });
    assert(Object.values(geometry).every(Boolean));
    outcomes.nestedNativeScroll = geometry;
    const before = await page.evaluate(() => [scrollX, scrollY, document.querySelector('#outer').scrollTop, document.querySelector('#inner').scrollTop]);
    await page.locator('#bottom').scrollIntoViewIfNeeded();
    assert.deepEqual(await page.evaluate(() => [scrollX, scrollY, document.querySelector('#outer').scrollTop, document.querySelector('#inner').scrollTop]), before);
    await bottom.dispose();
    outcomes.alreadyVisibleDoesNotScroll = true;

    const hidden = await page.locator('#hidden').elementHandle();
    await assert.rejects(hidden.scrollIntoViewIfNeeded({ timeout: 80 }), error => error.name === 'TimeoutError');
    assert.equal(await hidden.evaluate(element => element.value), 'hidden text');
    const revealingScroll = hidden.scrollIntoViewIfNeeded();
    await page.evaluate(() => { document.querySelector('#hidden').style.display = 'block'; });
    await revealingScroll;
    await hidden.dispose();
    await page.evaluate(() => {
      let position = 0;
      function move() { document.querySelector('#moving').style.left = `${++position}px`; globalThis.movement = requestAnimationFrame(move); }
      move();
    });
    const moving = await page.locator('#moving').elementHandle();
    await assert.rejects(moving.scrollIntoViewIfNeeded({ timeout: 100 }), error => error.name === 'TimeoutError');
    await page.evaluate(() => cancelAnimationFrame(globalThis.movement));
    await moving.scrollIntoViewIfNeeded();
    assert.equal(await moving.evaluate(element => element.textContent), 'moving target');
    await moving.dispose();
    outcomes.noLayoutRetriesAndFreshStabilityCancellation = true;

    if (name === 'flashwright') {
      const handle = await page.locator('#input').elementHandle();
      for (const target of [page.locator('#input'), handle]) {
        for (const options of [{ force: 'yes' }, { force: null }, { timeout: -1 }, { trial: true }]) await assert.rejects(target.selectText(options), /boolean|timeout|unsupported|option/i);
        for (const options of [{ force: true }, { timeout: -1 }]) await assert.rejects(target.scrollIntoViewIfNeeded(options), /timeout|unsupported|option/i);
      }
      await handle.dispose();
    }
    const closing = await context.newPage();
    const waiting = closing.locator('#absent').selectText({ timeout: 0 }).then(() => ({ resolved: true }), error => ({ error }));
    await closing.close();
    assert((await waiting).error);
    await page.locator('#input').selectText();
    outcomes.validationAndCloseIsolation = true;
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
