import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { ordinaryDialogCases, dialogHTML, dialogChildHTML } from '../compatibility/m2/dialog-fixture.mjs';
import { identifyBrowser } from './browser-identity.mjs';
import { runtimeMetadata } from './javascript-runtime.mjs';
import { sourceManifest } from './source-manifest.mjs';
import { createHttpFixture } from './http-fixture.mjs';

const require = createRequire(import.meta.url);
const implementation = process.argv.includes('--candidate') ? 'flashwright' : 'playwright';
const { chromium } = require(implementation);
assert(process.argv[2], 'an unused report directory is required');
const output = resolve(process.argv[2]);
const browserPath = process.env.FLASHWRIGHT_BROWSER_PATH;
assert(browserPath, 'an explicit identified browser is required');
await mkdir(output);
const hash = value => createHash('sha256').update(value).digest('hex');
const report = {
  status: 'running', implementation, ...runtimeMetadata, checks: [],
  scope: 'Shared alert/confirm/prompt, event-predicate, prepublication and beforeunload-navigation corpus. No performance claim, dismissible page-close or general cross-process frame support assertion.',
};
const save = () => writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
const fixture = createHttpFixture((request, response) => {
  response.setHeader('content-type', 'text/html; charset=utf-8');
  response.end(request.url === '/child' ? dialogChildHTML : dialogHTML);
});
let browser;
try {
  report.sourceHashes = await sourceManifest();
  report.browser = await identifyBrowser(browserPath);
  if (implementation === 'flashwright') {
    assert(process.env.FLASHWRIGHT_DRIVER_PATH, 'an explicit candidate driver is required');
    report.driverSha256 = hash(await readFile(process.env.FLASHWRIGHT_DRIVER_PATH));
  }
  await save();
  await new Promise(resolve => fixture.server.listen(0, '127.0.0.1', resolve));
  const baseURL = `http://127.0.0.1:${fixture.server.address().port}`;
  browser = await chromium.launch({ executablePath: browserPath });
  await ordinaryDialogCases(browser, async (name, callback) => {
    const result = { name, status: 'running' };
    report.checks.push(result);
    await save();
    try { await callback(); result.status = 'passed'; }
    catch (error) { result.status = 'failed'; result.error = error.stack ?? String(error); throw error; }
    finally { await save(); }
  }, baseURL);
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = error.stack ?? String(error); process.exitCode = 1; }
finally {
  try { await browser?.close(); }
  catch (error) { report.status = 'failed'; report.cleanupError = error.stack ?? String(error); process.exitCode = 1; }
  try { if (fixture.server.listening) await fixture.close(); }
  catch (error) { report.status = 'failed'; report.serverCleanupError = error.stack ?? String(error); process.exitCode = 1; }
  try {
    if (report.sourceHashes) assert.deepEqual(await sourceManifest(), report.sourceHashes);
    if (report.browser) assert.deepEqual(await identifyBrowser(browserPath), report.browser);
    if (report.driverSha256) assert.equal(hash(await readFile(process.env.FLASHWRIGHT_DRIVER_PATH)), report.driverSha256);
  } catch (error) { report.status = 'failed'; report.identityError = error.stack ?? String(error); process.exitCode = 1; }
  await save();
  console.log(JSON.stringify({ status: report.status, implementation, checks: report.checks, error: report.error, cleanupError: report.cleanupError, identityError: report.identityError }));
}
