import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { identifyBrowser } from './browser-identity.mjs';

const require = createRequire(import.meta.url);
const { server: upstreamServer } = require(resolve(dirname(require.resolve('playwright-core/package.json')), 'lib/coreBundle.js'));
const sourceReport = resolve(process.argv[2]);
const sourceBytes = await readFile(sourceReport);
const source = JSON.parse(sourceBytes);
assert.equal(source.status, 'passed');
const directory = join(dirname(sourceReport), `source-viewer-${new Date().toISOString().replaceAll(':', '-')}`);
await mkdir(directory);
const browserPath = process.env.FLASHWRIGHT_BROWSER_PATH ?? source.browser.executablePath;
const report = { status: 'running', sourceReport, sourceReportSha256: createHash('sha256').update(sourceBytes).digest('hex'), browser: await identifyBrowser(browserPath), cases: [] };
const viewer = await upstreamServer.startTraceViewerServer({ host: '127.0.0.1', allowedFileRoots: [dirname(sourceReport)] });
let browser;
try {
  browser = await chromium.launch({ executablePath: browserPath });
  for (const input of source.cases) {
    assert.equal(createHash('sha256').update(await readFile(input.trace)).digest('hex'), input.traceSha256);
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.setDefaultTimeout(10000);
    const errors = []; const blockedSourceFallbacks = [];
    page.on('pageerror', error => errors.push({ message: error.message, stack: error.stack }));
    await page.route('**/file?*', async route => {
      const file = new URL(route.request().url()).searchParams.get('path');
      if (file === input.trace) await route.continue();
      else { blockedSourceFallbacks.push(file); await route.fulfill({ status: 404, body: '' }); }
    });
    try {
      await page.goto(`${viewer.urlPrefix('precise')}/trace/index.html?trace=${encodeURIComponent(`file?path=${encodeURIComponent(input.trace)}`)}`);
      await page.getByRole('treeitem', { name: /evaluate/i }).first().click();
      await page.getByRole('tab', { name: 'Source', exact: true }).click();
      await page.getByTestId('source-code').getByText(basename(input.sourcePath), { exact: true }).waitFor();
      await page.waitForFunction(expected => {
        const editor = document.querySelector('[data-testid="source-code-mirror"] .CodeMirror');
        return editor?.CodeMirror?.getValue() === expected;
      }, input.sourceText ?? '', { timeout: 10000 });
      const editorText = await page.getByTestId('source-code-mirror').locator('.CodeMirror').evaluate(element => element.CodeMirror.getValue());
      const highlighted = page.getByTestId('source-code-mirror').locator('.source-line-running');
      let highlightedText = null;
      if (input.sourceText !== null) {
        await highlighted.waitFor();
        assert.equal(await highlighted.locator('.CodeMirror-linenumber').textContent(), String(input.callerLine));
        highlightedText = await highlighted.locator('.CodeMirror-line').textContent();
        assert.equal(highlightedText.replaceAll('\u200b', '').trim(), input.sourceText.split('\n')[input.callerLine - 1].trim(), `${input.label}: highlighted actual caller line`);
        assert.deepEqual(blockedSourceFallbacks, [], 'embedded source must not fall back to workstation files');
      } else assert.equal(editorText, '');
      assert.deepEqual(errors, []);
      report.cases.push({ label: input.label, sourcePath: input.sourcePath, callerLine: input.callerLine, editorSha256: createHash('sha256').update(editorText).digest('hex'), highlightedText, blockedSourceFallbacks, errors });
    } finally {
      await writeFile(join(directory, `${input.label}-dom.json`), JSON.stringify({ errors, sourceHtml: await page.getByTestId('source-code').innerHTML().catch(() => ''), body: await page.locator('body').innerText() }, null, 2));
      await page.screenshot({ path: join(directory, `${input.label}.png`) });
      await page.close();
    }
  }
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = { message: error.message, stack: error.stack }; throw error; }
finally { await browser?.close(); await viewer.stop(); await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n'); console.log(`Trace source viewer evidence: ${directory}/report.json`); }
