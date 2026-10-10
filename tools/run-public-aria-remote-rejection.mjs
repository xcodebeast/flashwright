import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { chromium } from '../packages/flashwright-core/dist/esm/index.js';
import { identifyBrowser } from './browser-identity.mjs';
import { sourceManifest } from './source-manifest.mjs';
import { runtimeMetadata } from './javascript-runtime.mjs';
import { inspectRemoteAriaTarget } from './public-aria-remote-target.mjs';

// Run under tools/watchdog.py. The relay observes metadata without changing browser bytes.
const destination = resolve(process.argv[2]); await mkdir(destination, { recursive: true });
const wireDirectory = join(destination, 'wire'); await mkdir(wireDirectory);
const childUrl = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Remote picture"><text y="20">Remote content</text></svg>');
const server = createServer((_request, response) => { response.setHeader('content-type', 'text/html'); response.end('<button>Parent</button>'); });
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const parentUrl = `http://127.0.0.1:${server.address().port}/`;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const report = { status: 'running', ...runtimeMetadata, sources: await sourceManifest(), parentUrl, childUrl,
  scope: 'Typed rejection of a proven live remote frame target; no remote execution or performance claim' };
const names = ['FLASHWRIGHT_PROFILE_BROWSER_PATH', 'FLASHWRIGHT_PROFILE_PROTOCOL_DIRECTORY', 'FLASHWRIGHT_PROFILE_CLOCK_PORT'];
const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
let browser;
try {
  report.browser = await identifyBrowser(process.env.FLASHWRIGHT_BROWSER_PATH);
  report.driverSha256 = hash(await readFile(process.env.FLASHWRIGHT_DRIVER_PATH));
  process.env.FLASHWRIGHT_PROFILE_BROWSER_PATH = report.browser.executablePath;
  process.env.FLASHWRIGHT_PROFILE_PROTOCOL_DIRECTORY = wireDirectory;
  process.env.FLASHWRIGHT_PROFILE_CLOCK_PORT = '0';
  browser = await chromium.launch({ executablePath: resolve('tools/frame-placement-proxy.py') });
  const page = await browser.newPage();
  await page.goto(parentUrl);
  await page.evaluate(source => new Promise(resolve => {
    const frame = document.createElement('iframe'); frame.id = 'remote'; frame.setAttribute('sandbox', 'allow-scripts');
    frame.onload = () => resolve(); frame.src = source; document.body.append(frame);
  }), childUrl);
  const wireFiles = (await readdir(wireDirectory)).filter(name => name.endsWith('.jsonl'));
  assert.equal(wireFiles.length, 1);
  const wirePath = join(wireDirectory, wireFiles[0]);
  const records = () => readFile(wirePath, 'utf8').then(text => text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)));
  const before = await records();
  report.beforeRejection = inspectRemoteAriaTarget(before, parentUrl, childUrl);
  const parentSnapshot = await page.ariaSnapshot(); assert.match(parentSnapshot, /Parent/); assert.doesNotMatch(parentSnapshot, /Remote content|Remote picture/);
  await assert.rejects(() => page.frameLocator('#remote').locator('svg').ariaSnapshot({ timeout: 1500 }), error => {
    report.rejection = { name: error.name, message: error.message };
    return error.name === 'UnsupportedFeatureError' && error.details.method === 'aria.snapshot' && /out-of-process/i.test(error.message);
  });
  const after = await records();
  report.afterRejection = inspectRemoteAriaTarget(after, parentUrl, childUrl);
  assert.deepEqual(report.afterRejection, report.beforeRejection);
  report.recordRange = { before: before.length, after: after.length };
  await browser.close(); browser = undefined;
  report.wireSha256 = hash(await readFile(wirePath));
  assert.deepEqual(await sourceManifest(), report.sources);
  assert.equal(hash(await readFile(process.env.FLASHWRIGHT_DRIVER_PATH)), report.driverSha256);
  assert.equal(hash(await readFile(report.browser.executablePath)), report.browser.sha256);
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = { name: error.name, message: error.message, stack: error.stack }; process.exitCode = 1; }
finally {
  try { await browser?.close(); }
  finally {
    for (const name of names) { if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name]; }
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await writeFile(join(destination, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  }
}
