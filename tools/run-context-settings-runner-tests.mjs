import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
import { sourceManifest } from './source-manifest.mjs';
import { startContextSettingsFixture } from './context-settings-fixture.mjs';
import { identifyBrowser } from './browser-identity.mjs';
import { runtimeMetadata, runtimeArtifactLabel } from './javascript-runtime.mjs';

const destination = resolve(process.argv[2] ?? `compatibility/evidence/context-settings-runner-${process.platform}-${process.arch}-${runtimeArtifactLabel}-${new Date().toISOString().replaceAll(':', '-')}`);
await mkdir(destination, { recursive: true });
const hash = value => createHash('sha256').update(value).digest('hex');
const driver = process.env.FLASHWRIGHT_DRIVER_PATH ?? resolve('target/debug/flashwright-driver');
const browser = await identifyBrowser(process.env.FLASHWRIGHT_BROWSER_PATH ?? chromium.executablePath());
const report = { status: 'running', referenceVersion: '1.60.0', ...runtimeMetadata, browser, sources: await sourceManifest(),
  driverSha256: hash(await readFile(driver)), outcomes: {}, scope: 'Context settings inheritance, hooks/manual contexts, explicit overrides and zero slow motion. No performance claim.' };
const fixture = await startContextSettingsFixture();
try {
  for (const engine of ['playwright', 'flashwright']) {
    const directory = join(destination, engine); await mkdir(directory);
    for (const filename of ['playwright.config.ts', 'settings.spec.ts']) {
      const source = await readFile(`compatibility/m2/context-settings-runner/${filename}`, 'utf8');
      await writeFile(join(directory, filename), engine === 'playwright'
        ? source.replaceAll("from '@flashwright/test'", "from '@playwright/test'").replaceAll("from 'flashwright'", "from 'playwright'") : source);
    }
    const resultPath = join(directory, 'results.json');
    const executable = engine === 'playwright' ? 'node_modules/playwright/cli.js' : 'packages/flashwright-test/cli.cjs';
    const child = spawn('python3', ['tools/watchdog.py', '--timeout', '180', '--report-directory', join(destination, 'resources'),
      '--', process.execPath, executable, 'test', '--config', join(directory, 'playwright.config.ts')], {
      stdio: 'inherit', env: { ...process.env, FLASHWRIGHT_DRIVER_PATH: driver, FLASHWRIGHT_BROWSER_PATH: browser.executablePath,
        FLASHWRIGHT_SETTINGS_ORIGIN: fixture.origin, FLASHWRIGHT_SETTINGS_SECURE_ORIGIN: fixture.secureOrigin,
        FLASHWRIGHT_SETTINGS_ENGINE: engine, FLASHWRIGHT_SETTINGS_RESULTS: resultPath },
    });
    const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
    const results = JSON.parse(await readFile(resultPath, 'utf8'));
    report.outcomes[engine] = { code, results };
    assert.equal(code, 0, `${engine} context settings must pass`);
    assert.equal(results.stats.expected, 9);
  }
  assert.deepEqual(await sourceManifest(), report.sources);
  assert.equal(hash(await readFile(driver)), report.driverSha256);
  assert.equal(hash(await readFile(browser.executablePath)), browser.sha256);
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = { message: error.message, stack: error.stack }; throw error; }
finally {
  try { await fixture.close(); }
  catch (error) { report.status = 'failed'; report.cleanupError = { message: error.message, stack: error.stack }; process.exitCode = 1; }
  await writeFile(join(destination, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`Context settings runner evidence: ${destination}/report.json`);
}
