import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { identifyBrowser } from './browser-identity.mjs';

const require = createRequire(import.meta.url);
const { server: upstreamServer } = require(resolve(dirname(require.resolve('playwright-core/package.json')), 'lib/coreBundle.js'));
const sourceReport = resolve(process.argv[2]);
const source = JSON.parse(await readFile(sourceReport, 'utf8'));
assert.equal(source.status, 'passed', 'viewer inputs must come from a passed conformance run');
const directory = join(dirname(sourceReport), `viewer-${new Date().toISOString().replaceAll(':', '-')}`);
await mkdir(directory);
const browserPath = process.env.FLASHWRIGHT_BROWSER_PATH ?? source.browser.executablePath;
const report = { status: 'running', sourceReport, sourceReportSha256: createHash('sha256').update(await readFile(sourceReport)).digest('hex'), browser: await identifyBrowser(browserPath), cases: {} };
const viewer = await upstreamServer.startTraceViewerServer({ host: '127.0.0.1', allowedFileRoots: [dirname(sourceReport)] });
let browser;

try {
  browser = await chromium.launch({ executablePath: browserPath });
  for (const name of ['actions', 'unfinished', 'next', 'crash']) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on('pageerror', error => errors.push({ message: error.message, stack: error.stack }));
    try {
      const trace = resolve(dirname(sourceReport), 'flashwright', `${name}.zip`);
      assert.equal(createHash('sha256').update(await readFile(trace)).digest('hex'), source.outcomes.flashwright[name].sha256, 'viewer artifact matches the verified trace');
      // This is the pinned viewer's local HTTP file route, not a file:// URL.
      const fileRoute = `file?path=${encodeURIComponent(trace)}`;
      await page.goto(`${viewer.urlPrefix('precise')}/trace/index.html?trace=${encodeURIComponent(fileRoute)}`);
      await page.getByRole('treeitem', { name: /^page.evaluate/ }).first().waitFor({ timeout: 10000 });
      const outcome = { errors, body: await page.locator('body').innerText(), tree: await page.getByRole('tabpanel', { name: 'Actions', exact: true }).ariaSnapshot() };
      report.cases[name] = outcome;
      if (name === 'actions') {
        await page.getByRole('treeitem', { name: /^page.evaluate/ }).first().click();
        await page.getByRole('tab', { name: 'Call', exact: true }).click();
        await page.getByRole('tabpanel', { name: 'Call', exact: true }).getByText('42', { exact: true }).waitFor();
        outcome.call = await page.getByRole('tabpanel', { name: 'Call', exact: true }).innerText();
        await page.getByRole('tab', { name: /^Console/ }).click();
        await page.getByRole('tabpanel', { name: /^Console/ }).getByText('inside evaluate', { exact: true }).waitFor();
        outcome.console = await page.getByRole('tabpanel', { name: /^Console/ }).innerText();
        await page.screenshot({ path: join(directory, 'console.png') });
        await page.getByRole('tab', { name: 'Source', exact: true }).click();
        await page.getByTestId('source-code').getByText('run-manual-trace-tests.mjs', { exact: true }).waitFor();
        outcome.source = await page.getByTestId('source-code').innerText();
        assert.match(outcome.source, /^run-manual-trace-tests\.mjs(?:\n1\n\u200b)?$/, 'caller filename and an empty editor are present without embedded source text');
        await page.screenshot({ path: join(directory, 'source.png') });
        await page.getByRole('treeitem', { name: /^page.evaluate/ }).nth(1).click();
        await page.getByRole('tab', { name: /^Errors/ }).click();
        await page.getByRole('tabpanel', { name: /^Errors/ }).getByText(/trace browser failure/).first().waitFor();
        outcome.errorsPanel = await page.getByRole('tabpanel', { name: /^Errors/ }).innerText();
        await page.screenshot({ path: join(directory, 'errors.png') });
      }
      assert.deepEqual(errors, [], `${name}: no viewer runtime errors`);
    } finally {
      await writeFile(join(directory, `${name}-dom.json`), JSON.stringify({ errors, body: await page.locator('body').innerText(), snapshot: await page.locator('body').ariaSnapshot() }, null, 2));
      await page.screenshot({ path: join(directory, `${name}.png`) });
      await page.close();
    }
  }
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.error = { message: error.message, stack: error.stack }; throw error;
} finally {
  await browser?.close();
  await viewer.stop();
  await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`Manual trace viewer evidence: ${directory}/report.json`);
}
