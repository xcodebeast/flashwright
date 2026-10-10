import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { identifyBrowser } from './browser-identity.mjs';
const require = createRequire(import.meta.url);
const { server } = require(resolve(dirname(require.resolve('playwright-core/package.json')), 'lib/coreBundle.js'));
const sourcePath = resolve(process.argv[2]);
const output = resolve(process.argv[3]); await mkdir(output);
const bytes = await readFile(sourcePath); const source = JSON.parse(bytes);
assert.equal(source.status, 'passed');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const report = { status: 'running', sourceReportSha256: hash(bytes), browser: await identifyBrowser(source.browser.executablePath), cases: {}, scope: 'Pinned viewer action/result/source rendering for public ARIA getter traces; no DOM or pixel-fidelity claim' };
assert.equal(report.browser.sha256, source.browser.sha256);
const viewer = await server.startTraceViewerServer({ host: '127.0.0.1', allowedFileRoots: [dirname(sourcePath)] });
let browser;
try {
  browser = await chromium.launch({ executablePath: report.browser.executablePath });
  for (const engine of ['playwright', 'flashwright']) {
    const trace = join(dirname(sourcePath), `${engine}-aria.zip`);
    assert.equal(hash(await readFile(trace)), source.traces[engine].sha256);
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.setDefaultTimeout(10000);
    const outcome = report.cases[engine] = { errors: [] };
    page.on('pageerror', error => outcome.errors.push(error.message));
    try {
      await page.goto(`${viewer.urlPrefix('precise')}/trace/index.html?trace=${encodeURIComponent(`file?path=${encodeURIComponent(trace)}`)}`);
      await page.getByRole('button', { name: 'Filter actions', exact: true }).click();
      await page.getByRole('checkbox', { name: /^Getters/ }).check();
      await page.getByRole('button', { name: 'Filter actions', exact: true }).click();
      const actions = page.getByRole('treeitem', { name: /aria.?snapshot/i });
      await actions.nth(1).waitFor(); assert.equal(await actions.count(), 2);
      await actions.first().click();
      await page.getByRole('tab', { name: 'Call', exact: true }).click();
      const call = page.getByRole('tabpanel', { name: 'Call', exact: true });
      await call.getByText(/Trace snapshot/).first().waitFor();
      outcome.call = await call.innerText();
      await page.getByRole('tab', { name: 'Source', exact: true }).click();
      const editor = page.getByTestId('source-code');
      await editor.getByText('public-aria-snapshots.mjs', { exact: true }).waitFor();
      await page.waitForFunction(() => {
        const editor = document.querySelector('[data-testid="source-code-mirror"] .CodeMirror');
        return editor?.CodeMirror?.getValue().includes('const pageSnapshot = await page.ariaSnapshot();');
      }, null, { timeout: 10000 });
      const sourceText = await page.getByTestId('source-code-mirror').locator('.CodeMirror').evaluate(element => element.CodeMirror.getValue());
      outcome.sourceSha256 = hash(Buffer.from(sourceText));
      outcome.highlightedSource = await page.getByTestId('source-code-mirror').locator('.source-line-running').innerText();
      assert.match(outcome.highlightedSource, /page\.ariaSnapshot/);
      assert.deepEqual(outcome.errors, []);
      await page.screenshot({ path: join(output, `${engine}.png`) });
      outcome.screenshotSha256 = hash(await readFile(join(output, `${engine}.png`)));
      outcome.status = 'passed';
    } finally {
      outcome.body = await page.locator('body').innerText();
      await page.close();
    }
  }
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = { name: error.name, message: error.message, stack: error.stack }; process.exitCode = 1; }
finally {
  await browser?.close(); await viewer.stop();
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
}
