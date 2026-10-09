import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium as referenceChromium } from 'playwright';
import { chromium as flashwrightChromium } from 'flashwright';
import { startContextSettingsFixture } from '../../tools/context-settings-fixture.mjs';
import { sourceManifest } from '../../tools/source-manifest.mjs';
import { identifyBrowser } from '../../tools/browser-identity.mjs';
import { runtimeMetadata, runtimeArtifactLabel } from '../../tools/javascript-runtime.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const destination = `compatibility/evidence/context-settings-${process.platform}-${process.arch}-${runtimeArtifactLabel}-${new Date().toISOString().replaceAll(':', '-')}`;
await mkdir(destination, { recursive: true });
const report = {
  status: 'running', referenceVersion: '1.60.0', ...runtimeMetadata, sources: await sourceManifest(),
  browser: await identifyBrowser(process.env.FLASHWRIGHT_BROWSER_PATH ?? referenceChromium.executablePath()),
  driverSha256: hash(await readFile(process.env.FLASHWRIGHT_DRIVER_PATH)), outcomes: {}, candidateChecks: [],
  scope: 'Context HTTPS certificate policy, JavaScript execution and media defaults, initial scripts, private storage, sibling isolation and explicit zero slow motion. No performance or new cross-process coverage claim.',
};
const fixture = await startContextSettingsFixture();
const defaultMedia = { light: true, dark: false, reduced: false, forced: false, contrast: false };

async function scriptState(page) {
  return page.evaluate(() => ({ inline: globalThis.inlineRuns ?? 0, external: globalThis.externalRuns ?? 0,
    clicks: globalThis.clicks ?? 0, init: globalThis.initRuns ?? 0, pageInit: globalThis.pageInitRuns ?? 0,
    initialMedia: globalThis.initialMedia ?? null,
    media: { light: matchMedia('(prefers-color-scheme:light)').matches, dark: matchMedia('(prefers-color-scheme:dark)').matches,
      reduced: matchMedia('(prefers-reduced-motion:reduce)').matches, forced: matchMedia('(forced-colors:active)').matches,
      contrast: matchMedia('(prefers-contrast:more)').matches } }));
}

async function run(engine, chromium) {
  const outcomes = report.outcomes[engine] = { scripts: [], https: {} };
  const browser = await chromium.launch({ executablePath: report.browser.executablePath, slowMo: 0 });
  try {
    for (const [name, options] of [['default', {}], ['explicit-enabled', { javaScriptEnabled: true }], ['disabled', { javaScriptEnabled: false }]]) {
      const context = await browser.newContext(options);
      try {
        await context.addInitScript(() => {
          globalThis.initRuns = (globalThis.initRuns ?? 0) + 1;
          globalThis.initialMedia = { light: matchMedia('(prefers-color-scheme:light)').matches, dark: matchMedia('(prefers-color-scheme:dark)').matches,
            reduced: matchMedia('(prefers-reduced-motion:reduce)').matches, forced: matchMedia('(forced-colors:active)').matches,
            contrast: matchMedia('(prefers-contrast:more)').matches };
        });
        const page = await context.newPage();
        const initial = await scriptState(page);
        await page.addInitScript(() => { globalThis.pageInitRuns = (globalThis.pageInitRuns ?? 0) + 1; });
        await page.goto(fixture.origin + '/parent');
        const navigated = await scriptState(page);
        const child = await scriptState(page.frame('child'));
        const mediaStyle = await page.evaluate(() => {
          const style = document.createElement('style');
          style.textContent = '#media-policy-test{border:0;background:rgb(220,230,240)} @media(prefers-color-scheme:dark){#media-policy-test{background:rgb(10,20,30)}} @media(prefers-contrast:more){#media-policy-test{border:3px solid}}';
          const element = document.createElement('div'); element.id = 'media-policy-test';
          document.head.append(style); document.body.append(element);
          const computed = getComputedStyle(element);
          const result = { background: computed.backgroundColor, borderWidth: computed.borderTopWidth };
          element.remove(); style.remove();
          return result;
        });
        assert.deepEqual(mediaStyle, { background: 'rgb(220, 230, 240)', borderWidth: '0px' });
        assert.equal(await page.locator('#ready').textContent(), 'Ready');
        assert.equal(await page.locator('#no-script').isVisible(), name === 'disabled');
        await page.locator('#action').click();
        const clicked = await scriptState(page);
        assert.equal(clicked.clicks, name === 'disabled' ? 0 : 1);
        assert.equal(navigated.inline, name === 'disabled' ? 0 : 1);
        assert.equal(navigated.external, name === 'disabled' ? 0 : 1);
        await page.evaluate(() => { globalThis.explicitEvaluation = 42; });
        assert.equal(await page.evaluate(() => explicitEvaluation), 42);
        await page.goto(fixture.origin + '/successor');
        const successor = await scriptState(page);
        const later = await context.newPage();
        await later.goto(fixture.origin + '/later');
        const laterState = await scriptState(later);
        for (const state of [initial, navigated, child, clicked, successor, laterState]) {
          assert.deepEqual(state.media, defaultMedia);
          assert.deepEqual(state.initialMedia, state.init ? defaultMedia : null);
        }
        outcomes.scripts.push({ name, initial, navigated, child, clicked, successor, later: laterState, mediaStyle });
      } finally { await context.close(); }
    }

    const strict = await browser.newContext({ ignoreHTTPSErrors: false });
    const permissive = await browser.newContext({ ignoreHTTPSErrors: true });
    try {
      const strictPage = await strict.newPage();
      const permissivePage = await permissive.newPage();
      const certificateError = error => error.message.includes('ERR_CERT_');
      await assert.rejects(strictPage.goto(fixture.secureOrigin + '/strict'), certificateError);
      await strictPage.close();
      assert.equal((await permissivePage.goto(fixture.secureOrigin + '/permitted')).status(), 200);
      assert.equal(await permissivePage.locator('#ready').textContent(), 'Ready');
      assert.equal(await permissivePage.evaluate(() => externalRuns), 1);
      const strictAfterOptIn = await strict.newPage();
      await assert.rejects(strictAfterOptIn.goto(fixture.secureOrigin + '/still-strict'), certificateError);
      await strictAfterOptIn.close();
      // A rejected certificate navigation may still be committing its error document.
      const strictSubresource = await strict.newPage();
      await strictSubresource.goto(fixture.origin + '/secure-subresource');
      assert.equal(await strictSubresource.evaluate(() => globalThis.externalRuns ?? 0), 0);
      await permissivePage.goto(fixture.origin + '/secure-subresource');
      assert.equal(await permissivePage.evaluate(() => externalRuns), 1);
      const later = await permissive.newPage();
      await later.goto(fixture.secureOrigin + '/later');
      const fetched = await later.evaluate(() => fetch('/secure-data').then(response => response.json()));
      assert.deepEqual(fetched, { secure: true });
      outcomes.https = { strictMainRejected: true, permittedMain: 200, strictSubresourceBlocked: true,
        permittedSubresourceRuns: 1, laterPageFetch: fetched, siblingStrictAfterOptIn: true };
    } finally { await Promise.all([strict.close(), permissive.close()]); }
    const defaultContext = await browser.newContext();
    try {
      const page = await defaultContext.newPage();
      await assert.rejects(page.goto(fixture.secureOrigin + '/default'), error => error.message.includes('ERR_CERT_'));
    } finally { await defaultContext.close(); }

    const state = { cookies: [], origins: [{ origin: fixture.origin, localStorage: [{ name: 'seed', value: 'preserved' }] }] };
    const storage = await browser.newContext({ javaScriptEnabled: false, storageState: state });
    try {
      await storage.addInitScript(() => { localStorage.setItem('unexpected-init', 'written'); });
      assert.deepEqual(await storage.storageState(), state);
      const page = await storage.newPage();
      await page.goto(fixture.origin + '/storage');
      assert.equal(await page.evaluate(() => localStorage.getItem('seed')), 'preserved');
      const beforeClose = await storage.storageState();
      await page.close();
      const afterClose = await storage.storageState();
      assert.deepEqual(afterClose, beforeClose);
      outcomes.storage = { beforeClose, afterClose };
    } finally { await storage.close(); }

    if (engine === 'flashwright') {
      for (const value of [null, 0, 1, 'true', {}, []]) for (const name of ['ignoreHTTPSErrors', 'javaScriptEnabled']) {
        await assert.rejects(browser.newContext({ [name]: value }), error => error.name === 'InvalidArgumentError');
        assert.deepEqual(browser.contexts(), []);
      }
      for (const value of [null, -1, NaN, Infinity, '0', false]) {
        await assert.rejects(chromium.launch({ executablePath: report.browser.executablePath, slowMo: value }), error => error.name === 'InvalidArgumentError');
      }
      await assert.rejects(chromium.launch({ executablePath: report.browser.executablePath, slowMo: 1 }), error => error.name === 'UnsupportedFeatureError');
      report.candidateChecks.push('Malformed settings allocate no public context; invalid/nonzero slow motion rejects before launch');
    }
  } finally { await browser.close(); }
}

try {
  await run('playwright', referenceChromium);
  await run('flashwright', flashwrightChromium);
  assert.deepEqual(report.outcomes.flashwright, report.outcomes.playwright);
  assert.deepEqual(await sourceManifest(), report.sources);
  assert.equal(hash(await readFile(process.env.FLASHWRIGHT_DRIVER_PATH)), report.driverSha256);
  assert.equal(hash(await readFile(report.browser.executablePath)), report.browser.sha256);
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = { message: error.message, stack: error.stack }; throw error; }
finally {
  try { await fixture.close(); }
  catch (error) { report.status = 'failed'; report.cleanupError = { message: error.message, stack: error.stack }; process.exitCode = 1; }
  await writeFile(join(destination, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`Context settings evidence: ${destination}/report.json`);
}
