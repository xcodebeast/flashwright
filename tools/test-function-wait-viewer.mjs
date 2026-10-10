import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { identifyBrowser } from './browser-identity.mjs';
import { runtimeMetadata } from './javascript-runtime.mjs';

const require = createRequire(import.meta.url);
const { server } = require(resolve(dirname(require.resolve('playwright-core/package.json')), 'lib/coreBundle.js'));
const sourcePath = resolve(process.argv[2]);
const destination = resolve(process.argv[3]);
await mkdir(destination, { recursive: true });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sourceBytes = await readFile(sourcePath);
const source = JSON.parse(sourceBytes);
assert.equal(source.status, 'passed');
const report = { status: 'running', ...runtimeMetadata, sourceReportSha256: hash(sourceBytes), cases: {},
  toolSha256: hash(await readFile(new URL(import.meta.url))),
  browser: await identifyBrowser(source.browser.executablePath),
  scope: 'Pinned viewer renders predicate actions, original embedded source and retained timeout. No pixel equality or performance claim.' };
assert.equal(report.browser.sha256, source.browser.sha256);
const viewer = await server.startTraceViewerServer({ host: '127.0.0.1', allowedFileRoots: [dirname(sourcePath)] });
let browser;
try {
  browser = await chromium.launch({ executablePath: report.browser.executablePath });
  for (const engine of ['playwright', 'flashwright']) {
    const trace = join(dirname(sourcePath), `${engine}-function-waits.zip`);
    assert.equal(hash(await readFile(trace)), source.traces[engine].sha256);
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.setDefaultTimeout(10000);
    const outcome = report.cases[engine] = { errors: [], sourceFallbacks: [] };
    page.on('pageerror', error => outcome.errors.push(error.message));
    await page.route('**/file**', async route => {
      const path = new URL(route.request().url()).searchParams.get('path');
      if (!path || resolve(path) === trace) await route.continue();
      else { outcome.sourceFallbacks.push(path); await route.fulfill({ status: 404, body: '' }); }
    });
    try {
      await page.goto(`${viewer.urlPrefix('precise')}/trace/index.html?trace=${encodeURIComponent(`file?path=${encodeURIComponent(trace)}`)}`);
      const actions = page.getByRole('treeitem', { name: /wait.?for.?function/i });
      await actions.nth(2).waitFor();
      assert.equal(await actions.count(), 3);
      await actions.first().click();
      await page.getByRole('tab', { name: 'Call', exact: true }).click();
      outcome.call = await page.getByRole('tabpanel', { name: 'Call', exact: true }).innerText();
      await page.getByRole('tab', { name: 'Source', exact: true }).click();
      await page.getByTestId('source-code').getByText('function-waits.mjs', { exact: true }).waitFor();
      await page.waitForFunction(() => {
        const editor = document.querySelector('[data-testid="source-code-mirror"] .CodeMirror');
        return editor?.CodeMirror?.getValue().includes('const selected = await page.waitForFunction');
      });
      const text = await page.getByTestId('source-code-mirror').locator('.CodeMirror').evaluate(element => element.CodeMirror.getValue());
      outcome.sourceSha256 = hash(Buffer.from(text));
      outcome.highlightedSource = await page.getByTestId('source-code-mirror').locator('.source-line-running').innerText();
      assert.match(outcome.highlightedSource, /page\.waitForFunction/);
      await actions.nth(2).click();
      await page.getByRole('tab', { name: /^Errors/ }).click();
      const errors = page.getByRole('tabpanel', { name: /^Errors/ });
      await errors.getByText(/timeout|deadline/i).first().waitFor();
      outcome.timeout = await errors.innerText();
      assert.deepEqual(outcome.errors, []);
      assert.deepEqual(outcome.sourceFallbacks, [], 'embedded caller source must not fall back to workstation files');
      const screenshot = join(destination, `${engine}.png`);
      await page.screenshot({ path: screenshot });
      outcome.screenshotSha256 = hash(await readFile(screenshot));
      outcome.status = 'passed';
    } finally {
      outcome.body = await page.locator('body').innerText();
      await page.close();
    }
  }
  assert.equal(hash(await readFile(report.browser.executablePath)), report.browser.sha256);
  assert.equal(hash(await readFile(new URL(import.meta.url))), report.toolSha256);
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.error = { name: error.name, message: error.message, stack: error.stack };
  process.exitCode = 1;
} finally {
  await browser?.close();
  await viewer.stop();
  await writeFile(join(destination, 'report.json'), JSON.stringify(report, null, 2) + '\n');
}
