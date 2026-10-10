import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { identifyBrowser } from './browser-identity.mjs';

const require = createRequire(import.meta.url);
const { server } = require('playwright-core/lib/coreBundle');
const directory = resolve(process.argv[2]);
const destination = resolve(process.argv[3] ?? join(directory, 'viewer'));
await mkdir(destination, { recursive: true });
const hash = content => createHash('sha256').update(content).digest('hex');
const source = await readFile(join(directory, 'trace-verification.json'));
const verified = JSON.parse(source);
assert.equal(verified.status, 'passed');
const browserPath = process.env.FLASHWRIGHT_BROWSER_PATH;
assert.ok(browserPath, 'Provide the matched Chromium executable');
const report = { status: 'running', verificationSha256: hash(source), browser: await identifyBrowser(browserPath), cases: [], scope: 'Pinned trace viewer renders successful and denied Download metadata. No snapshot or visual equality claim.' };
const viewer = await server.startTraceViewerServer({ host: '127.0.0.1', allowedFileRoots: [directory] });
let browser;
try {
  browser = await chromium.launch({ executablePath: browserPath });
  for (const name of ['completed-default', 'accept-downloads-false']) {
    const path = `flashwright-trace/${name}.zip`;
    const archive = verified.archives.find(item => item.path === path);
    assert.ok(archive);
    const trace = join(directory, path);
    assert.equal(hash(await readFile(trace)), archive.sha256);
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on('pageerror', error => errors.push({ message: error.message, stack: error.stack }));
    try {
      const fileRoute = `file?path=${encodeURIComponent(trace)}`;
      await page.goto(`${viewer.urlPrefix('precise')}/trace/index.html?trace=${encodeURIComponent(fileRoute)}`);
      const action = page.getByRole('treeitem', { name: /^download\.path/ }).first();
      await action.waitFor({ timeout: 10000 });
      await action.click();
      await page.getByRole('tab', { name: 'Call', exact: true }).click();
      const call = await page.getByRole('tabpanel', { name: 'Call', exact: true }).innerText();
      if (name === 'completed-default') assert.match(call, /flashwright-artifacts/);
      else {
        await page.getByRole('tab', { name: /^Errors/ }).click();
        await page.getByRole('tabpanel', { name: /^Errors/ }).getByText(/acceptDownloads: true/).first().waitFor();
      }
      const screenshot = join(destination, `${name}.png`);
      await page.screenshot({ path: screenshot });
      const body = await page.locator('body').innerText();
      await writeFile(join(destination, `${name}-dom.json`), JSON.stringify({ body, call, errors }, null, 2) + '\n');
      assert.deepEqual(errors, []);
      report.cases.push({ name, traceSha256: archive.sha256, call, errors, screenshotSha256: hash(await readFile(screenshot)) });
    } finally { await page.close(); }
  }
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.error = { name: error.name, message: error.message, stack: error.stack };
  process.exitCode = 1;
} finally {
  await browser?.close();
  await viewer.stop();
  await writeFile(join(destination, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, cases: report.cases.length }));
}
