import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { dialogHTML, dialogChildHTML } from '../compatibility/m2/dialog-fixture.mjs';
import { sourceManifest } from './source-manifest.mjs';
import { packConsumerPackages } from './packed-artifacts.mjs';
import { installPackedConsumer } from './install-packed-consumer.mjs';
import { createHttpFixture } from './http-fixture.mjs';
import { identifyBrowser } from './browser-identity.mjs';
import { runtimeMetadata } from './javascript-runtime.mjs';

const require = createRequire(import.meta.url);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const output = resolve(process.argv[2]);
await mkdir(output);
const consumer = await mkdtemp(join(tmpdir(), 'flashwright-dialogs-'));
const report = { status: 'running', ...runtimeMetadata, scope: 'Packed alias consumers run the same dialog, event-predicate, prepublication and beforeunload-navigation corpus in ESM and CommonJS; no performance claim.' };
const sourceHashes = sourceManifest;
const { server, close: closeServer } = createHttpFixture((request, response) => {
  response.setHeader('content-type', 'text/html; charset=utf-8');
  response.end(request.url === '/child' ? dialogChildHTML : dialogHTML);
});
try {
  assert(process.env.FLASHWRIGHT_BROWSER_PATH && process.env.FLASHWRIGHT_DRIVER_PATH, 'explicit browser and driver identities are required');
  report.sourceHashes = await sourceHashes();
  report.browser = await identifyBrowser(process.env.FLASHWRIGHT_BROWSER_PATH);
  report.driverSha256 = hash(await readFile(process.env.FLASHWRIGHT_DRIVER_PATH));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const { archives, dependencies } = await packConsumerPackages(output, { runner: true });
  await writeFile(join(consumer, 'package.json'), JSON.stringify({ name: 'dialogs-consumer', private: true, type: 'module', dependencies: { ...dependencies, '@playwright/test': 'npm:@flashwright/test@0.0.0', playwright: 'npm:flashwright@0.0.0', '@types/node': '24.10.1' } }));
  report.installation = await installPackedConsumer(consumer, Object.values(archives));
  report.packages = Object.fromEntries(await Promise.all(Object.entries(archives).map(async ([name, path]) => [name, { path, sha256: hash(await readFile(path)) }])));
  await copyFile('compatibility/m2/dialog-fixture.mjs', join(consumer, 'dialog-fixture.mjs'));
  await writeFile(join(consumer, 'poison.cjs'), `
const { dirname, join } = require('node:path');
const upstream = require(join(dirname(require.resolve('@flashwright/runner/package.json')), 'dist/upstream/test.js'));
for (const browser of [upstream.chromium, upstream.firefox, upstream.webkit]) {
  for (const method of ['launch', 'launchPersistentContext', 'connect', 'connectOverCDP']) browser[method] = async () => { throw new Error('Forbidden upstream browser backend entered'); };
}
upstream.request.newContext = async () => { throw new Error('Forbidden upstream request backend entered'); };
`);
  const body = `
test('packed ordinary dialogs', async ({ browser }) => {
  const { ordinaryDialogCases } = await import('./dialog-fixture.mjs');
  const origin = process.env.FLASHWRIGHT_DIALOG_ORIGIN;
  await ordinaryDialogCases(browser, (name, callback) => test.step(name, callback), origin);
});
`;
  await writeFile(join(consumer, 'dialogs-esm.spec.mjs'), `import './poison.cjs';\nimport { test } from '@playwright/test';\n${body}`);
  await writeFile(join(consumer, 'dialogs-commonjs.spec.cjs'), `require('./poison.cjs');\nconst { test } = require('@playwright/test');\n${body}`);
  const declarations = (await readFile('compatibility/m2/dialog-types.ts', 'utf8')).replaceAll("'@flashwright/test'", "'@playwright/test'").replaceAll("'flashwright'", "'playwright'");
  for (const extension of ['mts', 'cts']) await writeFile(join(consumer, `declarations.${extension}`), declarations);
  execFileSync(process.execPath, [require.resolve('typescript/bin/tsc'), '--noEmit', '--strict', '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', 'declarations.mts', 'declarations.cts'], { cwd: consumer, stdio: 'inherit' });
  await writeFile(join(consumer, 'flashwright.config.mjs'), `
import { defineConfig } from '@playwright/test';
export default defineConfig({ testDir: '.', testMatch: '*.spec.*', workers: 1, timeout: 90000, expect: { timeout: 3000 },
  reporter: [['json', { outputFile: process.env.FLASHWRIGHT_DIALOG_REPORT }]] });
`);
  const resultsPath = join(output, 'results.json');
  const child = spawn(process.execPath, ['node_modules/.bin/flashwright', 'test', '--config', 'flashwright.config.mjs'], { cwd: consumer, env: { ...process.env, FLASHWRIGHT_DIALOG_ORIGIN: origin, FLASHWRIGHT_DIALOG_REPORT: resultsPath }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { log += bytes; });
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  await writeFile(join(output, 'runner.log'), log);
  assert.equal(code, 0, log);
  const results = JSON.parse(await readFile(resultsPath));
  assert.equal(results.stats.expected, 2);
  assert.equal(results.stats.unexpected + results.stats.skipped + results.stats.flaky, 0);
  assert.deepEqual(results.errors, []);
  report.resultsSha256 = hash(await readFile(resultsPath));
  report.cases = { moduleModes: ['ESM', 'CommonJS'], groupsPerMode: 29, aliasDeclarations: ['NodeNext import', 'NodeNext require'], upstreamBrowserAndRequestPoisoned: true };
  assert.deepEqual(await sourceHashes(), report.sourceHashes);
  assert.deepEqual(await identifyBrowser(process.env.FLASHWRIGHT_BROWSER_PATH), report.browser);
  assert.equal(hash(await readFile(process.env.FLASHWRIGHT_DRIVER_PATH)), report.driverSha256);
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = error.stack ?? String(error); process.exitCode = 1; }
finally {
  try { if (server.listening) await closeServer(); }
  catch (error) { report.status = 'failed'; report.serverCleanupError = error.message; process.exitCode = 1; }
  try {
    await copyFile(join(consumer, 'install.log'), join(output, 'install.log'));
    if (report.installation) report.installation.log = join(output, 'install.log');
  } catch (error) {
    if (report.installation || error.code !== 'ENOENT') { report.status = 'failed'; report.cleanupError = error.message; process.exitCode = 1; }
  }
  try { await rm(consumer, { recursive: true, force: true }); }
  catch (error) { report.status = 'failed'; report.consumerCleanupError = error.message; process.exitCode = 1; }
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, cases: report.cases, error: report.error, cleanupError: report.cleanupError, serverCleanupError: report.serverCleanupError, consumerCleanupError: report.consumerCleanupError }));
}
