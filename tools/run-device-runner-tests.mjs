import { createHttpFixture } from './http-fixture.mjs';
import { identifyBrowser } from './browser-identity.mjs';
import { runtimeMetadata } from './javascript-runtime.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
import { sourceManifest } from './source-manifest.mjs';

const destination = resolve(`compatibility/evidence/device-runner-${process.platform}-${process.arch}-${new Date().toISOString().replaceAll(':', '-')}`);
await mkdir(destination, { recursive: true });
const report = { status: 'running', browser: await identifyBrowser(process.env.FLASHWRIGHT_BROWSER_PATH ?? chromium.executablePath()), sources: await sourceManifest(), ...runtimeMetadata, driverSha256: createHash('sha256').update(await readFile(process.env.FLASHWRIGHT_DRIVER_PATH ?? 'target/debug/flashwright-driver')).digest('hex'), outcomes: {} };
const { server, close: closeServer } = createHttpFixture((_request, response) => {
  response.setHeader('content-type', 'text/html');
  response.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;background:rgb(24,48,96)}</style>');
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
try {
  for (const engine of ['playwright', 'flashwright']) {
    const fixture = join(destination, engine);
    await mkdir(fixture);
    for (const filename of ['playwright.config.ts', 'presets.spec.ts', 'options.spec.ts']) {
      const source = await readFile(`compatibility/m2/device-runner/${filename}`, 'utf8');
      await writeFile(join(fixture, filename), engine === 'playwright' ? source.replaceAll("from '@flashwright/test'", "from '@playwright/test'") : source);
    }
    const reportPath = join(fixture, 'results.json');
    const executable = engine === 'playwright' ? 'node_modules/playwright/cli.js' : 'packages/flashwright-test/cli.cjs';
    const child = spawn(process.execPath, [executable, 'test', '--config', join(fixture, 'playwright.config.ts')], {
      stdio: 'inherit', env: { ...process.env, FLASHWRIGHT_DEVICE_RUNNER: engine, FLASHWRIGHT_DEVICE_REPORT: reportPath, FLASHWRIGHT_TEST_BASE_URL: `http://127.0.0.1:${server.address().port}`, FLASHWRIGHT_DRIVER_PATH: process.env.FLASHWRIGHT_DRIVER_PATH ?? resolve('target/debug/flashwright-driver'), FLASHWRIGHT_BROWSER_PATH: process.env.FLASHWRIGHT_BROWSER_PATH ?? chromium.executablePath() },
    });
    const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
    report.outcomes[engine] = { code, report: JSON.parse(await readFile(reportPath, 'utf8')) };
    assert.equal(code, 0, `${engine}: all device runner cases pass`);
    assert.equal(report.outcomes[engine].report.stats.expected, 5);
  }
  assert.deepEqual(await sourceManifest(), report.sources);
  assert.equal(createHash('sha256').update(await readFile(report.browser.executablePath)).digest('hex'), report.browser.sha256);
  assert.equal(createHash('sha256').update(await readFile(process.env.FLASHWRIGHT_DRIVER_PATH ?? 'target/debug/flashwright-driver')).digest('hex'), report.driverSha256);
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.error = { message: error.message, stack: error.stack }; throw error;
} finally {
  await closeServer();
  await writeFile(join(destination, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`Device runner evidence: ${destination}/report.json`);
}
