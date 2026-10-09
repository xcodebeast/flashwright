import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { runtimeMetadata, runtimeArtifactLabel } from './javascript-runtime.mjs';

const directory = resolve(`compatibility/evidence/routing-${process.platform}-${process.arch}-${runtimeArtifactLabel}-${new Date().toISOString().replaceAll(':', '-')}`);
await mkdir(directory, { recursive: true });
const browser = process.env.FLASHWRIGHT_BROWSER_PATH ?? chromium.executablePath();
const hash = value => createHash('sha256').update(value).digest('hex');
const report = { status: 'running', referenceVersion: '1.60.0', ...runtimeMetadata, browser, cases: {}, comparisons: {}, intentionalDifferences: {}, exclusions: ['Optional raw CDP diagnostics are outside the public Route contract; CDPSession remains unsupported.', 'Ephemeral local ports and engine-specific error stack frames are excluded from equality; original callback locations are asserted by the error fixture.', 'The already-handled error accepts the pinned Bun fulfill or Node route.fulfill prefix. Its exact error class, operation and substantive message remain asserted; raw messages are retained.'] };
report.allowedSchedulingDifferences = {};
function normalize(value) {
  if (typeof value === 'string') return value.replace(/(127\.0\.0\.1|localhost):\d+/g, '$1:PORT');
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => !['stack', 'rawRequests'].includes(key)).map(([key, item]) => [key, normalize(item)]));
  return value;
}
function run(command, arguments_, environment) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, { stdio: 'inherit', env: environment });
    child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error(`${command} failed with ${code}`)));
  });
}
try {
  for (const kind of ['reference', 'lifecycle', 'errors', 'payloads']) {
    const fixture = `compatibility/m2/routing-${kind}.mjs`;
    report.cases[kind] = { fixture, fixtureSha256: hash(await readFile(fixture)), outcomes: {} };
    for (const implementation of ['playwright', 'flashwright']) {
      const destination = join(directory, `${kind}-${implementation}`);
      const environment = { ...process.env, FLASHWRIGHT_DRIVER_PATH: process.env.FLASHWRIGHT_DRIVER_PATH ?? resolve('target/debug/flashwright-driver'), FLASHWRIGHT_BROWSER_PATH: browser, FLASHWRIGHT_ROUTING_IMPLEMENTATION: implementation };
      await run('python3', ['tools/watchdog.py', '--timeout', '180', '--report-directory', join(directory, 'resources'), '--', process.execPath, fixture, destination], environment);
      const bytes = await readFile(join(destination, 'report.json')); const result = JSON.parse(bytes);
      assert.equal(result.status, 'passed');
      report.cases[kind].outcomes[implementation] = { report: `${kind}-${implementation}/report.json`, sha256: hash(bytes), cases: result.cases };
    }
    const reference = normalize(report.cases[kind].outcomes.playwright.cases), candidate = normalize(report.cases[kind].outcomes.flashwright.cases);
    if (kind === 'lifecycle') {
      for (const name of ['defaultRemoval', 'ignoreErrorsRemoval']) {
        const expected = reference[name].callback, actual = candidate[name].callback;
        for (const callback of [expected, actual]) {
          assert.equal(callback.name, 'Error'); assert.equal(callback.status, 'rejected');
          assert.match(callback.message, /^(?:route\.)?fulfill: Route is already handled!$/);
        }
        if (expected.message !== actual.message) report.intentionalDifferences[name + 'DiagnosticPrefix'] = { reference: expected.message, flashwright: actual.message };
        expected.message = actual.message = 'fulfill: Route is already handled!';
      }
      assert.equal(reference.closedCallback.evaluation.name, 'Error');
      assert.equal(candidate.closedCallback.evaluation.name, 'TargetClosedError');
      assert.match(reference.closedCallback.evaluation.message, /closed/); assert.match(candidate.closedCallback.evaluation.message, /closed/);
      report.intentionalDifferences.closedEvaluation = { reference: reference.closedCallback.evaluation, flashwright: candidate.closedCallback.evaluation };
      delete reference.closedCallback.evaluation; delete candidate.closedCallback.evaluation;
      report.allowedSchedulingDifferences.closedRequestDispatch = {
        reference: reference.closedCallback.serverCount, flashwright: candidate.closedCallback.serverCount,
        reason: 'Target closure can dispatch the original paused request before the held callback resumes; each fixture independently rejects replay.',
      };
      delete reference.closedCallback.serverCount; delete candidate.closedCallback.serverCount;
    }
    assert.deepEqual(candidate, reference);
    report.comparisons[kind] = { status: 'equal', cases: Object.keys(candidate).length };
  }
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = { message: error.message, stack: error.stack }; process.exitCode = 1; }
finally { await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n'); console.log('Routing differential: ' + join(directory, 'report.json')); }
