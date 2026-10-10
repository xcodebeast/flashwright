import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium } from 'flashwright';
import { runtimeMetadata } from './javascript-runtime.mjs';

const destination = resolve(process.argv[2]);
await mkdir(destination, { recursive: true });
const browserPath = process.env.FLASHWRIGHT_BROWSER_PATH;
assert.ok(browserPath, 'Select the real browser for the controlled pipe relay');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sourcePaths = ['tools/test-pointer-cleanup.mjs', 'tools/pointer-cleanup-browser.py', 'crates/flashwright-engine/src/pointer.rs'];
const sources = async () => Object.fromEntries(await Promise.all(sourcePaths.map(async path => [path, hash(await readFile(path))])));
const driverPath = resolve(process.env.FLASHWRIGHT_DRIVER_PATH ?? 'target/debug/flashwright-driver');
const identities = async () => ({ driverSha256: hash(await readFile(driverPath)), browserSha256: hash(await readFile(browserPath)) });
const report = { status: 'running', ...runtimeMetadata, ...await identities(), sources: await sources(), cases: [] };
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const executable = join(destination, 'browser-relay');
await writeFile(executable, `#!/bin/sh\nexec python3 ${quote(resolve('tools/pointer-cleanup-browser.py'))} "$@"\n`, { mode: 0o700, flag: 'wx' });
try {
  for (const mode of ['resident-rejection', 'group-rejection', 'resident-timeout', 'success']) {
    const logPath = join(destination, `${mode}.jsonl`);
    process.env.FLASHWRIGHT_POINTER_CLEANUP_MODE = mode;
    process.env.FLASHWRIGHT_POINTER_CLEANUP_BROWSER = browserPath;
    process.env.FLASHWRIGHT_POINTER_CLEANUP_LOG = logPath;
    const browser = await chromium.launch({ executablePath: executable });
    const evidence = { mode, status: 'running' };
    report.cases.push(evidence);
    try {
      const page = await browser.newPage();
      await page.goto('data:text/html,<button>Activate</button>');
      const started = performance.now();
      const error = await page.locator('button').click({ timeout: 0 }).then(() => undefined, error => error);
      evidence.elapsedMilliseconds = performance.now() - started;
      evidence.error = error?.details;
      assert.equal(error?.name, 'ProtocolError');
      assert.match(error.message, /Chromium omitted a page execution context identity/);
      assert.equal(error.details.inputDelivery, 'notDispatched');
      evidence.events = (await readFile(logPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      const probes = evidence.events.filter(event => event.event === 'liveResidentProbe');
      assert.equal(probes.length, 1);
      assert.equal(probes[0].response.result.result.value, true, 'The original resident attempt must remain physically live');
      const closures = evidence.events.filter(event => event.event === 'commandAfterFailure' && event.method === 'Target.closeTarget');
      assert.equal(closures.length, mode === 'success' ? 0 : 1, 'Unsuccessful cleanup must close its original page');
      const original = evidence.events.find(event => event.event === 'semanticFailure');
      if (closures.length) assert.equal(closures[0].parameters.targetId, original.target);
      for (const event of evidence.events.filter(event => ['residentCleanup', 'groupCleanup'].includes(event.event))) {
        assert.equal(event.session, original.session, 'Cleanup must retain the original session');
      }
      assert.equal(error.details.cleanup, mode === 'success' ? 'residentReleased' : 'resourceDisposed');
      assert.equal(evidence.events.filter(event => event.event === 'commandAfterFailure' && event.method.startsWith('Input.')).length, 0, 'No input may be replayed');
      if (mode === 'resident-timeout') {
        assert.ok(evidence.elapsedMilliseconds >= 450, 'Withheld cleanup must reach its bounded timeout');
        assert.equal(evidence.events.filter(event => event.event === 'withheldCleanupReply').length, 1);
      }
      evidence.status = 'passed';
    } catch (error) {
      evidence.status = 'failed';
      evidence.failure = error.stack;
      throw error;
    } finally {
      await browser.close();
    }
  }
  assert.deepEqual(await sources(), report.sources);
  assert.deepEqual(await identities(), { driverSha256: report.driverSha256, browserSha256: report.browserSha256 });
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.failure = error.stack;
  process.exitCode = 1;
} finally {
  for (const suffix of ['MODE', 'BROWSER', 'LOG']) delete process.env[`FLASHWRIGHT_POINTER_CLEANUP_${suffix}`];
  await writeFile(join(destination, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, cases: report.cases.map(({ mode, status }) => ({ mode, status })) }));
}
