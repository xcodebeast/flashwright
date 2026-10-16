import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { packConsumerPackages } from './packed-artifacts.mjs';
import { installPackedConsumer, cleanupPackedConsumer } from './install-packed-consumer.mjs';
import { sourceManifest } from './source-manifest.mjs';
import { identifyBrowser } from './browser-identity.mjs';

const destination = resolve(process.argv[2]); await mkdir(destination);
const consumer = join(destination, 'consumer'); await mkdir(consumer);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const reportPath = join(destination, 'report.json');
const report = { schemaVersion: 1, status: 'running', sources: await sourceManifest(),
  runtime: process.versions.bun ? `bun ${process.versions.bun}` : process.version,
  scope: 'Fresh packed ESM/CommonJS library and matcher consumer using an explicit development driver. Remote read/assertion ownership only; no platform-package acquisition, release or performance claim.' };
let verificationPersisted = false;
try {
  report.browser = await identifyBrowser(process.env.FLASHWRIGHT_BROWSER_PATH);
  assert.equal(report.browser.distribution, 'full-chromium');
  report.driverSha256 = hash(await readFile(process.env.FLASHWRIGHT_DRIVER_PATH));
  const packed = await packConsumerPackages(destination, { runner: true });
  report.archives = {};
  for (const [name, path] of Object.entries(packed.archives)) report.archives[name] = { path, sha256: hash(await readFile(path)) };
  await writeFile(join(consumer, 'package.json'), JSON.stringify({ name: 'remote-locator-consumer', private: true, type: 'module', dependencies: packed.dependencies }));
  report.installation = await installPackedConsumer(consumer, Object.values(packed.archives));
  const source = `import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {realpathSync} from 'node:fs';
import {createServer} from 'node:http';
import {once} from 'node:events';
import * as imported from 'flashwright';
import {expect as importedExpect} from '@flashwright/test';
const require = createRequire(import.meta.url), required = require('flashwright'), requiredExpect = require('@flashwright/test').expect;
assert.equal(imported.Frame, required.Frame); assert.equal(imported.Locator, required.Locator);
assert.equal(importedExpect, requiredExpect);
assert(realpathSync(require.resolve('@flashwright/core')).startsWith(process.cwd() + '/node_modules/'));
let port;
const server = createServer((request,response) => {
  response.setHeader('content-type','text/html; charset=utf-8');
  response.end(request.url === '/child' ? '<h1>Remote</h1><input value="initial"><p id="value">before</p>' : '<iframe id="child" name="child" src="http://localhost:'+port+'/child"></iframe>');
});
server.listen(0); await once(server,'listening'); port = server.address().port;
const outcomes = [];
try {
  for (const [format,library,expect] of [['esm',imported,importedExpect],['commonjs',required,requiredExpect]]) {
    const browser = await library.chromium.launch({executablePath:process.env.FLASHWRIGHT_BROWSER_PATH});
    try {
      const context = await browser.newContext(); const page = await context.newPage();
      await page.goto('http://127.0.0.1:'+port+'/');
      const child = page.frameLocator('#child');
      await assert.rejects(child.locator('input').fill('unadmitted'), error => error.name === 'UnsupportedFeatureError' && /out-of-process/.test(error.message));
      assert.equal(await child.locator('input').inputValue(),'initial');
      assert.equal(await child.getByRole('heading').textContent(),'Remote');
      assert.equal(await child.locator('p').count(),1);
      await expect(child.getByRole('heading')).toHaveText('Remote');
      await page.frame('child').evaluate(() => {setTimeout(() => document.querySelector('#value').textContent='after',40);});
      await expect(page.frame('child').locator('#value')).toHaveText('after');
      await context.close(); outcomes.push({format,remotePlacementGuard:true,reads:3,assertions:2});
    } finally { await browser.close(); }
  }
} finally { await new Promise(resolve => server.close(resolve)); }
console.log(JSON.stringify(outcomes));
`;
  await writeFile(join(consumer, 'consumer.mjs'), source, { flag: 'wx' });
  report.consumerSourceSha256 = hash(source);
  const output = execFileSync(process.execPath, ['consumer.mjs'], { cwd: consumer, env: process.env, encoding: 'utf8', timeout: 90000 });
  await writeFile(join(consumer, 'stdout.txt'), output, { flag: 'wx' });
  report.outcomes = JSON.parse(output.trim());
  assert.deepEqual(report.outcomes.map(row => row.format), ['esm', 'commonjs']);
  assert.deepEqual(await sourceManifest(), report.sources);
  assert.equal(hash(await readFile(process.env.FLASHWRIGHT_DRIVER_PATH)), report.driverSha256);
  assert.equal(hash(await readFile(report.browser.executablePath)), report.browser.sha256);
  report.status = 'passed';
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  verificationPersisted = true;
  const cleanup = await cleanupPackedConsumer(consumer, report.installation, reportPath, import.meta.url);
  assert.equal(cleanup.status, 'passed');
} catch (error) {
  process.exitCode = 1;
  const failure = { name: error.name, message: error.message, stack: error.stack };
  if (verificationPersisted) {
    // Cleanup failure cannot rewrite the original completed verification receipt.
    await writeFile(join(destination, 'cleanup-failure.json'), JSON.stringify(failure, null, 2) + '\n', { flag: 'wx' });
  } else { report.status = 'failed'; report.error = failure; }
} finally {
  if (!verificationPersisted) await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
}
console.log(JSON.stringify({ status: report.status, outcomes: report.outcomes, error: report.error }));
