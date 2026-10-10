import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { identifyBrowser } from './browser-identity.mjs';
import { dependencyManifest, hash } from './competitor-inputs.mjs';
import { sourceManifest } from './source-manifest.mjs';
import { renderRunnerSuiteAdmission, verifyRunnerSuite } from '../benchmarks/runner-suite-contract.mjs';
import { verifyRunnerFailureDiagnostics } from '../benchmarks/runner-suite-diagnostics.mjs';

assert.ok(process.argv[2], 'Usage: run-runner-suite.mjs NEW_OUTPUT_DIRECTORY playwright|flashwright [LAUNCH_INDEX]');
const directory = resolve(process.argv[2]);
const engine = process.argv[3];
const launchIndex = Number(process.argv[4] ?? 0);
assert.ok(['playwright', 'flashwright'].includes(engine) && process.argv.length <= 5);
const configuration = JSON.parse(await readFile('benchmarks/configurations/runner-suite.json', 'utf8'));
assert.ok(Number.isInteger(launchIndex) && launchIndex >= 0 && launchIndex < configuration.independentLaunches);
for (const name of ['FLASHWRIGHT_BROWSER_PATH', 'FLASHWRIGHT_DRIVER_PATH']) assert.ok(process.env[name], `Set ${name}`);
const runtime = process.env.FLASHWRIGHT_RUNNER_RUNTIME ?? process.execPath;
assert.ok(isAbsolute(runtime));
const driverPath = resolve(process.env.FLASHWRIGHT_DRIVER_PATH);
const browser = await identifyBrowser(process.env.FLASHWRIGHT_BROWSER_PATH);
assert.equal(browser.version, configuration.browserVersion);
const sources = await sourceManifest();
const dependencies = await dependencyManifest('.');
const driverSha256 = hash(await readFile(driverPath));
const runtimeSha256 = hash(await readFile(runtime));
await mkdir(directory);
const project = join(directory, 'project');
await mkdir(project);
await copyFile('benchmarks/runner-suite/workloads.spec.mjs', join(project, 'workloads.spec.mjs'));
await writeFile(join(project, 'suite-configuration.json'), JSON.stringify({ configuration, launchIndex }) + '\n', { flag: 'wx' });
const packageName = engine === 'playwright' ? '@playwright/test' : '@flashwright/test';
const guard = engine === 'flashwright'
  ? `import { forbidUpstreamBrowserBackend } from ${JSON.stringify(pathToFileURL(resolve('benchmarks/native-backend-guard.mjs')).href)};\nforbidUpstreamBrowserBackend();\n` : '';
await writeFile(join(project, 'adapter.mjs'), `${guard}export { test, expect, defineConfig } from ${JSON.stringify(import.meta.resolve(packageName))};\nexport const nativeBackendGuardActive = ${engine === 'flashwright'};\n`, { flag: 'wx' });
const runnerConfiguration = {
  testDir: '.', testMatch: 'workloads.spec.mjs', workers: 1, retries: 0, repeatEach: 1, fullyParallel: false,
  maxFailures: 0, forbidOnly: true, timeout: 30000, expect: { timeout: 5000 },
  outputDir: join(directory, 'test-output'), reporter: [['json', { outputFile: join(directory, 'runner-report.json') }]],
  use: { headless: true, viewport: configuration.viewport, launchOptions: { executablePath: browser.executablePath },
    trace: 'off', video: 'off', screenshot: 'off', actionTimeout: 5000, navigationTimeout: 10000 },
};
await writeFile(join(project, 'runner.config.mjs'), `import { defineConfig } from './adapter.mjs';\nconst configuration = ${JSON.stringify(runnerConfiguration)};\nconfiguration.use.baseURL = process.env.FLASHWRIGHT_TEST_BASE_URL;\nexport default defineConfig(configuration);\n`, { flag: 'wx' });
const require = createRequire(import.meta.url);
const executable = engine === 'playwright' ? join(dirname(require.resolve('playwright/package.json')), 'cli.js') : resolve('packages/flashwright-test/cli.cjs');
const runnerCommand = [executable, 'test', '--config', join(project, 'runner.config.mjs')];
await writeFile(join(directory, 'launch-inputs.json'), JSON.stringify({ configuration, engine, launchIndex, browser, driverPath, driverSha256, runnerCommand }) + '\n', { flag: 'wx' });
const generatedPaths = ['project/workloads.spec.mjs', 'project/adapter.mjs', 'project/runner.config.mjs', 'project/suite-configuration.json', 'launch-inputs.json'];
const generatedFiles = Object.fromEntries(await Promise.all(generatedPaths.map(async path => [path, hash(await readFile(join(directory, path)))])));
const inputs = { sources, dependencies, browser, driverPath, driverSha256, runtime: { executable: runtime, sha256: runtimeSha256 }, runnerConfiguration, generatedFiles };
await writeFile(join(directory, 'inputs.json'), JSON.stringify(inputs, null, 2) + '\n', { flag: 'wx' });
const child = spawn('python3', ['tools/watchdog.py', '--timeout', '240', '--report', join(directory, 'resources.json'), '--', runtime, 'benchmarks/runner-suite-sample.mjs', directory], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
let stdout = '', stderr = '';
child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
const exit = await new Promise(resolve => { child.on('error', error => resolve({ code: null, error: error.message })); child.on('close', (code, signal) => resolve({ code, signal })); });
await writeFile(join(directory, 'stdout.txt'), stdout, { flag: 'wx' });
await writeFile(join(directory, 'stderr.txt'), stderr, { flag: 'wx' });
const receipt = { status: 'failed', exit, runnerOutcomeAdmissionPassed: false, performanceAccepted: false };
try {
  const report = JSON.parse(stdout);
  await writeFile(join(directory, 'sample.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  assert.deepEqual(await sourceManifest(), sources, 'Source changed during runner verification');
  assert.deepEqual(await dependencyManifest('.'), dependencies, 'Installed package bytes changed during runner verification');
  assert.equal(hash(await readFile(driverPath)), driverSha256);
  assert.equal(hash(await readFile(browser.executablePath)), browser.sha256);
  assert.equal(hash(await readFile(runtime)), runtimeSha256);
  for (const [path, expected] of Object.entries(generatedFiles)) assert.equal(hash(await readFile(join(directory, path))), expected, `Generated runner input changed: ${path}`);
  assert.equal(exit.code, 0);
  receipt.inputsUnchanged = true;
  const resources = JSON.parse(await readFile(join(directory, 'resources.json'), 'utf8'));
  const policy = JSON.parse(await readFile('crates/flashwright-browser/src/chromium-launch-policy.json', 'utf8'));
  const outcomes = verifyRunnerSuite(report, resources, configuration, policy);
  const diagnosticAdmission = await verifyRunnerFailureDiagnostics(report, directory);
  Object.assign(receipt, outcomes, { diagnosticAdmission, status: 'passed-runner-outcomes' });
  await writeFile(join(directory, 'table.md'), renderRunnerSuiteAdmission(report, receipt), { flag: 'wx' });
} catch (error) { receipt.error = error.stack ?? String(error); }
receipt.files = {};
async function record(path = '') {
  for (const name of (await readdir(join(directory, path))).sort()) {
    const relative = join(path, name);
    if ((await stat(join(directory, relative))).isDirectory()) await record(relative);
    else receipt.files[relative] = hash(await readFile(join(directory, relative)));
  }
}
await record();
await writeFile(join(directory, 'admission.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ directory, status: receipt.status, expectedRunnerFailures: receipt.expectedRunnerFailures, workerCount: receipt.workerCount, error: receipt.error }, null, 2));
process.exitCode = receipt.runnerOutcomeAdmissionPassed ? 0 : 1;
