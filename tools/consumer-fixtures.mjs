import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** The same test bodies run under preferred imports and package-manager aliases. */
export async function writeConsumerFixtures(directory, { aliases, libraryOnly }) {
  const library = aliases ? 'playwright' : 'flashwright';
  const runner = aliases ? '@playwright/test' : '@flashwright/test';
  const common = `
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { spawnSync } = require('node:child_process');
const library = require('${library}');
const libraryPath = require.resolve('${library}');
const libraryRequire = createRequire(libraryPath);
const corePath = libraryRequire.resolve('@flashwright/core');
assert.ok(libraryPath.startsWith(process.env.FLASHWRIGHT_CONSUMER_ROOT + '/'));
assert.ok(corePath.startsWith(process.env.FLASHWRIGHT_CONSUMER_ROOT + '/'));
assert.equal(spawnSync('cargo', ['--version']).error?.code, 'ENOENT');
assert.equal(process.env.FLASHWRIGHT_DRIVER_PATH, undefined);
`;
  const runnerIdentity = libraryOnly ? `
assert.throws(() => require('${library}/test'), error => error.name === 'UnsupportedFeatureError' && error.message.includes('install @flashwright/test@0.0.0'));
assert.equal(Object.keys(require.cache).some(path => path.includes('flashwright-runner') || path.includes('flashwright-upstream-runner')), false);
` : `
const runner = require('${runner}');
const runnerRequire = createRequire(require.resolve('${runner}'));
const implementationPath = runnerRequire.resolve('@flashwright/runner');
const implementationRequire = createRequire(implementationPath);
const runnerCore = implementationRequire('@flashwright/core');
for (const name of ['Page', 'Locator', 'chromium', 'errors', 'TimeoutError']) assert.equal(library[name], runnerCore[name], name);
assert.equal(corePath, implementationRequire.resolve('@flashwright/core'));
assert.equal(runner.test, require('@flashwright/test').test);
assert.equal(runner.test, require('${library}/test').test);
assert.equal(runner.expect, require('${library}/test').expect);
require('./poison.cjs');
`;
  await writeFile(join(directory, 'identity.cjs'), `${common}${runnerIdentity}
module.exports = { library, corePath };
`);
  await writeFile(join(directory, 'identity.mjs'), `
import assert from 'node:assert/strict';
import common from './identity.cjs';
import * as library from '${library}';
${libraryOnly ? '' : `import defaultTest, * as runner from '${runner}';\nimport defaultForwarding, * as forwarding from '${library}/test';\nassert.equal(runner.test, forwarding.test);\nassert.equal(defaultTest, runner.test);\nassert.equal(defaultForwarding, runner.test);`}
for (const name of ['Page', 'Locator', 'chromium', 'errors', 'TimeoutError']) assert.equal(library[name], common.library[name]);
const first = await library.chromium.launch();
const second = await common.library.chromium.launch();
try {
  const page = await first.newPage(); const other = await second.newPage();
  await page.goto(process.env.FLASHWRIGHT_TEST_BASE_URL);
  await page.getByLabel('Name').fill('identity'); await page.getByRole('button').click();
  assert.equal(await page.getByRole('status').textContent(), 'Saved identity');
  await page.evaluate(() => { window.owner = 'first'; });
  assert.equal(await other.evaluate(() => window.owner), undefined);
  await first.close(); assert.equal(await other.evaluate(() => 42), 42);
} finally { await first.close(); await second.close(); }
console.log('Consumer identity, native input, isolated ownership and cleanup passed');
`);
  if (libraryOnly) return;
  await writeFile(join(directory, 'poison.cjs'), `
const { createRequire } = require('node:module');
const runnerRequire = createRequire(require.resolve('${runner}'));
const implementationRequire = createRequire(runnerRequire.resolve('@flashwright/runner'));
const upstream = implementationRequire('flashwright-upstream-runner/test');
for (const browser of [upstream.chromium, upstream.firefox, upstream.webkit]) {
  for (const method of ['launch', 'launchPersistentContext', 'connect', 'connectOverCDP']) browser[method] = async () => { throw new Error('Forbidden upstream browser backend entered'); };
}
upstream.request.newContext = async () => { throw new Error('Forbidden upstream request backend entered'); };
`);
  const body = `
test('installed native fixture', async ({ page }) => {
  await page.goto('/'); await page.getByLabel('Name').fill('consumer'); await page.getByRole('button').click();
  await expect(page.getByRole('status')).toHaveText('Saved consumer');
  expect(await page.evaluate(() => innerWidth)).toBe(640);
});
`;
  await writeFile(join(directory, 'esm.spec.mjs'), `import './poison.cjs';\nimport test, { expect } from '${runner}';\n${body}`);
  await writeFile(join(directory, 'forwarding.spec.cjs'), `require('./poison.cjs');\nconst { test, expect } = require('${library}/test');\n${body}`);
  const types = `
import defaultTest, { test as base, expect, type Fixtures, type WorkerInfo } from '${runner}';
import defaultForwarding from '${library}/test';
import type { Page } from '${library}';
import type { Reporter, FullResult } from '${runner}/reporter';
import type { Page as RequiredPage } from '${library}' with { 'resolution-mode': 'require' };
const typedDefault: typeof base = defaultTest; const typedForwarding: typeof base = defaultForwarding;
void typedDefault; void typedForwarding;
class PageObject { constructor(readonly page: Page) {} async save(name: string) { await this.page.getByLabel('Name').fill(name); await this.page.getByRole('button').click(); } }
type Options = { label: string; pageObject: PageObject };
const fixtures: Fixtures<Options, { workerLabel: string }, { page: Page }, {}> = {
 label: ['typed', { option: true }],
 workerLabel: [async ({}, use, info: WorkerInfo) => use(String(info.workerIndex)), { scope: 'worker' }],
 pageObject: async ({ page }, use) => use(new PageObject(page)),
};
const test = base.extend<Options, { workerLabel: string }>(fixtures);
test('typed page object and extended fixture', async ({ page, pageObject, label, workerLabel }) => {
 const required: RequiredPage = page; void required;
 await page.goto('/'); await pageObject.save(label); await expect(page.getByRole('status')).toHaveText('Saved typed');
 expect(workerLabel).toMatch(/^\\d+$/);
});
class CustomReporter implements Reporter { onEnd(result: FullResult) { void result.status; } } void CustomReporter;
`;
  for (const name of ['typed.spec.ts', 'declarations.mts', 'declarations.cts']) await writeFile(join(directory, name), `import './poison.cjs';\n${types}`);
  await writeFile(join(directory, 'playwright.config.mjs'), `
import { defineConfig } from '${runner}';
export default defineConfig({ testDir: '.', testMatch: '*.spec.*', workers: 1, timeout: 15000,
 use: { baseURL: process.env.FLASHWRIGHT_TEST_BASE_URL, viewport: { width: 640, height: 480 } },
 reporter: [['list'], ['json', { outputFile: 'report.json' }]] });
`);
}
