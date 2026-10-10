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
const directory = resolve(process.argv[2]); await mkdir(directory);
const consumer = join(directory, 'consumer'); await mkdir(consumer);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const report = { status: 'running', ...runtimeMetadata, sources: await sourceManifest(), scope: 'Fresh Bun-installed tarball consumer, ESM/CJS identity and public ARIA declarations/runtime; no release-platform or performance claim' };
try {
  report.browser = await identifyBrowser(process.env.FLASHWRIGHT_BROWSER_PATH);
  report.driverSha256 = hash(await readFile(process.env.FLASHWRIGHT_DRIVER_PATH));
  const packed = await packConsumerPackages(directory);
  report.archives = {};
  for (const [name, path] of Object.entries(packed.archives)) report.archives[name] = { path, sha256: hash(await readFile(path)) };
  await writeFile(join(consumer, 'package.json'), JSON.stringify({ name: 'public-aria-consumer', private: true, type: 'module', dependencies: { ...packed.dependencies, '@types/node': '24.10.1' } }));
  report.installation = await installPackedConsumer(consumer, Object.values(packed.archives));
  await writeFile(join(consumer, 'consumer.mjs'), `
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { realpathSync } from 'node:fs';
import * as imported from 'flashwright';
const require = createRequire(import.meta.url);
const required = require('flashwright');
assert.equal(imported.Page, required.Page);
assert.ok(realpathSync(require.resolve('flashwright')).startsWith(process.cwd() + '/node_modules/'));
assert.ok(realpathSync(require.resolve('@flashwright/core')).startsWith(process.cwd() + '/node_modules/'));
const results = [];
for (const [format, library] of [['esm', imported], ['commonjs', required]]) {
  const browser = await library.chromium.launch();
  try {
    const page = await browser.newPage();
    await page.evaluate(() => { document.body.innerHTML = '<button>Packed snapshot</button><iframe id="child"></iframe>'; document.querySelector('iframe').contentDocument.body.innerHTML = '<button>Child snapshot</button>'; });
    const snapshot = await page.ariaSnapshot();
    assert.match(snapshot, /Packed snapshot/); assert.doesNotMatch(snapshot, /Child snapshot/);
    const locator = await page.getByRole('button').ariaSnapshot({ mode: 'default', boxes: true, timeout: 1000 });
    assert.match(locator, /Packed snapshot/); assert.match(locator, /box=/);
    assert.equal(await page.ariaSnapshot({ depth: -1 }), '');
    const child = await page.frameLocator('#child').getByRole('button').ariaSnapshot();
    assert.match(child, /Child snapshot/);
    await assert.rejects(() => page.ariaSnapshot({ mode: 'ai' }), { name: 'UnsupportedFeatureError' });
    await assert.rejects(() => page.getByRole('button').ariaSnapshot({ mode: 'ai' }), { name: 'UnsupportedFeatureError' });
    results.push({ format, snapshot, locator, child });
  } finally { await browser.close(); }
}
console.log(JSON.stringify(results));
`);
  await writeFile(join(consumer, 'consumer.ts'), `
import { type Page, type Locator, type AriaSnapshotOptions } from 'flashwright';
async function check(page: Page, locator: Locator) {
  const options: AriaSnapshotOptions = { mode: 'default', depth: -1, boxes: true, timeout: 0 };
  const pageValue: string = await page.ariaSnapshot(options);
  const locatorValue: string = await locator.ariaSnapshot(options);
  const childValue: string = await page.frameLocator('iframe').getByRole('button').ariaSnapshot();
  void [pageValue, locatorValue, childValue];
  // @ts-expect-error Unsupported mode strings are not declaration-compatible.
  await page.ariaSnapshot({ mode: 'other' });
  // @ts-expect-error Boolean boxes are required.
  await locator.ariaSnapshot({ boxes: 'true' });
  // @ts-expect-error Numeric depth is required.
  await locator.ariaSnapshot({ depth: 'one' });
}
void check;
`);
  execFileSync(process.execPath, [require.resolve('typescript/bin/tsc'), '--noEmit', '--strict', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--target', 'ES2022', '--types', 'node', 'consumer.ts'], { cwd: consumer, encoding: 'utf8' });
  const output = execFileSync(process.execPath, ['consumer.mjs'], { cwd: consumer, encoding: 'utf8', timeout: 45000 });
  report.outcomes = JSON.parse(output);
  assert.equal(report.outcomes.length, 2);
  assert.deepEqual(await sourceManifest(), report.sources);
  assert.equal(hash(await readFile(process.env.FLASHWRIGHT_DRIVER_PATH)), report.driverSha256);
  assert.equal(hash(await readFile(report.browser.executablePath)), report.browser.sha256);
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = { name: error.name, message: error.message, stack: error.stack }; process.exitCode = 1; }
finally { await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n'); }
