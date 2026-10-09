import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';

const [reportArgument] = process.argv.slice(2);
assert.ok(reportArgument, 'usage: test-trace-filmstrip-viewer.mjs REPORT');
const sourcePath = resolve(reportArgument);
const sourceBytes = await readFile(sourcePath);
const source = JSON.parse(sourceBytes);
assert.equal(source.status, 'passed');
const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');
const { server } = require('playwright-core/lib/coreBundle');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const output = join(dirname(sourcePath), 'viewer');
await mkdir(output);
const report = { status: 'running', referenceReport: sourcePath, referenceReportSha256: hash(sourceBytes), cases: [] };
const viewer = await server.startTraceViewerServer({ host: '127.0.0.1', allowedFileRoots: [dirname(sourcePath)] });
let browser;
try {
  browser = await chromium.launch({ executablePath: source.browser.executablePath });
  for (const trace of Object.entries(source.outcomes).flatMap(([engine, traces]) => Object.entries(traces).map(([name, trace]) => ({ ...trace, label: `${engine}-${name}` })))) {
    assert.equal(hash(await readFile(trace.path)), trace.sha256);
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.setDefaultTimeout(10000);
    const item = { label: trace.label, traceSha256: trace.sha256, errors: [], blockedRequests: [] };
    report.cases.push(item);
    page.on('pageerror', error => item.errors.push({ message: error.message, stack: error.stack }));
    const prefix = viewer.urlPrefix('precise');
    await page.route('**/*', async route => {
      const url = route.request().url();
      if (!url.startsWith(prefix) && !url.startsWith('data:') && !url.startsWith('blob:')) {
        item.blockedRequests.push(url);
        await route.abort();
      } else if (new URL(url).pathname.endsWith('/file') && new URL(url).searchParams.get('path') !== trace.path) {
        item.blockedRequests.push(url);
        await route.fulfill({ status: 404, body: '' });
      } else await route.continue();
    });
    try {
      await page.goto(`${prefix}/trace/index.html?trace=${encodeURIComponent(`file?path=${encodeURIComponent(trace.path)}`)}`);
      await page.locator('.film-strip-frame').first().waitFor();
      item.lanes = await page.locator('.film-strip-lane').count();
      assert.equal(item.lanes, new Set(trace.frames.map(frame => frame.pageId)).size);
      // Decode and hash the actual URLs used by rendered background thumbnails.
      item.displayedImages = await page.locator('.film-strip-frame').evaluateAll(async elements => {
        const urls = [...new Set(elements.map(element => getComputedStyle(element).backgroundImage.match(/^url\(["']?(.*?)["']?\)$/)?.[1]).filter(Boolean))];
        return await Promise.all(urls.map(async url => {
          const response = await fetch(url);
          if (!response.ok) throw new Error(`thumbnail returned ${response.status}`);
          const bytes = await response.arrayBuffer();
          const digest = await crypto.subtle.digest('SHA-256', bytes);
          const image = new Image();
          image.src = url;
          await image.decode();
          return { url, sha256: Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join(''), width: image.naturalWidth, height: image.naturalHeight };
        }));
      });
      assert.ok(item.displayedImages.length);
      for (const image of item.displayedImages) {
        assert.ok(trace.frames.some(frame => frame.imageSha256 === image.sha256));
        assert.ok(image.width > 0 && image.height > 0);
      }
      assert.deepEqual(item.errors, []);
      assert.deepEqual(item.blockedRequests, []);
      item.status = 'passed';
    } finally {
      item.screenshot = join(output, `${trace.label}.png`);
      await page.screenshot({ path: item.screenshot });
      await writeFile(join(output, `${trace.label}-dom.json`), JSON.stringify({ body: await page.locator('body').innerText(), filmstrip: await page.locator('.film-strip').innerHTML().catch(() => '') }, null, 2));
      await page.close();
    }
  }
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.error = { message: error.message, stack: error.stack };
  process.exitCode = 1;
} finally {
  await browser?.close();
  await viewer.stop();
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(join(output, 'report.json'));
}
