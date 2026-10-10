import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { chromium as referenceChromium } from 'playwright';
import { chromium as candidateChromium } from 'flashwright';
import { runtimeMetadata } from '../../tools/javascript-runtime.mjs';
import { identifyBrowser } from '../../tools/browser-identity.mjs';

const destination = resolve(process.argv[2] ?? '.cache/selector-actions');
await mkdir(destination, { recursive: true });
const markup = `<!doctype html><meta charset="utf-8"><style>button,input,select { margin: 8px; }</style>
<button class="button" id="first-button">First</button><button class="button" id="second-button">Second</button>
<input class="text" id="first-text"><input class="text" id="second-text">
<input class="check" id="first-check" type="checkbox"><input class="check" id="second-check" type="checkbox">
<select class="select" id="first-select"><option value="a">Alpha</option><option value="b">Beta</option></select>
<select class="select" id="second-select"><option value="a">Alpha</option><option value="b">Beta</option></select>
<a id="navigate" href="/after">Navigate</a>
<script>window.records=[];for(const type of ['click','dblclick','input','keydown','mouseover'])document.addEventListener(type,event=>records.push({type,target:event.target.id,trusted:event.isTrusted}));</script>`;
const server = createServer((request, response) => {
  response.setHeader('content-type', 'text/html; charset=utf-8');
  response.end(request.url === '/after' ? '<h1>Arrived</h1>' : markup + (request.url === '/' ? '<iframe name="child" src="/child"></iframe>' : ''));
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const address = `http://127.0.0.1:${server.address().port}`;
const actions = [
  ['click', '.button', [], 'click'], ['dblclick', '.button', [], 'dblclick'], ['hover', '.button', [], 'mouseover'],
  ['check', '.check', [], 'click'], ['uncheck', '.check', [], 'click'], ['setChecked', '.check', [true], 'click'],
  ['fill', '.text', ['filled'], 'input'], ['focus', '.text', [], null],
  ['selectOption', '.select', ['b'], 'input'], ['press', '.text', ['X'], 'keydown'], ['type', '.text', ['typed'], 'input'],
];
const report = { status: 'running', reference: '1.60.0', ...runtimeMetadata, checks: [], outcomes: {}, scope: 'Experimental selector actions on pages and same-process frames; no performance or release claim.' };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function check(name, task) { await task(); report.checks.push(name); }
async function reset(frame, method) {
  await frame.evaluate(method => {
    for (const element of document.querySelectorAll('input')) { if (element.type !== 'checkbox') element.value = ''; element.checked = method === 'uncheck'; }
    for (const element of document.querySelectorAll('select')) element.value = 'a';
    document.activeElement?.blur();
    records.length = 0;
  }, method);
}
async function inspect(frame, selector) {
  return frame.evaluate(selector => ({
    matches: [...document.querySelectorAll(selector)].map(element => ({ id: element.id, value: element.value ?? null, checked: element.checked ?? null })),
    focused: document.activeElement.id,
    records,
  }), selector);
}
async function run(engine, chromium) {
  const browser = await chromium.launch({ executablePath: process.env.FLASHWRIGHT_BROWSER_PATH ?? referenceChromium.executablePath() });
  const outcome = report.outcomes[engine] = [];
  try {
    for (const traced of [false, true]) {
      const context = await browser.newContext();
      context.setDefaultTimeout(2000);
      if (traced) await context.tracing.start({ snapshots: true, screenshots: true, sources: true });
      const page = await context.newPage();
      await page.goto(address);
      for (const scope of ['page', 'frame']) {
        const target = scope === 'page' ? page : page.frame('child');
        assert.ok(target);
        for (const [method, selector, arguments_, event] of actions) {
          await check(`${engine}/${traced ? 'trace' : 'plain'}/${scope}/${method}`, async () => {
            if (method === 'hover') await target.locator('#second-button').hover();
            await reset(target, method);
            await assert.rejects(target[method](selector, ...arguments_, { strict: true }), /strict mode violation/);
            assert.equal((await inspect(target, selector)).records.length, 0, 'strict failure must not dispatch');
            for (const strict of [undefined, false]) {
              await reset(target, method);
              const returned = await target[method](selector, ...arguments_, strict === undefined ? {} : { strict });
              const observed = await inspect(target, selector);
              if (method === 'selectOption') assert.deepEqual(returned, ['b']);
              else assert.equal(returned, undefined);
              if (event) {
                const matching = observed.records.filter(record => record.type === event);
                // Repeated hover on the same target need not emit another mouseover.
                if (method !== 'hover' || strict === undefined) assert.ok(matching.length, `${method}: expected native ${event}`);
                for (const record of matching) { assert.equal(record.target, observed.matches[0].id); assert.equal(record.trusted, method !== 'selectOption'); }
              }
              assert.equal(observed.matches[1].value, selector === '.select' ? 'a' : selector === '.check' ? 'on' : selector === '.button' ? '' : '');
              if (selector === '.check') assert.equal(observed.matches[0].checked, method !== 'uncheck');
              if (method === 'fill') assert.equal(observed.matches[0].value, 'filled');
              if (method === 'type') assert.equal(observed.matches[0].value, 'typed');
              if (method === 'press') assert.equal(observed.matches[0].value, 'X');
              if (method === 'focus') assert.equal(observed.focused, 'first-text');
              outcome.push({ traced, scope, method, strict: strict ?? 'default', matches: observed.matches });
            }
            const locatorMethod = method === 'type' ? 'pressSequentially' : method;
            await assert.rejects(target.locator(selector)[locatorMethod](...arguments_), /strict mode violation/);
          });
        }
        await check(`${engine}/${traced}/${scope}/checked-false-and-unique-strict`, async () => {
          await reset(target, 'uncheck');
          await target.setChecked('.check', false);
          assert.equal(await target.locator('#first-check').isChecked(), false);
          assert.equal(await target.locator('#second-check').isChecked(), true);
          await target.fill('#first-text', 'unique', { strict: true });
          assert.equal(await target.locator('#first-text').inputValue(), 'unique');
        });
        await check(`${engine}/${traced}/${scope}/typing-honors-application-focus`, async () => {
          await reset(target, 'type');
          await target.evaluate(() => {
            document.querySelector('#first-text').oninput = () => document.querySelector('#second-text').focus();
          });
          try {
            await target.type('.text', 'abc', { delay: 5 });
            const observed = await inspect(target, '.text');
            assert.deepEqual(observed.matches.map(match => match.value), ['a', 'bc']);
            outcome.push({ traced, scope, method: 'typing-focus-change', matches: observed.matches });
          } finally { await target.evaluate(() => { document.querySelector('#first-text').oninput = null; }); }
        });
        await check(`${engine}/${traced}/${scope}/typing-cancellation`, async () => {
          await reset(target, 'type');
          await assert.rejects(target.type('.text', 'abc', { delay: 5000, timeout: 200 }), error => error.name === 'TimeoutError');
          assert.equal(await target.locator('#first-text').inputValue(), 'a');
          await target.press('.text', 'b');
          assert.equal(await target.locator('#first-text').inputValue(), 'ab');
          assert.equal(await target.locator('#second-text').inputValue(), '');
        });
        await check(`${engine}/${traced}/${scope}/hidden-first-replacement`, async () => {
          await target.evaluate(() => { document.querySelector('#first-button').hidden = true; records.length = 0; });
          await assert.rejects(target.click('.button', { timeout: 60 }), error => error.name === 'TimeoutError');
          assert.equal((await inspect(target, '.button')).records.filter(event => event.type === 'click').length, 0);
          const waiting = target.click('.button');
          await target.evaluate(() => { setTimeout(() => document.querySelector('#first-button').remove(), 50); });
          await waiting;
          assert.deepEqual((await inspect(target, '.button')).records.filter(event => event.type === 'click').map(event => event.target), ['second-button']);
        });
        await check(`${engine}/${traced}/${scope}/trial-and-force`, async () => {
          await target.evaluate(() => { records.length = 0; });
          await target.click('#second-button', { trial: true });
          assert.equal((await inspect(target, '.button')).records.filter(event => event.type === 'click').length, 0);
          await target.fill('.text', 'forced', { force: true });
          assert.equal(await target.locator('#first-text').inputValue(), 'forced');
        });
      }
      await check(`${engine}/${traced}/navigation`, async () => {
        await page.click('#navigate');
        assert.equal(new URL(page.url()).pathname, '/after');
      });
      if (traced) await context.tracing.stop({ path: join(destination, `${engine}.zip`) });
      await context.close();
    }
    await check(`${engine}/timeout-cancels-late-input`, async () => {
      const page = await browser.newPage();
      await page.goto(address);
      await page.evaluate(() => { document.querySelector('#first-text').disabled = true; });
      await assert.rejects(page.fill('.text', 'late', { timeout: 60 }), error => error.name === 'TimeoutError');
      await page.evaluate(() => { document.querySelector('#first-text').disabled = false; });
      await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 150)));
      assert.equal(await page.locator('#first-text').inputValue(), '');
      await page.close();
    });
    await check(`${engine}/closure-and-detachment`, async () => {
      const page = await browser.newPage();
      await page.goto(address);
      const frame = page.frame('child');
      const pending = frame.click('#missing', { timeout: 0 }).then(() => 'success', () => 'detached');
      await page.evaluate(() => document.querySelector('iframe').remove());
      assert.equal(await pending, 'detached');
      await assert.rejects(frame.fill('.text', 'lost'));
      const closing = page.fill('#missing', 'lost', { timeout: 0 }).then(() => 'success', () => 'closed');
      await page.close();
      assert.equal(await closing, 'closed');
    });
    if (engine === 'flashwright') await check('flashwright/invalid-and-unsupported-before-effects', async () => {
      const page = await browser.newPage();
      await page.goto(address);
      for (const options of [{ strict: 'yes' }, { unsupportedOption: true }, { delay: -1 }]) await assert.rejects(page.click('.button', options));
      for (const selector of [null, 42, {}]) await assert.rejects(page.click(selector));
      await assert.rejects(page.fill('.text', 'x', { strict: null }));
      await assert.rejects(page.type('.text', '\ud800'));
      await assert.rejects(browser.newContext({ strictSelectors: true }), error => error.name === 'UnsupportedFeatureError');
      assert.equal((await inspect(page, '.text')).records.length, 0);
      await page.close();
    });
  } finally { await browser.close(); }
}
try {
  report.fixtureSha256 = hash(await readFile(new URL(import.meta.url)));
  report.driverSha256 = hash(await readFile(process.env.FLASHWRIGHT_DRIVER_PATH));
  report.browser = await identifyBrowser(process.env.FLASHWRIGHT_BROWSER_PATH ?? referenceChromium.executablePath());
  await run('reference', referenceChromium);
  await run('flashwright', candidateChromium);
  assert.deepEqual(report.outcomes.flashwright, report.outcomes.reference);
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = error.stack ?? String(error); process.exitCode = 1; }
finally {
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  await writeFile(join(destination, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, checks: report.checks.length, error: report.error, destination }));
}
