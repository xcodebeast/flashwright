import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { hash } from './competitor-inputs.mjs';
import { verifyPuppeteerSample, verifyWebdriverSample } from '../benchmarks/competitor-contract.mjs';

const read = async path => JSON.parse(await readFile(path, 'utf8'));

for (const engine of ['puppeteer', 'webdriverio']) test(`${engine} standalone sampling verifier checks raw evidence independently`, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'flashwright-sampling-verifier-test-'));
  const write = async (path, value) => writeFile(join(directory, path), typeof value === 'string' ? value : JSON.stringify(value) + '\n');
  try {
    // Historical report shapes are transformed into synthetic test evidence, never measurements.
    const original = engine === 'puppeteer' ? 'benchmarks/results/competitor-admission-2026-10-10/node22-full'
      : 'benchmarks/results/webdriverio-admission-2026-10-10/webdriverio-node22-full';
    const report = await read(`${original}/sample.json`);
    const resources = await read(`${original}/resources.json`);
    const inputs = await read(`${original}/inputs.json`);
    for (const path of Object.keys(inputs.inputs)) inputs.inputs[path] = hash(await readFile(path));
    const configuration = await read('benchmarks/configurations/baseline.json');
    const contenders = await read('benchmarks/configurations/competitors.json');
    const policy = await read('crates/flashwright-browser/src/chromium-launch-policy.json');
    const driverPolicy = await read('benchmarks/configurations/webdriverio-launch-policy.json');
    const launchIndex = 3;
    report.syntheticTestFixture = true;
    report.sampling = { launchIndex, reportPersistence: 'after-completion', isolationProbe: 'separate-admission', protocolLogging: engine === 'webdriverio' ? 'warning' : 'off' };
    report.workloads = report.workloads.slice(launchIndex).concat(report.workloads.slice(0, launchIndex));
    report.isolation = null;
    report.backend.documents -= 2;
    resources.command = [inputs.runtime.executable, `benchmarks/${engine}-admission.mjs`, join(directory, 'sample.json'), String(launchIndex)];
    if (engine === 'webdriverio') {
      report.browserProcessId = resources.processes[0].process;
      await write('chromedriver.log', '');
    }
    const verify = engine === 'puppeteer' ? verifyPuppeteerSample : verifyWebdriverSample;
    const receipt = { status: 'passed-sampling-outcomes', inputsUnchanged: true, exit: { code: 0, signal: null },
      ...verify(report, resources, configuration, contenders, policy, driverPolicy) };
    await write('inputs.json', inputs);
    await write('launch-inputs.json', { browser: report.browser, ...(engine === 'webdriverio' ? { driver: { sha256: report.driver.sha256, versionOutput: report.driver.versionOutput } } : {}) });
    await write('resources.json', resources);
    await write('stderr.txt', 'Synthetic verifier test. No browser launched.\n');
    const seal = async () => {
      await write('sample.json', report);
      await write('stdout.txt', report);
      receipt.files = {};
      for (const name of await readdir(directory)) if (name !== 'admission.json') receipt.files[name] = hash(await readFile(join(directory, name)));
      await write('admission.json', receipt);
    };
    const check = () => execFileSync(process.execPath, ['tools/verify-competitor-sampling.mjs', directory], { encoding: 'utf8', stdio: 'pipe' });
    await seal();
    assert.match(check(), new RegExp(`Verified ${engine} sampling outcomes`));
    const originalBytes = await readFile(join(directory, 'sample.json'), 'utf8');
    await write('sample.json', originalBytes + ' ');
    assert.throws(check, /sample.json/);
    await seal();
    report.backend.backendRequests--;
    await seal();
    assert.throws(check, /AssertionError/);
    report.backend.backendRequests++;
    await seal();
    receipt.performanceAccepted = true;
    await write('admission.json', receipt);
    assert.throws(check, /Changed sampling decision: performanceAccepted/);
    receipt.performanceAccepted = false;
    if (engine === 'webdriverio') {
      report.browserProcessId = -1;
      await seal();
      assert.throws(check, /Browser PID must belong/);
      report.browserProcessId = resources.processes[0].process;
      await write('chromedriver.log', '[123.456][DEBUG]: DevTools WebSocket Command\n');
      await seal();
      assert.throws(check, /Sampling must not contain verbose driver logging/);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
