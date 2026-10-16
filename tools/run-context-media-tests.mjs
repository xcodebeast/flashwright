import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { chromium as reference } from 'playwright';
import { chromium as candidate } from 'flashwright';
import { createHttpFixture } from './http-fixture.mjs';
import { identifyBrowser } from './browser-identity.mjs';
import { sourceManifest } from './source-manifest.mjs';
import { runtimeMetadata } from './javascript-runtime.mjs';

const destination = resolve(process.argv[2] ?? `workbench/context-media-${Date.now()}`);
await mkdir(destination, { recursive: true });
const hash = value => createHash('sha256').update(value).digest('hex');
const report = { status: 'running', ...runtimeMetadata, sources: await sourceManifest(),
  browser: await identifyBrowser(process.env.FLASHWRIGHT_BROWSER_PATH ?? reference.executablePath()),
  driverSha256: hash(await readFile(process.env.FLASHWRIGHT_DRIVER_PATH)), outcomes: {}, placement: {},
  scope: 'Immutable context media preferences in main and same-process documents. Cross-origin placement is recorded per case; cross-process coverage requires both reference target inspection and candidate remote-operation rejection. Remote user init scripts remain unsupported. No performance claim.',
  candidateRemoteOwnershipChecks: [] };
function readMedia() {
  return { light: matchMedia('(prefers-color-scheme:light)').matches,
    dark: matchMedia('(prefers-color-scheme:dark)').matches,
    reduced: matchMedia('(prefers-reduced-motion:reduce)').matches,
    forced: matchMedia('(forced-colors:active)').matches,
    contrast: matchMedia('(prefers-contrast:more)').matches };
}
const defaults = { light: true, dark: false, reduced: false, forced: false, contrast: false };
const active = { light: false, dark: true, reduced: true, forced: true, contrast: true };
const names = ['colorScheme', 'reducedMotion', 'forcedColors', 'contrast'];
const cases = [
  ['default', {}, defaults],
  ['active', { colorScheme: 'dark', reducedMotion: 'reduce', forcedColors: 'active', contrast: 'more' }, active],
  ['explicit-default', { colorScheme: 'light', reducedMotion: 'no-preference', forcedColors: 'none', contrast: 'no-preference' }, defaults],
  ['no-preference', { colorScheme: 'no-preference' }, null],
  ['environment', Object.fromEntries(names.map(name => [name, null])), null],
  ['undefined', Object.fromEntries(names.map(name => [name, undefined])), defaults],
  ['mixed', { colorScheme: 'dark', reducedMotion: null, forcedColors: 'none', contrast: 'more' }, null],
];
let origin;
const fixture = createHttpFixture((request, response) => {
  response.setHeader('content-type', 'text/html');
  response.end(`<!doctype html><link rel="icon" href="data:,"><style>
    :root{--scheme:light;--motion:normal;--forced:none;--contrast:normal}
    @media(prefers-color-scheme:dark){:root{--scheme:dark}}
    @media(prefers-reduced-motion:reduce){:root{--motion:reduce}}
    @media(forced-colors:active){:root{--forced:active}}
    @media(prefers-contrast:more){:root{--contrast:more}}</style>
    <script>globalThis.applicationMedia=(${readMedia})();</script><input>
    ${request.url === '/parent' ? '<iframe name="child" src="/child"></iframe>' : ''}
    ${request.url === '/remote-parent' ? `<iframe name="remote" src="${origin.replace('127.0.0.1', 'localhost')}/remote"></iframe>` : ''}`);
});
fixture.server.listen(0, '127.0.0.1'); await once(fixture.server, 'listening');
origin = `http://127.0.0.1:${fixture.server.address().port}`;
async function state(frame, expected, initial) {
  const media = await frame.evaluate(readMedia);
  if (expected) assert.deepEqual(media, expected);
  if (initial) assert.deepEqual(await frame.evaluate(() => globalThis.initialMedia), media);
  if (frame.url() !== 'about:blank') {
    assert.deepEqual(await frame.evaluate(() => globalThis.applicationMedia), media);
    const css = await frame.evaluate(() => {
      const style = getComputedStyle(document.documentElement);
      return ['scheme', 'motion', 'forced', 'contrast'].map(name => style.getPropertyValue('--' + name).trim());
    });
    assert.deepEqual(css, [media.dark ? 'dark' : 'light', media.reduced ? 'reduce' : 'normal', media.forced ? 'active' : 'none', media.contrast ? 'more' : 'normal']);
  }
  return media;
}
async function run(name, chromium) {
  const browser = await chromium.launch({ executablePath: report.browser.executablePath });
  const observations = report.outcomes[name] = [];
  try {
    const sibling = await browser.newContext();
    const siblingPage = await sibling.newPage();
    for (const [label, options, expected] of cases) {
      const context = await browser.newContext(options);
      try {
        await context.addInitScript(`globalThis.initialMedia=(${readMedia})();`);
        const page = await context.newPage();
        const initial = await state(page, expected, true);
        await page.goto(origin + '/parent');
        const parent = await state(page, expected, true);
        const child = await state(page.frame('child'), expected, true);
        await page.goto(origin + '/successor');
        const successor = await state(page, expected, true);
        const later = await context.newPage(); await later.goto(origin + '/later');
        const laterState = await state(later, expected, true);
        assert.deepEqual([initial, child, successor, laterState], [parent, parent, parent, parent]);
        observations.push({ label, initial, parent, child, successor, later: laterState });
        await state(siblingPage, defaults, false);
      } finally { await context.close(); }
      // Remote init scripts have an independent unsupported boundary. Observe first application script instead.
      const remoteContext = await browser.newContext(options);
      try {
        const page = await remoteContext.newPage(); await page.goto(origin + '/remote-parent');
        const remote = page.frame('remote'); assert.ok(remote);
        const remoteState = await state(remote, expected, false);
        assert.deepEqual(remoteState, observations.at(-1).parent);
        observations.at(-1).remote = remoteState;
        if (name === 'playwright') {
          const session = await remoteContext.newCDPSession(page);
          try {
            const { targetInfos } = await session.send('Target.getTargets');
            report.placement[label] = targetInfos.some(target => target.type === 'iframe' && target.url === remote.url()) ? 'out-of-process' : 'same-process';
          } finally { await session.detach(); }
        } else if (report.placement[label] === 'out-of-process') {
          await assert.rejects(page.frameLocator('iframe').locator('input').ariaSnapshot(), error => error.name === 'UnsupportedFeatureError' && /out-of-process/.test(error.message));
          report.candidateRemoteOwnershipChecks.push(label);
        }
        await page.evaluate(url => document.querySelector('iframe').src = url, origin + '/returned');
        await page.waitForFunction(() => { const doc = document.querySelector('iframe').contentDocument; return doc?.URL.endsWith('/returned') && doc.readyState === 'complete'; });
        const returned = await state(page.frame('remote'), expected, false);
        assert.deepEqual(returned, remoteState);
        observations.at(-1).returned = returned;
      } finally { await remoteContext.close(); }
    }
    await sibling.close();
    if (name === 'flashwright') {
      for (const key of names) for (const value of ['', 'no-override', 'invalid', false, 0, [], {}]) {
        await assert.rejects(browser.newContext({ [key]: value }), error => error.name === 'InvalidArgumentError');
        assert.deepEqual(browser.contexts(), []);
      }
      report.invalidValuesRejectedBeforeAllocation = 28;
    }
  } finally { await browser.close(); }
}
try {
  await run('playwright', reference); await run('flashwright', candidate);
  assert.deepEqual(report.outcomes.flashwright, report.outcomes.playwright);
  assert.deepEqual(await sourceManifest(), report.sources);
  assert.equal(hash(await readFile(process.env.FLASHWRIGHT_DRIVER_PATH)), report.driverSha256);
  assert.equal(hash(await readFile(report.browser.executablePath)), report.browser.sha256);
  report.crossProcessCasesVerified = report.candidateRemoteOwnershipChecks.length;
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = { message: error.message, stack: error.stack }; throw error; }
finally {
  try { await fixture.close(); } catch (error) { report.status = 'failed'; report.cleanupError = error.message; process.exitCode = 1; }
  await writeFile(join(destination, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`Context media evidence: ${destination}/report.json`);
}
