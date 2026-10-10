import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { verifyPuppeteerAdmission, verifyWebdriverAdmission, verifyPuppeteerSample, verifyWebdriverSample } from '../benchmarks/competitor-contract.mjs';
import { dependencyManifest, hash } from './competitor-inputs.mjs';
import { identifyBrowser } from './browser-identity.mjs';

const destinationArgument = process.argv[2];
assert.ok(destinationArgument, 'Usage: run-competitor-admission.mjs NEW_OUTPUT_DIRECTORY [puppeteer|webdriverio] [LAUNCH_INDEX]');
const engine = process.argv[3] ?? 'puppeteer';
const launchIndex = process.argv[4] === undefined ? undefined : Number(process.argv[4]);
const sampling = launchIndex !== undefined;
assert.ok(process.argv.length <= 5);
if (sampling) assert.ok(Number.isInteger(launchIndex) && launchIndex >= 0);
assert.ok(['puppeteer', 'webdriverio'].includes(engine), 'Unknown competitor');
assert.ok(process.env.FLASHWRIGHT_COMPETITOR_DIRECTORY, 'Set FLASHWRIGHT_COMPETITOR_DIRECTORY to the pinned isolated dependency installation');
assert.ok(process.env.FLASHWRIGHT_BROWSER_PATH, 'Set FLASHWRIGHT_BROWSER_PATH to the pinned browser');
const destination = resolve(destinationArgument);
await mkdir(destination);
const inputPaths = ['tools/run-competitor-admission.mjs', `benchmarks/${engine}-admission.mjs`, `benchmarks/${engine}-workloads.mjs`, 'benchmarks/competitor-contract.mjs', 'benchmarks/fixture-server.mjs', 'tools/http-fixture.mjs', 'tools/browser-identity.mjs', 'tools/javascript-runtime.mjs', 'tools/watchdog.py', 'benchmarks/configurations/baseline.json', 'benchmarks/configurations/competitors.json', `benchmarks/competitors/${engine}/package.json`, `benchmarks/competitors/${engine}/bun.lock`, 'crates/flashwright-browser/src/chromium-launch-policy.json'];
if (engine === 'webdriverio') inputPaths.push('benchmarks/configurations/webdriverio-launch-policy.json');
inputPaths.push('tools/competitor-inputs.mjs');
const readInputs = async () => Object.fromEntries(await Promise.all(inputPaths.map(async path => [path, hash(await readFile(path))])));

const dependencies = resolve(process.env.FLASHWRIGHT_COMPETITOR_DIRECTORY);
const inputs = await readInputs();
const installedDependencies = await dependencyManifest(dependencies);
const browserSha256 = hash(await readFile(process.env.FLASHWRIGHT_BROWSER_PATH));
const runtime = process.env.FLASHWRIGHT_COMPETITOR_RUNTIME ?? process.execPath;
assert.ok(isAbsolute(runtime), 'FLASHWRIGHT_COMPETITOR_RUNTIME must be an absolute executable path');
const runtimeSha256 = hash(await readFile(runtime));
const driverPath = engine === 'webdriverio' ? process.env.FLASHWRIGHT_CHROMEDRIVER_PATH : undefined;
if (engine === 'webdriverio') assert.ok(driverPath, 'Set FLASHWRIGHT_CHROMEDRIVER_PATH');
const driverSha256 = driverPath ? hash(await readFile(driverPath)) : undefined;
await writeFile(join(destination, 'inputs.json'), JSON.stringify({ inputs, installedDependencies, browserSha256, driverSha256, runtime: { executable: runtime, sha256: runtimeSha256 } }, null, 2) + '\n', { flag: 'wx' });
if (sampling) {
  const browser = await identifyBrowser(process.env.FLASHWRIGHT_BROWSER_PATH);
  assert.equal(browser.sha256, browserSha256);
  const driver = driverPath ? { sha256: driverSha256, versionOutput: execFileSync(driverPath, ['--version'], { encoding: 'utf8', timeout: 10000 }).trim() } : undefined;
  await writeFile(join(destination, 'launch-inputs.json'), JSON.stringify({ browser, driver }) + '\n', { flag: 'wx' });
}
const childArguments = ['tools/watchdog.py', '--timeout', '90', '--report', join(destination, 'resources.json'), '--', runtime, `benchmarks/${engine}-admission.mjs`, join(destination, 'sample.json')];
if (sampling) childArguments.push(String(launchIndex));
const child = spawn('python3', childArguments, { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
let output = '';
let diagnostics = '';
child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; });
child.stderr.setEncoding('utf8').on('data', chunk => { diagnostics += chunk; });
const exit = await new Promise(resolve => {
  child.on('error', error => resolve({ code: null, error: error.message }));
  child.on('close', (code, signal) => resolve({ code, signal }));
});
await writeFile(join(destination, 'stdout.txt'), output, { flag: 'wx' });
await writeFile(join(destination, 'stderr.txt'), diagnostics, { flag: 'wx' });
const result = { schemaVersion: 1, status: 'failed', exit, functionalAdmissionPassed: false, performanceAccepted: false };
try {
  assert.deepEqual(await readInputs(), inputs, 'Admission source changed during execution');
  assert.deepEqual(await dependencyManifest(dependencies), installedDependencies, 'Installed competitor dependency bytes changed during execution');
  for (const name of ['package.json', 'bun.lock']) {
    assert.equal(installedDependencies[name], inputs[`benchmarks/competitors/${engine}/${name}`], `Installed competitor ${name} differs from the checked-in pin`);
  }
  assert.equal(hash(await readFile(process.env.FLASHWRIGHT_BROWSER_PATH)), browserSha256, 'Browser bytes changed during execution');
  assert.equal(hash(await readFile(runtime)), runtimeSha256, 'JavaScript runtime bytes changed during execution');
  if (driverPath) assert.equal(hash(await readFile(driverPath)), driverSha256, 'Driver bytes changed during execution');
  result.inputsUnchanged = true;
  assert.equal(exit.code, 0);
  const readJson = async path => JSON.parse(await readFile(path, 'utf8'));
  // Report serialization and persistence happen after the measured child exits.
  if (sampling) await writeFile(join(destination, 'sample.json'), JSON.stringify(JSON.parse(output), null, 2) + '\n', { flag: 'wx' });
  const sample = await readJson(join(destination, 'sample.json'));
  assert.equal(sample.browser.sha256, browserSha256);
  assert.deepEqual(JSON.parse(output), sample, 'Completed output differs from retained report');
  if (driverPath) assert.equal(sample.driver.sha256, driverSha256);
  if (sampling) assert.equal(sample.sampling?.launchIndex, launchIndex);
  const verify = engine === 'puppeteer' ? (sampling ? verifyPuppeteerSample : verifyPuppeteerAdmission) : (sampling ? verifyWebdriverSample : verifyWebdriverAdmission);
  Object.assign(result, verify(sample, await readJson(join(destination, 'resources.json')), await readJson('benchmarks/configurations/baseline.json'), await readJson('benchmarks/configurations/competitors.json'), await readJson('crates/flashwright-browser/src/chromium-launch-policy.json'), engine === 'webdriverio' ? await readJson('benchmarks/configurations/webdriverio-launch-policy.json') : undefined), { status: sampling ? 'passed-sampling-outcomes' : 'passed-functional-admission' });
} catch (error) { result.error = error.stack; }
result.files = Object.fromEntries(await Promise.all((await readdir(destination)).sort().map(async name => [name, hash(await readFile(join(destination, name)))])));
await writeFile(join(destination, 'admission.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ destination, status: result.status, differences: result.differences, error: result.error }, null, 2));
process.exitCode = (sampling ? result.samplingOutcomesPassed : result.functionalAdmissionPassed) ? 0 : 1;
