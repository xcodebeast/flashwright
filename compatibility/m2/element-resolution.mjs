import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium as referenceChromium } from 'playwright';
import { chromium as flashwrightChromium, ElementHandle } from 'flashwright';
import { sourceManifest } from '../../tools/source-manifest.mjs';
import { identifyBrowser } from '../../tools/browser-identity.mjs';
import { createHttpFixture } from '../../tools/http-fixture.mjs';
import { runtimeMetadata, runtimeArtifactLabel } from '../../tools/javascript-runtime.mjs';

const destination = `compatibility/evidence/element-resolution-${process.platform}-${process.arch}-${runtimeArtifactLabel}-${new Date().toISOString().replaceAll(':', '-')}`;
await mkdir(destination, { recursive: true });
const report = {
  schemaVersion: 1, reference: '1.60.0', sources: await sourceManifest(), ...runtimeMetadata,
  browser: await identifyBrowser(process.env.FLASHWRIGHT_BROWSER_PATH ?? referenceChromium.executablePath()),
  driverSha256: createHash('sha256').update(await readFile(process.env.FLASHWRIGHT_DRIVER_PATH)).digest('hex'),
  platform: process.platform, architecture: process.arch, status: 'running', outcomes: {},
  scope: 'Page/Frame.waitForSelector, Locator.elementHandle/evaluate/evaluateHandle; same-process frame main-world adoption, state/strictness, original-context ownership and callback lifecycle. No element actions, cross-context public handle adoption or performance claim.',
};
const save = () => writeFile(join(destination, 'report.json'), JSON.stringify(report, null, 2) + '\n');
await save();
let heldNavigationResponse;
const fixture = createHttpFixture((request, response) => {
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (request.url === '/held-navigation') { heldNavigationResponse = response; return; }
  if (request.url === '/signal') return response.end('started');
  if (request.url === '/child') return response.end('<button id="child">child</button><script>globalThis.realmMarker="child-main";document.querySelector("button").realmMarker="child-element";</script>');
  response.end('<h1>resolution</h1><button id="target">original</button><div class="many">first</div><div class="many">second</div><div id="hidden" style="display:none">hidden</div><div id="shadow"></div><script>globalThis.realmMarker="page-main";document.querySelector("button").realmMarker="element-main";document.querySelector("#shadow").attachShadow({mode:"open"}).innerHTML="<span>shadow target</span>";</script>');
});
await new Promise(resolve => fixture.server.listen(0, '127.0.0.1', resolve));
const baseURL = `http://127.0.0.1:${fixture.server.address().port}`;

async function run(name, chromium) {
  const browser = await chromium.launch({ executablePath: report.browser.executablePath });
  const outcomes = report.outcomes[name] = {};
  try {
    const context = await browser.newContext({ baseURL });
    const page = await context.newPage();
    page.setDefaultTimeout(3000);
    await page.goto('/');
    const original = await page.waitForSelector('#target');
    if (name === 'flashwright') assert(original instanceof ElementHandle);
    assert.deepEqual(await original.evaluate(element => [globalThis.realmMarker, element.realmMarker, element.ownerDocument === document]), ['page-main', 'element-main', true]);
    assert.equal(await page.locator('#target').evaluate(element => element.realmMarker), 'element-main');
    const first = await page.waitForSelector('.many');
    assert.equal(await first.evaluate(element => element.textContent), 'first');
    await first.dispose();
    await assert.rejects(page.waitForSelector('.many', { strict: true }), /strict mode violation/);
    await assert.rejects(page.locator('.many').elementHandle(), /strict mode violation/);
    await assert.rejects(page.waitForSelector('css=['), /selector|token/i);
    assert.equal(await page.waitForSelector('#missing', { state: 'hidden' }), null);
    assert.equal(await page.waitForSelector('#missing', { state: 'detached' }), null);
    assert.equal(await page.waitForSelector('#hidden', { state: 'hidden' }), null);
    const attachedHidden = await page.waitForSelector('#hidden', { state: 'attached' });
    assert.equal(await attachedHidden.evaluate(element => element.textContent), 'hidden');
    await attachedHidden.dispose();
    await assert.rejects(page.waitForSelector('#hidden', { timeout: 50 }), error => error.name === 'TimeoutError');
    await assert.rejects(page.waitForSelector('#target', { state: 'detached', timeout: 50 }), error => error.name === 'TimeoutError');
    const shadow = await page.getByText('shadow target').elementHandle();
    assert.equal(await shadow.evaluate(element => element.getRootNode().host.id), 'shadow');
    await shadow.dispose();
    outcomes.statesStrictnessAndShadow = true;

    const borrowed = await page.evaluateHandle(() => ({ answer: 42 }));
    const argument = { first: borrowed, second: borrowed, text: 'é😃\ud800\0' }; argument.self = argument;
    assert.deepEqual(await page.locator('#target').evaluate((element, value) => [element.realmMarker, value.first.answer, value.first === value.second, value.self === value, value.text], argument), ['element-main', 42, true, true, argument.text]);
    const independent = await page.locator('#target').evaluateHandle((element, value) => ({ element, value }), borrowed);
    assert.equal(await independent.evaluate(result => result.value.answer), 42);
    await borrowed.dispose();
    assert.equal(await independent.evaluate(result => result.element.realmMarker), 'element-main');
    const returnedElement = await page.locator('#target').evaluateHandle(element => element);
    assert.equal(returnedElement.asElement(), returnedElement);
    await independent.dispose();
    await page.evaluate(() => { document.querySelector('#target').outerHTML = '<button id="target">replacement</button>'; });
    assert.deepEqual(await original.evaluate(element => [element.textContent, element.isConnected]), ['original', false]);
    assert.deepEqual(await returnedElement.evaluate(element => [element.textContent, element.isConnected]), ['original', false]);
    assert.equal(await page.locator('#target').evaluate(element => element.textContent), 'replacement');
    await original.dispose(); await returnedElement.dispose();
    outcomes.borrowedArgumentsIndependentResultsAndReplacement = true;

    await page.evaluate(() => { document.querySelector('#target').setAttribute('data-text', 'é\ud800\0'); });
    assert.equal(await page.locator('#target').evaluate(element => element.getAttribute('data-text')), 'é\ud800\0');
    assert.equal(await page.locator('#target').evaluate('globalThis.realmMarker'), 'page-main');
    await assert.rejects(page.locator('#target').evaluate(() => { throw new TypeError('element failure é\ud800'); }), /element failure/);
    const settled = await page.locator('#target').evaluate(async element => { await new Promise(resolve => setTimeout(resolve, 120)); return element.textContent; }, undefined, { timeout: 60 });
    assert.equal(settled, 'replacement');
    await assert.rejects(page.locator('#never').evaluate(() => { globalThis.shouldNotRun = true; }, undefined, { timeout: 40 }), error => error.name === 'TimeoutError');
    assert.equal(await page.evaluate(() => globalThis.shouldNotRun), undefined);
    outcomes.exactValuesErrorsAndResolutionOnlyTimeout = true;

    const delayed = page.waitForSelector('#delayed', { timeout: 0 });
    await page.evaluate(() => { setTimeout(() => { const element = document.createElement('button'); element.id = 'delayed'; document.body.append(element); }, 40); });
    await (await delayed).dispose();
    const changing = page.waitForSelector('#after-navigation');
    await page.goto('/next');
    await page.evaluate(() => { const element = document.createElement('button'); element.id = 'after-navigation'; element.realmMarker = 'new-document'; document.body.append(element); });
    const navigated = await changing;
    assert.equal(await navigated.evaluate(element => element.realmMarker), 'new-document');
    await navigated.dispose();
    outcomes.delayedAndNavigationResolution = true;

    const childLoaded = page.waitForResponse(response => response.url().endsWith('/child'));
    await page.evaluate(() => { const child = document.createElement('iframe'); child.src = '/child'; document.body.append(child); });
    await childLoaded;
    const child = page.frames().find(frame => frame.parentFrame() === page.mainFrame());
    assert(child);
    const childElement = await child.waitForSelector('#child');
    assert.deepEqual(await childElement.evaluate(element => [globalThis.realmMarker, element.realmMarker, element.ownerDocument === document]), ['child-main', 'child-element', true]);
    assert.equal(await child.locator('#child').evaluate(element => element.realmMarker), 'child-element');
    await page.evaluate(() => document.querySelector('iframe').remove());
    await assert.rejects(childElement.evaluate(element => element.textContent), /context|closed|detached/i);
    await childElement.dispose();
    outcomes.sameProcessFrameRealmAndDetach = true;

    await page.evaluate(() => localStorage.removeItem('evaluationCount'));
    const started = page.waitForResponse(response => response.url().endsWith('/signal'));
    const interrupted = page.locator('#target').evaluate(element => {
      localStorage.setItem('evaluationCount', String(Number(localStorage.getItem('evaluationCount') || '0') + 1));
      fetch('/signal');
      return new Promise(() => {});
    }).then(() => ({ resolved: true }), error => ({ error }));
    await started;
    await page.goto('/replacement');
    const interruption = await interrupted;
    assert(interruption.error);
    assert.match(interruption.error.message, /context|navigation|closed/i);
    assert.equal(await page.evaluate(() => localStorage.getItem('evaluationCount')), '1');
    outcomes.userCallbackIsNeverReplayedAfterNavigation = true;

    const requested = page.waitForEvent('request', request => request.url().endsWith('/held-navigation'));
    await page.evaluate(() => { location.href = '/held-navigation'; });
    await requested;
    try {
      await assert.rejects(page.waitForSelector('#target', { state: 'attached', timeout: 80 }), error => error.name === 'TimeoutError');
    } finally { heldNavigationResponse?.end('<button id="target">after navigation</button>'); }
    await page.waitForURL('**/held-navigation');
    assert.equal(await page.locator('#target').evaluate(element => element.textContent), 'after navigation');
    await page.goto('/replacement');
    outcomes.selectorWaitHonorsPendingNavigation = true;

    const closing = await context.newPage();
    const pending = closing.waitForSelector('#absent', { timeout: 0 }).then(() => ({ resolved: true }), error => ({ error }));
    await closing.close();
    assert((await pending).error);
    assert.equal(await page.locator('#target').evaluate(element => element.textContent), 'original');
    if (name === 'flashwright') {
      for (const settings of [{ state: 'wrong' }, { state: null }, { strict: 'yes' }, { timeout: -1 }, { unsupported: true }]) await assert.rejects(page.waitForSelector('#target', settings), /state|boolean|timeout|unsupported|option/i);
    }
    outcomes.closeIsolationAndValidation = true;
    await context.close();
    const disabled = await browser.newContext({ javaScriptEnabled: false });
    const disabledPage = await disabled.newPage();
    await disabledPage.goto(baseURL);
    assert.equal(await disabledPage.locator('#target').evaluate(element => element.textContent), 'original');
    assert.equal(await disabledPage.locator('#target').evaluate(() => globalThis.realmMarker), undefined);
    await disabled.close();
    outcomes.explicitEvaluationWithApplicationScriptsDisabled = true;
  } finally { await browser.close(); }
}

try {
  await run('playwright', referenceChromium);
  await run('flashwright', flashwrightChromium);
  assert.deepEqual(report.outcomes.flashwright, report.outcomes.playwright);
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = error.stack ?? String(error); throw error; }
finally { await fixture.close(); await save(); console.log(destination); }
