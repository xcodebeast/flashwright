import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium } from 'flashwright';
import { runtimeMetadata } from './javascript-runtime.mjs';

const destination = resolve(process.argv[2]);
await mkdir(destination, { recursive: true });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const driverPath = resolve(process.env.FLASHWRIGHT_DRIVER_PATH ?? 'target/debug/flashwright-driver');
const browserPath = process.env.FLASHWRIGHT_BROWSER_PATH;
assert.ok(browserPath, 'Use the explicitly identified core-verification browser');
const sources = Object.fromEntries(await Promise.all([
  'tools/test-input-retry-snapshots.mjs', 'tools/verify-input-retry-traces.py',
  'tools/verify-frame-locator-traces.py', 'crates/flashwright-engine/src/recording.rs',
  'crates/flashwright-engine/src/file_inputs.rs',
].map(async path => [path, hash(await readFile(path))])));
const report = {
  status: 'running', ...runtimeMetadata, sources,
  driverSha256: hash(await readFile(driverPath)), browserSha256: hash(await readFile(browserPath)),
  scope: 'Candidate-only captured upload retry and trace attempt history. Keyboard holds the native input lock while the selected upload node is replaced. No performance or equivalent reference scheduling claim.',
};
const browser = await chromium.launch({ executablePath: browserPath });
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('data:text/html,<input id="typing"><input id="upload" type="file" data-version="original">');
  await page.evaluate(() => {
    window.keys = [];
    document.querySelector('#typing').addEventListener('keydown', event => {
      window.keys.push(event.key);
      if (event.key === 'c') {
        const replacement = document.createElement('input');
        replacement.type = 'file';
        replacement.id = 'upload';
        replacement.dataset.version = 'replacement';
        document.querySelector('#upload').replaceWith(replacement);
      }
    });
  });
  await page.locator('#typing').focus();
  await context.tracing.start({ snapshots: true, sources: true });
  const typing = page.keyboard.type('abcd', { delay: 1000 });
  const started = performance.now();
  while (!(await page.evaluate(() => window.keys.includes('a')))) {
    assert.ok(performance.now() - started < 10000, 'Keyboard input did not start');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const uploading = page.locator('#upload').setInputFiles({ name: 'fixture.txt', mimeType: 'text/plain', buffer: Buffer.from('original-node-capture') });
  await Promise.all([typing, uploading]);
  report.result = await page.locator('#upload').evaluate(element => ({ version: element.dataset.version, files: [...element.files].map(file => file.name) }));
  assert.deepEqual(report.result, { version: 'replacement', files: ['fixture.txt'] });
  await context.tracing.stop({ path: join(destination, 'trace.zip') });
  report.traceSha256 = hash(await readFile(join(destination, 'trace.zip')));
  report.trace = JSON.parse(execFileSync('python3', ['tools/verify-input-retry-traces.py', join(destination, 'trace.zip')], { encoding: 'utf8' }));
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.error = { name: error.name, message: error.message, stack: error.stack };
  process.exitCode = 1;
} finally {
  await browser.close();
  report.driverChangedDuringVerification = report.driverSha256 !== hash(await readFile(driverPath));
  report.browserChangedDuringVerification = report.browserSha256 !== hash(await readFile(browserPath));
  report.sourceChangedDuringVerification = (await Promise.all(Object.entries(sources).map(async ([path, digest]) => digest !== hash(await readFile(path))))).some(Boolean);
  if (report.driverChangedDuringVerification || report.browserChangedDuringVerification || report.sourceChangedDuringVerification) {
    report.status = 'failed';
    process.exitCode = 1;
  }
  await writeFile(join(destination, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
}
