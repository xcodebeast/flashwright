import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { identifyBrowser } from './browser-identity.mjs';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');
const directory = resolve(process.argv[2]);
const source = await readFile(new URL('../packages/resident-runtime/snapshot-runtime.js', import.meta.url), 'utf8');
const hash = value => createHash('sha256').update(value).digest('hex');
const report = { status: 'running', scope: 'isolated renderer CSS inspection; no network capture or external-resource viewer replay claim', sourceSha256: hash(source), checks: [], observations: [], requests: [] };
await mkdir(directory);
await writeFile(join(directory, 'snapshot-runtime.js'), source);
await writeFile(join(directory, 'test-snapshot-css.mjs'), await readFile(new URL(import.meta.url)));
const css = {
  '/external.css': '@import url("/imported.css"); #external-target { color: rgb(21,22,23); }',
  '/imported.css': '#imported-target { color: rgb(31,32,33); }',
  '/foreign.css': '#foreign-target { color: rgb(41,42,43); }',
  '/shared.css': '.shared { color: rgb(51,52,53); }',
};
let foreignOrigin;
let browser;
function handler(request, response) {
  report.requests.push({ port: request.socket.localPort, url: request.url, method: request.method });
  response.setHeader('Cache-Control', 'no-store');
  if (css[request.url]) { response.setHeader('Content-Type', 'text/css'); response.end(css[request.url]); return; }
  response.setHeader('Content-Type', 'text/html');
  if (request.url === '/duplicates') response.end('<!doctype html><link id="first" rel="stylesheet" href="/shared.css"><link id="second" rel="stylesheet" href="/shared.css"><p class="shared">duplicate CSS target</p>');
  else response.end(`<!doctype html><link id="external" rel="stylesheet" href="/external.css"><link id="foreign" rel="stylesheet" href="${foreignOrigin}/foreign.css"><p id="external-target">external</p><p id="imported-target">imported</p><p id="foreign-target">foreign</p>`);
}
const localServer = createServer(handler);
const foreignServer = createServer(handler);
async function check(name, callback) { await callback(); report.checks.push(name); }
try {
  await new Promise(resolve => foreignServer.listen(0, '127.0.0.1', resolve));
  foreignOrigin = `http://127.0.0.1:${foreignServer.address().port}`;
  await new Promise(resolve => localServer.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${localServer.address().port}`;
  report.browser = await identifyBrowser(process.env.FLASHWRIGHT_BROWSER_PATH);
  browser = await chromium.launch({ executablePath: process.env.FLASHWRIGHT_BROWSER_PATH });
  const page = await browser.newPage();
  await page.goto(origin);
  await page.evaluate(`${source}; globalThis.snapshotFactory = createSnapshotCapture;`);
  async function snapshot(label) {
    const result = await page.evaluate(label => {
      const captured = snapshotFactory().capture({ token: label, snapshotNumber: 1 });
      const colors = {};
      for (const name of ['external', 'imported', 'foreign']) {
        const element = document.querySelector(`#${name}-target`);
        if (element) colors[name] = getComputedStyle(element).color;
      }
      return { captured, colors };
    }, label);
    assert.ok(Buffer.byteLength(JSON.stringify(result.captured.data)) + result.captured.counters.overrideCount * 256 <= result.captured.counters.bytes);
    report.observations.push({ label, ...result });
    return result;
  }
  await check('accessible external and imported CSS use current original URLs', async () => {
    const result = await snapshot('accessible');
    assert.deepEqual(result.colors, { external: 'rgb(21, 22, 23)', imported: 'rgb(31, 32, 33)', foreign: 'rgb(41, 42, 43)' });
    assert.ok(result.captured.data.resourceOverrides.some(override => override.url === `${origin}/external.css` && override.content.includes('21, 22, 23')));
    assert.ok(result.captured.data.resourceOverrides.some(override => override.url === `${origin}/imported.css` && override.content.includes('31, 32, 33')));
  });
  await check('inaccessible CSS remains a network-resource dependency without fabricated text', async () => {
    assert.equal(await page.evaluate(() => { try { document.querySelector('#foreign').sheet.cssRules; return 'accessible'; } catch (error) { return error.name; } }), 'SecurityError');
    const result = await snapshot('inaccessible');
    assert.ok(!result.captured.data.resourceOverrides.some(override => override.url === `${foreignOrigin}/foreign.css`));
    assert.equal(result.colors.foreign, 'rgb(41, 42, 43)');
  });
  await check('imported rule changes through retained CSS declarations are reread', async () => {
    await page.evaluate(() => { globalThis.retainedDeclaration = document.querySelector('#external').sheet.cssRules[0].styleSheet.cssRules[0].style; });
    await snapshot('before-retained-mutation');
    await page.evaluate(() => { retainedDeclaration.color = 'rgb(61,62,63)'; });
    const result = await snapshot('retained-import-mutated');
    assert.equal(result.colors.imported, 'rgb(61, 62, 63)');
    assert.ok(result.captured.data.resourceOverrides.some(override => override.url === `${origin}/imported.css` && override.content.includes('61, 62, 63')));
  });
  await check('disabled accessible and inaccessible external sheets produce empty overrides', async () => {
    await page.evaluate(() => { document.querySelector('#external').sheet.disabled = true; document.querySelector('#foreign').sheet.disabled = true; });
    const result = await snapshot('disabled');
    assert.deepEqual(result.colors, { external: 'rgb(0, 0, 0)', imported: 'rgb(0, 0, 0)', foreign: 'rgb(0, 0, 0)' });
    for (const url of [`${origin}/external.css`, `${foreignOrigin}/foreign.css`]) assert.ok(result.captured.data.resourceOverrides.some(override => override.url === url && override.content === ''));
  });
  await page.goto(`${origin}/duplicates`);
  await page.evaluate(`${source}; globalThis.snapshotFactory = createSnapshotCapture;`);
  await check('duplicate URLs with identical stylesheet contents share one override', async () => {
    const result = await snapshot('duplicate-identical');
    assert.equal(result.captured.data.resourceOverrides.length, 1);
    assert.equal(result.captured.data.resourceOverrides[0].url, `${origin}/shared.css`);
  });
  await check('conflicting duplicate URL content rejects instead of choosing an incorrect replay', async () => {
    const result = await page.evaluate(() => {
      document.querySelector('#first').sheet.insertRule('.shared { color: rgb(71,72,73); }', 1);
      const owner = snapshotFactory();
      let message;
      try { owner.capture({ token: 'conflict', snapshotNumber: 1 }); } catch (error) { message = error.message; }
      return { message, state: owner.inspect(), live: getComputedStyle(document.querySelector('.shared')).color };
    });
    assert.match(result.message, /SnapshotUnsupported: distinct stylesheet content shares one URL/);
    assert.equal(result.state.tentative, null);
    report.observations.push({ label: 'duplicate-conflict-unsupported', ...result });
  });
  await page.close();
  report.status = 'passed-with-declared-unsupported-case';
} catch (error) { report.status = 'failed'; report.error = { message: error.message, stack: error.stack }; process.exitCode = 1; }
finally {
  await browser?.close();
  if (localServer.listening) await new Promise(resolve => localServer.close(resolve));
  if (foreignServer.listening) await new Promise(resolve => foreignServer.close(resolve));
  await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2)); console.log(join(directory, 'report.json'));
}
