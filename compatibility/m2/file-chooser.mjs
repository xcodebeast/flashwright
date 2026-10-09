import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium as referenceChromium } from 'playwright';
import { chromium as flashwrightChromium } from 'flashwright';
import { sourceManifest } from '../../tools/source-manifest.mjs';
import { identifyBrowser } from '../../tools/browser-identity.mjs';
import { createHttpFixture } from '../../tools/http-fixture.mjs';
import { runtimeMetadata, runtimeArtifactLabel } from '../../tools/javascript-runtime.mjs';

const destination = `compatibility/evidence/file-chooser-${process.platform}-${process.arch}-${runtimeArtifactLabel}-${new Date().toISOString().replaceAll(':', '-')}`;
await mkdir(destination, { recursive: true });
const temporary = await mkdtemp(join(tmpdir(), 'flashwright-chooser-'));
const path = join(temporary, 'choice.txt'); await writeFile(path, 'chosen');
const report = { status: 'running', reference: '1.60.0', sources: await sourceManifest(), ...runtimeMetadata,
  browser: await identifyBrowser(process.env.FLASHWRIGHT_BROWSER_PATH ?? referenceChromium.executablePath()),
  driverSha256: createHash('sha256').update(await readFile(process.env.FLASHWRIGHT_DRIVER_PATH)).digest('hex'), outcomes: {} };
const save = () => writeFile(join(destination, 'report.json'), JSON.stringify(report, null, 2) + '\n');
await save();
const fixture = createHttpFixture((_request, response) => { response.setHeader('Content-Type', 'text/html'); response.end(`<input id="file" type="file" multiple><input id="single" type="file"><script>globalThis.mainMarker='main';document.querySelector('#file').mainMarker='node';</script>`); });
await new Promise(resolve => fixture.server.listen(0, '127.0.0.1', resolve));
const baseURL = `http://127.0.0.1:${fixture.server.address().port}`;
async function run(name, chromium) {
  const browser = await chromium.launch({ executablePath: report.browser.executablePath });
  const outcome = report.outcomes[name] = {};
  try {
    const context = await browser.newContext({ baseURL });
    const page = await context.newPage(); page.setDefaultTimeout(3000); await page.goto('/');
    const opened = page.waitForEvent('filechooser');
    await page.locator('#file').click();
    const chooser = await opened;
    assert.equal(chooser.page(), page); assert.equal(chooser.element(), chooser.element()); assert.equal(chooser.isMultiple(), true);
    outcome.utilityWorld = await chooser.element().evaluate(element => [globalThis.mainMarker ?? null, element.mainMarker ?? null, element.ownerDocument === document]);
    assert.deepEqual(outcome.utilityWorld, [null, null, true]);
    const consoleOpened = page.waitForEvent('console');
    await chooser.element().evaluate(element => console.log('chooser utility', element));
    const message = await consoleOpened;
    assert.equal(message.page(), page);
    outcome.utilityConsole = await message.args()[1].evaluate(element => [element.ownerDocument === document, globalThis.mainMarker ?? null]);
    assert.deepEqual(outcome.utilityConsole, [true, null]);
    for (const argument of message.args()) await argument.dispose();
    await chooser.setFiles(path);
    outcome.file = await chooser.element().evaluate(async element => [element.files[0].name, await element.files[0].text()]);
    assert.deepEqual(outcome.file, ['choice.txt', 'chosen']);
    await page.evaluate(() => document.querySelector('#file').outerHTML = '<input id="file" type="file" multiple>');
    await chooser.setFiles({ name: 'original.txt', mimeType: 'text/plain', buffer: Buffer.from('original') });
    assert.equal(await page.locator('#file').evaluate(element => element.files.length), 0);
    assert.deepEqual(await chooser.element().evaluate(async element => [element.isConnected, await element.files[0].text()]), [false, 'original']);
    await chooser.setFiles([]); await chooser.element().dispose();
    outcome.stableOriginalElement = true;
    const singleOpened = page.waitForEvent('filechooser', { predicate: value => !value.isMultiple() });
    await page.locator('#single').click();
    const single = await singleOpened; assert.equal(single.isMultiple(), false);
    await assert.rejects(single.setFiles([path, path]), /Non-multiple/); await single.element().dispose();
    outcome.singleMultiplicity = true;
    const forms = [];
    for (const registration of ['once', 'prependOnceListener', 'on', 'prependListener', 'addListener']) {
      const result = new Promise(resolve => {
        const listener = value => { if (!registration.includes('Once') && registration !== 'once') page.off('filechooser', listener); resolve(value); };
        page[registration]('filechooser', listener);
      });
      await page.locator('#file').click();
      const value = await result; assert.equal(value.page(), page); await value.element().dispose(); forms.push(registration);
    }
    outcome.registrationForms = forms;
    const stale = () => { throw Error('removed listener fired'); };
    page.on('filechooser', stale); page.removeAllListeners('filechooser');
    const next = page.waitForEvent('filechooser'); await page.locator('#file').click(); await (await next).element().dispose();
    await assert.rejects(page.waitForEvent('filechooser', { timeout: 30 }), error => error.name === 'TimeoutError');
    const afterTimeout = page.waitForEvent('filechooser'); await page.locator('#file').click(); await (await afterTimeout).element().dispose();
    outcome.toggleAndTimeoutSuccessors = true;
    await page.evaluate(() => { const frame = document.createElement('iframe'); frame.src = '/child'; document.body.append(frame); });
    await new Promise(resolve => { const ready = page.frames().find(frame => frame.parentFrame() && frame.url().endsWith('/child')); if (ready) resolve(); else page.on('framenavigated', frame => { if (frame.parentFrame() && frame.url().endsWith('/child')) resolve(); }); });
    const child = page.frames().find(frame => frame.parentFrame());
    const childOpened = page.waitForEvent('filechooser'); await child.locator('#file').click(); const childChooser = await childOpened;
    assert.equal(childChooser.page(), page); await childChooser.setFiles(path);
    assert.equal(await child.locator('#file').evaluate(element => element.files.length), 1); await childChooser.element().dispose();
    outcome.sameProcessChildFrame = true;
    const closure = page.waitForEvent('filechooser', { timeout: 0 });
    const rejected = assert.rejects(closure, /closed/); await page.close(); await rejected;
    outcome.closeRejectsWait = true;
    const racePage = await context.newPage();
    await racePage.goto('/');
    const callbacks = [];
    const observed = [];
    let reassigned = false;
    const previous = chooser => { callbacks.push('previous'); observed.push(chooser); };
    const replacementListener = chooser => { callbacks.push('next'); observed.push(chooser); };
    racePage.on('filechooser', previous);
    racePage.on('console', message => {
      if (message.text() === 'chooser-created-while-busy') {
        racePage.off('filechooser', previous); racePage.on('filechooser', replacementListener); reassigned = true;
      }
      for (const argument of message.args()) void argument.dispose();
    });
    await racePage.evaluate(() => 0);
    await racePage.evaluate(() => {
      document.querySelector('#file').click();
      console.log('chooser-created-while-busy');
      const until = Date.now() + 250;
      while (Date.now() < until) {}
    });
    await racePage.evaluate(() => new Promise(resolve => setTimeout(resolve, 100)));
    assert(reassigned);
    assert.deepEqual(callbacks, name === 'reference' ? ['next'] : []);
    for (const chooser of observed) await chooser.element().dispose();
    report.listenerRaceDifference ??= {};
    report.listenerRaceDifference[name] = callbacks;
    racePage.off('filechooser', replacementListener);
    const successor = racePage.waitForEvent('filechooser'); await racePage.locator('#file').click(); await (await successor).element().dispose();
    await racePage.close();
  } finally { await browser.close(); }
}
try { await run('reference', referenceChromium); await run('flashwright', flashwrightChromium); assert.deepEqual(report.outcomes.flashwright, report.outcomes.reference); report.status = 'passed'; }
catch (error) { report.status = 'failed'; report.error = String(error.stack ?? error); process.exitCode = 1; }
finally { await fixture.close(); await rm(temporary, { recursive: true, force: true }); await save(); }
console.log(JSON.stringify({ status: report.status, report: join(destination, 'report.json'), error: report.error }));
