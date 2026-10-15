import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { once } from 'node:events';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { identifyBrowser } from './browser-identity.mjs';
import { createHttpFixture } from './http-fixture.mjs';
import { runtimeMetadata, runtimeArtifactLabel } from './javascript-runtime.mjs';
import { sourceManifest } from './source-manifest.mjs';

const destination = resolve(`compatibility/evidence/runner-screenshots-${process.platform}-${process.arch}-${runtimeArtifactLabel}-${new Date().toISOString().replaceAll(':', '-')}`);
const browserPath = process.env.FLASHWRIGHT_BROWSER_PATH ?? chromium.executablePath();
const driverPath = process.env.FLASHWRIGHT_DRIVER_PATH ?? resolve('target/debug/flashwright-driver');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
await mkdir(destination, { recursive: true });
const report = { status: 'running', ...runtimeMetadata, browser: await identifyBrowser(browserPath), driverSha256: digest(await readFile(driverPath)), sources: await sourceManifest(), outcomes: {} };
const { server, close: closeServer } = createHttpFixture((_request, response) => {
  response.setHeader('content-type', 'text/html');
  response.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;min-height:240px}body{background:rgb(24,48,96)}</style>');
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
function specs(suites) { return suites.flatMap(suite => [...suite.specs, ...specs(suite.suites ?? [])]); }
try {
  for (const engine of ['playwright', 'flashwright']) {
    const directory = join(destination, engine);
    const outputDirectory = join(directory, 'output');
    await mkdir(directory);
    for (const name of ['playwright.config.ts', 'artifacts.spec.ts', 'module-context.spec.ts', 'pending-module-context.spec.ts']) {
      const source = await readFile(`compatibility/m2/runner-screenshots/${name}`, 'utf8');
      await writeFile(join(directory, name), engine === 'playwright' ? source.replaceAll("from '@flashwright/test'", "from '@playwright/test'").replaceAll("from 'flashwright'", "from 'playwright'") : source);
    }
    const reportPath = join(directory, 'results.json');
    const executable = engine === 'playwright' ? 'node_modules/playwright/cli.js' : 'packages/flashwright-test/cli.cjs';
    const child = spawn('python3', ['tools/process-fault-fixture.py', process.execPath, executable, 'test', '--config', join(directory, 'playwright.config.ts')], {
      env: { ...process.env, FLASHWRIGHT_BROWSER_PATH: browserPath, FLASHWRIGHT_DRIVER_PATH: driverPath, FLASHWRIGHT_SCREENSHOT_REPORT: reportPath, FLASHWRIGHT_SCREENSHOT_OUTPUT: outputDirectory, FLASHWRIGHT_TEST_BASE_URL: `http://127.0.0.1:${server.address().port}` },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const log = createWriteStream(join(directory, 'runner.log'));
    child.stdout.on('data', bytes => log.write(bytes));
    child.stderr.on('data', bytes => log.write(bytes));
    let code;
    try { code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); }); }
    finally { await new Promise(resolve => log.end(resolve)); }
    assert.equal(code, 1, `${engine}: intentional unexpected failures must fail the nested run`);
    const results = JSON.parse(await readFile(reportPath, 'utf8'));
    assert.equal(results.errors.length, 0, `${engine}: no global runner errors`);
    const cases = {};
    for (const spec of specs(results.suites)) {
      for (const test of spec.tests) {
        const key = `${test.projectName}: ${spec.title}`;
        cases[key] = { expectedStatus: test.expectedStatus, attempts: [] };
        for (const attempt of test.results) {
          const images = [];
          const diagnostics = attempt.attachments.filter(attachment => attachment.name === 'screenshot-error');
          if (engine === 'flashwright' && spec.title === 'page crash @failure') {
            assert.equal(diagnostics.length, 1, 'crash capture failure is explicitly diagnosed');
            assert.ok(Buffer.from(diagnostics[0].body, 'base64').byteLength <= 65536);
          } else assert.equal(diagnostics.length, 0, `${engine}: ${key} capture diagnostics`);
          for (const attachment of attempt.attachments.filter(attachment => attachment.name === 'screenshot')) {
            assert.equal(attachment.contentType, 'image/png');
            const bytes = await readFile(attachment.path);
            assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
            assert.match(basename(attachment.path), /^test-(failed|finished)-\d+\.png$/);
            images.push({ name: basename(attachment.path), width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), sha256: digest(bytes) });
          }
          images.sort((left, right) => left.name.localeCompare(right.name));
          cases[key].attempts.push({ status: attempt.status, retry: attempt.retry, images });
        }
      }
    }
    assert.equal(Object.keys(cases).length, 30, `${engine}: all selected cases ran`);
    assert.equal((await readdir(outputDirectory)).filter(name => name.startsWith('.flashwright-screenshots-')).length, 0, `${engine}: no temporary screenshot directories remain`);
    report.outcomes[engine] = { code, stats: results.stats, cases };
  }
  assert.deepEqual(report.outcomes.flashwright.cases, report.outcomes.playwright.cases, 'status, retry, filename, dimensions and PNG bytes match the pinned reference');
  assert.deepEqual(await sourceManifest(), report.sources);
  assert.equal(digest(await readFile(driverPath)), report.driverSha256);
  assert.equal(digest(await readFile(browserPath)), report.browser.sha256);
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.error = { message: error.message, stack: error.stack }; throw error;
} finally {
  await closeServer();
  await writeFile(join(destination, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`Runner screenshot evidence: ${destination}/report.json`);
}
