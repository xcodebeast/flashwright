import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { chromium } from 'flashwright';

const browser = await chromium.launch({ executablePath: process.env.FLASHWRIGHT_BROWSER_PATH });
const context = await browser.newContext();
const page = await context.newPage();
const destination = new URL('./', import.meta.url);
const report = { status: 'running', scope: 'Candidate-only trace retry reproduction; no timing or reference outcome comparison.' };
try {
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
  while (!(await page.evaluate(() => window.keys.includes('a')))) await new Promise(resolve => setTimeout(resolve, 10));
  const uploading = page.locator('#upload').setInputFiles({ name: 'fixture.txt', mimeType: 'text/plain', buffer: Buffer.from('original-node-capture') });
  await Promise.all([typing, uploading]);
  report.result = await page.locator('#upload').evaluate(element => ({ version: element.dataset.version, files: [...element.files].map(file => file.name) }));
  assert.deepEqual(report.result, { version: 'replacement', files: ['fixture.txt'] });
  await context.tracing.stop({ path: new URL('trace.zip', destination).pathname });
  report.status = 'reproduced-successful-replacement-upload';
} catch (error) {
  report.status = 'failed';
  report.error = { name: error.name, message: error.message, stack: error.stack };
  process.exitCode = 1;
} finally {
  await browser.close();
  await writeFile(new URL('report.json', destination), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
}
