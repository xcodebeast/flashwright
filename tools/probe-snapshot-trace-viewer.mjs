import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { identifyBrowser } from './browser-identity.mjs';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const { server } = require('playwright-core/lib/coreBundle');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sourcePath = resolve(process.argv[2]);
const source = JSON.parse(await readFile(sourcePath, 'utf8'));
assert.equal(source.status, 'passed');
const output = resolve(process.argv[3]); await mkdir(output);
const report = { status: 'running', source: sourcePath, sourceSha256: hash(await readFile(sourcePath)), scope: 'Actual pinned offline DOM/form/frame viewer; this corpus loads resources before recording and does not claim their replay', browser: await identifyBrowser(process.env.FLASHWRIGHT_BROWSER_PATH), checks: [] };
const viewer = await server.startTraceViewerServer({ host: '127.0.0.1', allowedFileRoots: [dirname(sourcePath)] });
const prefix = viewer.urlPrefix('precise');
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.FLASHWRIGHT_BROWSER_PATH });
  for (const archive of source.archives.filter(archive => /actions-(?:false|true)\.zip$/.test(archive.path))) {
    assert.equal(hash(await readFile(archive.path)), archive.sha256);
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.setDefaultTimeout(10000);
    const item = { archive: archive.path, errors: [], blocked: [] };
    report.checks.push(item);
    page.on('pageerror', error => item.errors.push(error.message));
    await page.route('**/*', async route => {
      const url = route.request().url();
      if (!url.startsWith(prefix) && !url.startsWith('data:') && !url.startsWith('blob:')) { item.blocked.push(url); await route.abort(); }
      else if (new URL(url).pathname.endsWith('/file') && new URL(url).searchParams.get('path') !== archive.path) { item.blocked.push(url); await route.abort(); }
      else await route.continue();
    });
    try {
      await page.goto(`${prefix}/trace/index.html?trace=${encodeURIComponent(`file?path=${encodeURIComponent(archive.path)}`)}`);
      await page.getByRole('treeitem', { name: /selectOption/ }).last().click();
      await page.getByRole('tab', { name: 'After', exact: true }).click();
      const expectedSnapshot = archive.actions.findLast(action => action.method === 'selectOption').afterSnapshot;
      let snapshot;
      const deadline = Date.now() + 10000;
      while (!snapshot && Date.now() < deadline) {
        for (const frame of page.frames()) if (new URL(frame.url()).searchParams.get('name') === expectedSnapshot && await frame.locator('#input').count().catch(() => 0)) { snapshot = frame; break; }
        if (!snapshot) await new Promise(resolve => setTimeout(resolve, 25));
      }
      assert.ok(snapshot, 'viewer must load the real captured frame');
      await snapshot.waitForFunction(() => document.readyState === 'complete' && !document.querySelector('[__playwright_value_], [__playwright_selected_]'));
      item.snapshot = snapshot.url();
      item.state = await snapshot.evaluate(() => ({ input: document.querySelector('#input').value, selected: document.querySelector('#select').value, button: document.querySelector('#button').textContent, color: getComputedStyle(document.querySelector('#button')).color }));
      const { color, ...formState } = item.state;
      assert.deepEqual(formState, { input: 'filled', selected: 'two', button: 'clicked' });
      item.externalStylesheet = { expectedColor: 'rgb(20, 40, 60)', actualColor: color, accepted: false, reason: 'Pre-trace stylesheet has a snapshot override blob but no canonical network resource; this probe does not accept external CSS replay.' };
      const child = snapshot.childFrames()[0];
      assert.ok(child);
      await child.getByText('child-content').waitFor();
      assert.deepEqual(item.errors, []);
      assert.deepEqual(item.blocked, []);
      item.status = 'passed';
    } finally {
      await page.screenshot({ path: join(output, `viewer-${report.checks.length}.png`) });
      item.dom = await page.locator('body').ariaSnapshot();
      await page.close();
    }
  }
  assert.equal(report.checks.length, 2);
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = error.stack ?? String(error); process.exitCode = 1; }
finally {
  await browser?.close(); await viewer.stop();
  report.browserAfter = await identifyBrowser(process.env.FLASHWRIGHT_BROWSER_PATH);
  assert.deepEqual(report.browserAfter, report.browser);
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ status: report.status, error: report.error, checks: report.checks.map(item => ({ archive: item.archive, status: item.status, blocked: item.blocked })) }));
}
