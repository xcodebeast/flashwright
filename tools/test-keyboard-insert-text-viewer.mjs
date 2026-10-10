import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
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
assert.equal(source.traceVerification.status, 'passed');
const report = { status: 'running', ...runtimeMetadata, sourceReportSha256: hash(sourceBytes), cases: {},
  toolSha256: hash(await readFile(new URL(import.meta.url))), browser: await identifyBrowser(source.browser.executablePath),
  scope: 'Pinned viewer renders the original insertion call, embedded caller source and before/after input values. No pixel equality or performance claim.' };
assert.equal(report.browser.sha256, source.browser.sha256);
const viewer = await server.startTraceViewerServer({ host: '127.0.0.1', allowedFileRoots: [dirname(sourcePath)] });
let browser;
try {
  browser = await chromium.launch({ executablePath: report.browser.executablePath });
  for (const engine of ['playwright', 'flashwright']) {
    const trace = join(dirname(sourcePath), `${engine}-trace.zip`);
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.setDefaultTimeout(10000);
    const outcome = report.cases[engine] = { errors: [], sourceFallbacks: [], traceSha256: hash(await readFile(trace)), snapshots: {} };
    page.on('pageerror', error => outcome.errors.push(error.message));
    await page.route('**/file**', async route => {
      const path = new URL(route.request().url()).searchParams.get('path');
      if (!path || resolve(path) === trace) await route.continue();
      else { outcome.sourceFallbacks.push(path); await route.fulfill({ status: 404, body: '' }); }
    });
    try {
      await page.goto(`${viewer.urlPrefix('precise')}/trace/index.html?trace=${encodeURIComponent(`file?path=${encodeURIComponent(trace)}`)}`);
      const actions = page.getByRole('treeitem', { name: /insert/i });
      await actions.first().waitFor();
      assert.equal(await actions.count(), 1);
      await actions.first().click();
      await page.getByRole('tab', { name: 'Call', exact: true }).click();
      outcome.call = await page.getByRole('tabpanel', { name: 'Call', exact: true }).innerText();
      assert.match(outcome.call, /traceé😃/);
      await page.getByRole('tab', { name: 'Source', exact: true }).click();
      await page.getByTestId('source-code').getByText('keyboard-insert-text.mjs', { exact: true }).waitFor();
      await page.waitForFunction(() => {
        const editor = document.querySelector('[data-testid="source-code-mirror"] .CodeMirror');
        return editor?.CodeMirror?.getValue().includes("await page.keyboard.insertText('traceé😃')");
      });
      const sourceText = await page.getByTestId('source-code-mirror').locator('.CodeMirror').evaluate(element => element.CodeMirror.getValue());
      outcome.sourceSha256 = hash(Buffer.from(sourceText));
      outcome.highlightedSource = await page.getByTestId('source-code-mirror').locator('.source-line-running').innerText();
      assert.match(outcome.highlightedSource, /keyboard\.insertText/);
      for (const [phase, expectedValue] of [['Before', 'original'], ['After', 'otraceé😃nal']]) {
        await page.getByRole('tab', { name: phase, exact: true }).click();
        const snapshotPhase = phase === 'Before' ? 'input' : phase.toLowerCase();
        let snapshot;
        const deadline = Date.now() + 10000;
        while (!snapshot && Date.now() < deadline) {
          for (const frame of page.frames()) {
            const name = new URL(frame.url()).searchParams.get('name');
            if (name?.startsWith(`${snapshotPhase}@`) && await frame.locator('#target').count().catch(() => 0)) { snapshot = frame; break; }
          }
          if (!snapshot) await new Promise(resolve => setTimeout(resolve, 25));
        }
        assert.ok(snapshot, `Viewer must render the original ${phase} snapshot`);
        await snapshot.waitForFunction(() => document.readyState === 'complete' && !document.querySelector('[__playwright_value_]'));
        outcome.snapshots[phase] = await snapshot.locator('#target').inputValue();
        assert.equal(outcome.snapshots[phase], expectedValue);
      }
      assert.deepEqual(outcome.errors, []);
      assert.deepEqual(outcome.sourceFallbacks, [], 'Caller source must be embedded');
      const screenshot = join(destination, `${engine}.png`);
      await page.screenshot({ path: screenshot });
      outcome.screenshotSha256 = hash(await readFile(screenshot));
      outcome.status = 'passed';
    } finally { outcome.body = await page.locator('body').innerText(); await page.close(); }
  }
  assert.equal(hash(await readFile(report.browser.executablePath)), report.browser.sha256);
  assert.equal(hash(await readFile(new URL(import.meta.url))), report.toolSha256);
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = { name: error.name, message: error.message, stack: error.stack }; process.exitCode = 1; }
finally { await browser?.close(); await viewer.stop(); await writeFile(join(destination, 'report.json'), JSON.stringify(report, null, 2) + '\n'); }
