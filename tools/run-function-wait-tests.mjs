import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { chromium as reference } from 'playwright';
import { chromium as candidate } from 'flashwright';
import { createHttpFixture } from './http-fixture.mjs';
import { identifyBrowser } from './browser-identity.mjs';
import { sourceManifest } from './source-manifest.mjs';
import { runtimeMetadata } from './javascript-runtime.mjs';
import { execFileSync } from 'node:child_process';
import { functionWaitCases, functionWaitTraceCase } from '../compatibility/m2/function-waits.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const destination = resolve(process.argv[2] ?? `.cache/function-waits-${new Date().toISOString().replaceAll(':', '-')}`);
await mkdir(destination, { recursive: true });
const fixture = createHttpFixture((request, response) => {
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (request.url === '/successor') return response.end('<script>globalThis.successorReady={document:"successor"}</script>');
  if (request.url === '/frames') return response.end('<iframe name="child" src="/child"></iframe>');
  if (request.url === '/child') return response.end('<button>child</button><script>globalThis.realmMarker="child-main"</script>');
  response.end('<button>original</button>');
});
await new Promise(resolve => fixture.server.listen(0, '127.0.0.1', resolve));
const baseURL = `http://127.0.0.1:${fixture.server.address().port}`;
const report = { status: 'running', ...runtimeMetadata, referenceVersion: '1.60.0', sources: await sourceManifest(), outcomes: {}, traces: {},
  functionalBuild: { incremental: process.env.CARGO_INCREMENTAL, devDebug: process.env.CARGO_PROFILE_DEV_DEBUG, testDebug: process.env.CARGO_PROFILE_TEST_DEBUG },
  scope: 'Page/Frame.waitForFunction functional differentials; no performance, platform release or default-adoption claim.' };
try {
  report.browser = await identifyBrowser(process.env.FLASHWRIGHT_BROWSER_PATH ?? reference.executablePath());
  report.driverSha256 = hash(await readFile(process.env.FLASHWRIGHT_DRIVER_PATH));
  for (const [name, chromium] of [['playwright', reference], ['flashwright', candidate]]) {
    const browser = await chromium.launch({ executablePath: report.browser.executablePath });
    try {
      report.outcomes[name] = []; await functionWaitCases(browser, baseURL, report.outcomes[name]);
      const tracePath = join(destination, `${name}-function-waits.zip`);
      const outcomes = await functionWaitTraceCase(browser, baseURL, tracePath);
      report.traces[name] = { outcomes, ...JSON.parse(execFileSync('python3', ['tools/verify-function-wait-trace.py', tracePath], { encoding: 'utf8' })) };
    }
    finally { await browser.close(); }
  }
  assert.deepEqual(report.outcomes.flashwright, report.outcomes.playwright);
  assert.deepEqual(report.traces.flashwright.outcomes, report.traces.playwright.outcomes);
  assert.deepEqual(await sourceManifest(), report.sources);
  assert.equal(hash(await readFile(report.browser.executablePath)), report.browser.sha256);
  assert.equal(hash(await readFile(process.env.FLASHWRIGHT_DRIVER_PATH)), report.driverSha256);
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = { name: error.name, message: error.message, stack: error.stack }; process.exitCode = 1; }
finally { await fixture.close(); await writeFile(join(destination, 'report.json'), JSON.stringify(report, null, 2) + '\n'); }
