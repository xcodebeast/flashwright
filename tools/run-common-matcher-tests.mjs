import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { commonMatcherHTML, commonMatcherCases } from '../compatibility/m2/common-matchers-fixture.mjs';
import { identifyBrowser } from './browser-identity.mjs';
import { runtimeMetadata } from './javascript-runtime.mjs';

const require = createRequire(import.meta.url);
const implementation = process.env.FLASHWRIGHT_MATCHER_IMPLEMENTATION ?? (process.argv.includes('--candidate') ? 'flashwright' : 'playwright');
assert(['playwright', 'flashwright'].includes(implementation));
const { chromium } = require(implementation === 'playwright' ? 'playwright' : 'flashwright');
const { expect } = require(implementation === 'playwright' ? 'flashwright-upstream-runner/test' : '@flashwright/test');
const output = resolve(process.argv[2]);
const browserPath = process.env.FLASHWRIGHT_BROWSER_PATH;
assert(browserPath, 'explicit identified browser is required');
await mkdir(output);
const report = { status: 'running', implementation, ...runtimeMetadata, checks: [], scope: 'Common DOM matcher differential; no performance claim or JSProperty support.' };
const sources = ['tools/run-common-matcher-tests.mjs', 'compatibility/m2/common-matchers-fixture.mjs', 'packages/flashwright-runner/src/matchers.ts', 'packages/flashwright-runner/src/index.ts', 'packages/flashwright-core/src/assertions.ts', 'crates/flashwright-engine/src/assertions.rs', 'packages/resident-runtime/locator-runtime.js', 'packages/resident-runtime/playwright-injected.js', 'packages/resident-runtime/condition-registry.js'];
const hash = value => createHash('sha256').update(value).digest('hex');
const sourceHashes = async () => Object.fromEntries(await Promise.all(sources.map(async name => [name, hash(await readFile(name))])));
const server = createServer((request, response) => {
  response.setHeader('content-type', 'text/html; charset=utf-8');
  response.end(request.url === '/child' ? '<button id="child-button">Child action</button>' : request.url === '/successor' ? '<div id="successor" class="arrived">Successor</div>' : commonMatcherHTML);
});
let browser;
try {
  report.sourceHashes = await sourceHashes();
  report.browser = await identifyBrowser(browserPath);
  if (implementation === 'flashwright') report.driverSha256 = hash(await readFile(process.env.FLASHWRIGHT_DRIVER_PATH));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const baseURL = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ executablePath: browserPath });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(baseURL);
  await commonMatcherCases(page, expect, async (name, callback) => { await callback(); report.checks.push(name); }, baseURL, implementation);
  await context.close();
  assert.deepEqual(await sourceHashes(), report.sourceHashes);
  assert.deepEqual(await identifyBrowser(browserPath), report.browser);
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = error.stack ?? String(error); process.exitCode = 1; }
finally {
  try { await browser?.close(); }
  catch (error) {
    report.status = 'failed';
    report.cleanupError = error.stack ?? String(error);
    process.exitCode = 1;
  }
  server.closeAllConnections();
  if (server.listening) await new Promise(resolve => server.close(resolve));
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, implementation, checks: report.checks, error: report.error, cleanupError: report.cleanupError }));
}
