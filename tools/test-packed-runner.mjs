import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { chromium } from 'playwright';

const require = createRequire(import.meta.url);
const directory = await mkdtemp(resolve('.cache/packed-runner-'));
const archives = {};
for (const name of ['flashwright', 'flashwright-test']) {
  const packed = JSON.parse(execFileSync('npm', ['pack', '--workspace', `packages/${name}`, '--pack-destination', directory, '--json'], { encoding: 'utf8' }));
  archives[name] = join(directory, packed[0].filename);
}
await writeFile(join(directory, 'package.json'), JSON.stringify({ name: 'flashwright-packed-runner-consumer', private: true, type: 'module', dependencies: { flashwright: `file:${archives.flashwright}`, '@flashwright/test': `file:${archives['flashwright-test']}`, '@types/node': '24.10.1' } }, null, 2));
execFileSync('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: directory, stdio: 'pipe' });

await writeFile(join(directory, 'poison.cjs'), `
const upstream = require('flashwright-upstream-runner/test');
for (const browser of [upstream.chromium, upstream.firefox, upstream.webkit]) {
  for (const method of ['launch', 'launchPersistentContext', 'connect', 'connectOverCDP']) browser[method] = async () => { throw new Error('Forbidden upstream browser backend entered'); };
}
upstream.request.newContext = async () => { throw new Error('Forbidden upstream request backend entered'); };
`);
await writeFile(join(directory, 'identity.mjs'), `
import './poison.cjs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as library from 'flashwright';
import * as runner from '@flashwright/test';
const require = createRequire(import.meta.url);
const commonLibrary = require('flashwright');
const commonRunner = require('@flashwright/test');
for (const name of ['chromium', 'Page', 'Locator', 'errors', 'TimeoutError']) assert.equal(library[name], commonLibrary[name]);
for (const name of ['test', 'expect', 'errors']) assert.equal(runner[name], commonRunner[name]);
const browser = await library.chromium.launch();
try {
  const page = await browser.newPage();
  await page.goto(process.env.FLASHWRIGHT_TEST_BASE_URL);
  await commonRunner.expect(page.locator('h1')).toHaveText('Packed runner');
  await runner.expect(page).toHaveTitle('Packed adapter');
} finally { await browser.close(); }
`);
const testBody = `
test('packed fixture and assertion', async ({ page }, testInfo) => {
  await page.goto('/');
  await page.getByLabel('Name').fill('consumer');
  await page.getByLabel('Name').press('Enter');
  await expect(page.getByRole('status')).toHaveText('Saved consumer');
  await expect(page).toHaveTitle('Packed adapter');
  expect(await page.evaluate(() => innerWidth)).toBe(640);
  await testInfo.attach('packed-mode', { body: 'native', contentType: 'text/plain' });
});
`;
await writeFile(join(directory, 'esm.spec.mjs'), `import './poison.cjs';\nimport { test, expect } from '@flashwright/test';\n${testBody}`);
await writeFile(join(directory, 'commonjs.spec.cjs'), `require('./poison.cjs');\nconst { test, expect } = require('@flashwright/test');\n${testBody}`);
const typeBody = `
import { test as base, expect, defineConfig, type Page, type TestInfo, type WorkerInfo, type Fixtures } from '@flashwright/test';
import type { Reporter, FullConfig, FullResult } from '@flashwright/test/reporter';
import type { Page as RequiredPage } from 'flashwright' with { 'resolution-mode': 'require' };
class PageObject {
  constructor(readonly page: Page) {}
  async save(name: string): Promise<void> { await this.page.getByLabel('Name').fill(name); await this.page.getByLabel('Name').press('Enter'); }
}
type Custom = { label: string; pageObject: PageObject };
type Worker = { workerLabel: string };
const fixtures: Fixtures<Custom, Worker, { page: Page }, {}> = {
  label: ['typed', { option: true }],
  workerLabel: [async ({}, use, info: WorkerInfo) => use(String(info.workerIndex)), { scope: 'worker' }],
  pageObject: async ({ page }, use) => use(new PageObject(page)),
};
const test = base.extend<Custom, Worker>(fixtures);
test.use({ label: 'packed', viewport: { width: 800, height: 600 } });
test('typed extended fixture', async ({ page, pageObject, label, workerLabel }, info: TestInfo) => {
  const requiredPage: RequiredPage = page; void requiredPage;
  await page.goto('/'); await pageObject.save(label);
  await expect(page.getByRole('status')).toHaveText('Saved packed');
  expect(workerLabel).toMatch(/^\\d+$/);
  expect(await page.evaluate(() => innerWidth)).toBe(800);
  await info.attach('packed-mode', { body: 'typed', contentType: 'text/plain' });
});
class CustomReporter implements Reporter {
  onBegin(config: FullConfig) { void config.projects; }
  onEnd(result: FullResult) { void result.status; }
}
void CustomReporter;
const config = defineConfig<Custom, Worker>({ use: { label: 'config', workerLabel: 'worker' } }); void config;
`;
await writeFile(join(directory, 'typed.spec.ts'), `import './poison.cjs';\n${typeBody}`);
for (const extension of ['mts', 'cts']) await writeFile(join(directory, `declarations.${extension}`), typeBody);
execFileSync(process.execPath, [require.resolve('typescript/bin/tsc'), '--noEmit', '--strict', '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', 'declarations.mts', 'declarations.cts'], { cwd: directory, stdio: 'inherit' });
await writeFile(join(directory, 'flashwright.config.mjs'), `
import { defineConfig } from '@flashwright/test';
export default defineConfig({ testDir: '.', testMatch: '*.spec.*', workers: 1, timeout: 10000, expect: { timeout: 1000 },
 use: { contextOptions: { baseURL: process.env.FLASHWRIGHT_TEST_BASE_URL, viewport: { width: 640, height: 480 } } },
 reporter: [['list'], ['json', { outputFile: 'report.json' }]] });
`);

const server = createServer((_request, response) => response.end('<title>Packed adapter</title><h1>Packed runner</h1><form onsubmit="event.preventDefault();document.querySelector(\'output\').textContent=\'Saved \'+document.querySelector(\'input\').value"><label>Name<input></label></form><output role="status">Ready</output>'));
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const environment = { ...process.env, FLASHWRIGHT_TEST_BASE_URL: 'http://127.0.0.1:' + server.address().port, FLASHWRIGHT_DRIVER_PATH: process.env.FLASHWRIGHT_DRIVER_PATH ?? resolve('target/debug/flashwright-driver'), FLASHWRIGHT_BROWSER_PATH: process.env.FLASHWRIGHT_BROWSER_PATH ?? chromium.executablePath() };
async function run(arguments_, expectedCode = 0) {
  const child = spawn('python3', [resolve('tools/watchdog.py'), '--timeout', '90', '--', process.execPath, ...arguments_], { cwd: directory, env: environment, stdio: 'inherit' });
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  assert.equal(code, expectedCode);
}
try {
  await run(['identity.mjs']);
  await run(['node_modules/.bin/flashwright', 'test', '--config', 'flashwright.config.mjs']);
  await run(['node_modules/.bin/flashwright', 'test', '--ui'], 1);
  const report = JSON.parse(await readFile(join(directory, 'report.json'), 'utf8'));
  assert.equal(report.stats.expected, 3); assert.equal(report.stats.unexpected, 0);
  const hash = value => createHash('sha256').update(value).digest('hex');
  const evidence = { node: process.version, platform: process.platform, architecture: process.arch, consumerDirectory: directory,
    archives: Object.fromEntries(await Promise.all(Object.entries(archives).map(async ([name, archive]) => [name, { archive, sha256: hash(await readFile(archive)) }]))),
    driverSha256: hash(await readFile(environment.FLASHWRIGHT_DRIVER_PATH)), report,
    checks: ['fresh packed library and adapter install', 'ESM and CommonJS share public class and runner identities', 'mixed-module native assertions', 'NodeNext import/require declarations and fixture generics', 'reporter type subpath', 'ESM, CommonJS and TypeScript runner files', 'nested context options and fixture overrides', 'installed CLI and interactive-mode rejection', 'upstream browser/request methods poisoned'],
    remaining: ['platform runtime distribution', 'pnpm/Yarn and aliases', 'artifact hooks and full runner configuration parity'] };
  const destination = `compatibility/evidence/packed-runner-${process.platform}-${process.arch}-${process.versions.node}.json`;
  await writeFile(destination, JSON.stringify(evidence, null, 2) + '\n');
  console.log(`Packed runner consumers passed: ${destination}`);
} finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
