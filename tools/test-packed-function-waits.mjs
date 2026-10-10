import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { packConsumerPackages } from './packed-artifacts.mjs';
import { installPackedConsumer } from './install-packed-consumer.mjs';
import { runtimeMetadata } from './javascript-runtime.mjs';
import { sourceManifest } from './source-manifest.mjs';
import { identifyBrowser } from './browser-identity.mjs';

const require = createRequire(import.meta.url);
const destination = resolve(process.argv[2]); await mkdir(destination);
const consumer = join(destination, 'consumer'); await mkdir(consumer);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const report = { status: 'running', ...runtimeMetadata, sources: await sourceManifest(),
  functionalBuild: { incremental: process.env.CARGO_INCREMENTAL, devDebug: process.env.CARGO_PROFILE_DEV_DEBUG, testDebug: process.env.CARGO_PROFILE_TEST_DEBUG },
  scope: 'Fresh packed library consumer, ESM/CommonJS identity, Page/Frame predicate declarations and runtime. Compact functional driver only; no release or performance claim.' };
try {
  report.browser = await identifyBrowser(process.env.FLASHWRIGHT_BROWSER_PATH);
  report.driverSha256 = hash(await readFile(process.env.FLASHWRIGHT_DRIVER_PATH));
  const packed = await packConsumerPackages(destination);
  report.archives = {};
  for (const [name, path] of Object.entries(packed.archives)) report.archives[name] = { path, sha256: hash(await readFile(path)) };
  await writeFile(join(consumer, 'package.json'), JSON.stringify({ name: 'function-wait-consumer', private: true, type: 'module', dependencies: { ...packed.dependencies, '@types/node': '24.10.1' } }));
  report.installation = await installPackedConsumer(consumer, Object.values(packed.archives));
  await writeFile(join(consumer, 'consumer.mjs'), `
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { realpathSync } from 'node:fs';
import * as imported from 'flashwright';
const require = createRequire(import.meta.url);
const required = require('flashwright');
assert.equal(imported.Page, required.Page); assert.equal(imported.Frame, required.Frame);
assert.ok(realpathSync(require.resolve('@flashwright/core')).startsWith(process.cwd() + '/node_modules/'));
const results = [];
for (const [format, library] of [['esm', imported], ['commonjs', required]]) {
  const browser = await library.chromium.launch();
  try {
    const page = await browser.newPage();
    const object = await page.waitForFunction(value => ({ answer: value }), 42, { timeout: 1000 });
    assert.deepEqual(await object.jsonValue(), { answer: 42 }); await object.dispose();
    const mainFrameValue = await page.mainFrame().waitForFunction(async () => false, undefined, { polling: 5, timeout: 1000 });
    assert.equal(await mainFrameValue.jsonValue(), false); await mainFrameValue.dispose();
    const element = await page.waitForFunction(() => document.body);
    assert.equal(element.asElement(), element); assert.equal(await element.evaluate(value => value.ownerDocument === document), true);
    await element.dispose();
    await assert.rejects(page.waitForFunction(() => false, undefined, { timeout: 50 }), { name: 'TimeoutError' });
    await assert.rejects(page.mainFrame().waitForFunction(() => true, undefined, { polling: 0 }), { name: 'InvalidArgumentError' });
    results.push({ format, outcomes: 5 });
  } finally { await browser.close(); }
}
console.log(JSON.stringify(results));
`);
  await writeFile(join(consumer, 'consumer.ts'), await readFile('compatibility/m2/runner/function-wait-types.ts'));
  execFileSync(process.execPath, [require.resolve('typescript/bin/tsc'), '--noEmit', '--strict', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--target', 'ES2022', '--types', 'node', 'consumer.ts'], { cwd: consumer, encoding: 'utf8' });
  report.outcomes = JSON.parse(execFileSync(process.execPath, ['consumer.mjs'], { cwd: consumer, env: process.env, encoding: 'utf8', timeout: 90000 }).trim());
  assert.deepEqual(await sourceManifest(), report.sources);
  assert.equal(hash(await readFile(process.env.FLASHWRIGHT_DRIVER_PATH)), report.driverSha256);
  assert.equal(hash(await readFile(report.browser.executablePath)), report.browser.sha256);
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = { name: error.name, message: error.message, stack: error.stack }; process.exitCode = 1; }
finally { await writeFile(join(destination, 'report.json'), JSON.stringify(report, null, 2) + '\n'); }
