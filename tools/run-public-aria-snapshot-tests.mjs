import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { chromium as reference } from 'playwright';
import { chromium as candidate } from '../packages/flashwright-core/dist/esm/index.js';
import { publicAriaSnapshotCases, publicAriaSnapshotTraceCase } from '../compatibility/m2/public-aria-snapshots.mjs';
import { identifyBrowser } from './browser-identity.mjs';
import { sourceManifest } from './source-manifest.mjs';
import { runtimeMetadata } from './javascript-runtime.mjs';

// Run only under the repository's process watchdog, with exclusive browser-test ownership.
const destination = resolve(process.argv[2] ?? '.cache/public-aria-snapshots');
await mkdir(destination, { recursive: true });
const report = { status: 'running', ...runtimeMetadata, source: await sourceManifest(), referenceVersion: '1.60.0', outcomes: {}, traces: {}, scope: 'Public default snapshots only; AI mode and remote-frame ARIA snapshots remain unsupported; no performance claim' };
try {
  report.driverSha256 = createHash('sha256').update(await readFile(process.env.FLASHWRIGHT_DRIVER_PATH)).digest('hex');
  report.browser = await identifyBrowser(process.env.FLASHWRIGHT_BROWSER_PATH ?? reference.executablePath());
  assert.equal(report.browser.distribution, 'full-chromium');
  for (const [name, chromium] of [['playwright', reference], ['flashwright', candidate]]) {
    const browser = await chromium.launch({ executablePath: report.browser.executablePath });
    report.outcomes[name] = [];
    try {
      await publicAriaSnapshotCases(browser, name, report.outcomes[name]);
      const tracePath = join(destination, `${name}-aria.zip`);
      const values = await publicAriaSnapshotTraceCase(browser, name, tracePath);
      report.traces[name] = { values, ...JSON.parse(execFileSync('python3', ['tools/verify-public-aria-trace.py', tracePath, name], { encoding: 'utf8' })) };
    }
    finally { await browser.close(); }
  }
  assert.deepEqual(report.outcomes.flashwright, report.outcomes.playwright);
  assert.deepEqual(report.traces.flashwright.values, report.traces.playwright.values);
  assert.equal(createHash('sha256').update(await readFile(report.browser.executablePath)).digest('hex'), report.browser.sha256);
  assert.equal(createHash('sha256').update(await readFile(process.env.FLASHWRIGHT_DRIVER_PATH)).digest('hex'), report.driverSha256);
  assert.deepEqual(await sourceManifest(), report.source);
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.error = { name: error.name, message: error.message, stack: error.stack }; process.exitCode = 1;
} finally { await writeFile(join(destination, 'report.json'), JSON.stringify(report, null, 2) + '\n'); }
