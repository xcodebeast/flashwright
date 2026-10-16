import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, readFile, readdir, lstat, readlink, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { dependencyManifest, hash } from './competitor-inputs.mjs';
import { verifyCypressOutcomeAdmission } from '../benchmarks/cypress-contract.mjs';

assert.ok(['darwin', 'linux'].includes(process.platform), 'Cypress admission supports macOS and Linux');
const linux = process.platform === 'linux';
const bundleEntries = linux ? ['.'] : ['Contents'];
const bundleExecutable = linux ? 'Cypress' : 'Contents/MacOS/Cypress';
const launchPolicyPath = `benchmarks/configurations/cypress${linux ? '-linux' : ''}-launch-policy.json`;
assert.ok(process.argv[2], 'Usage: run-cypress-admission.mjs NEW_OUTPUT_DIRECTORY');
for (const name of ['FLASHWRIGHT_COMPETITOR_DIRECTORY', 'FLASHWRIGHT_CYPRESS_BUNDLE', 'FLASHWRIGHT_BROWSER_PATH']) assert.ok(process.env[name], `Set ${name}`);
const output = resolve(process.argv[2]);
await mkdir(output);
const dependencies = resolve(process.env.FLASHWRIGHT_COMPETITOR_DIRECTORY);
const bundle = resolve(process.env.FLASHWRIGHT_CYPRESS_BUNDLE);
const browserPath = linux ? await realpath(process.env.FLASHWRIGHT_BROWSER_PATH) : resolve(process.env.FLASHWRIGHT_BROWSER_PATH);
const runtime = process.env.FLASHWRIGHT_COMPETITOR_RUNTIME ?? process.execPath;
assert.ok(isAbsolute(runtime), 'Select an absolute JavaScript runtime executable');
const inputPaths = ['tools/run-cypress-admission.mjs', 'tools/competitor-inputs.mjs', 'tools/watchdog.py', 'tools/http-fixture.mjs', 'tools/browser-identity.mjs', 'tools/javascript-runtime.mjs', 'benchmarks/cypress-admission.mjs', 'benchmarks/cypress-contract.mjs', 'benchmarks/cypress/cypress.config.cjs', 'benchmarks/cypress/workloads.cy.js', 'benchmarks/fixture-server.mjs', 'benchmarks/configurations/baseline.json', 'benchmarks/configurations/competitors.json', 'benchmarks/competitors/cypress/package.json', 'benchmarks/competitors/cypress/bun.lock'];
inputPaths.push(launchPolicyPath);
const linuxFiles = ['linux-processes.cjs', 'linux-title-policy.cjs', 'linux-environment-policy.cjs', 'linux-launch-contract.mjs', 'linux-display.py'];
if (linux) inputPaths.push(...linuxFiles.map(name => `benchmarks/cypress/${name}`));
const python = execFileSync('python3', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' }).trim();
const describeDisplay = () => JSON.parse(execFileSync(python, ['benchmarks/cypress/linux-display.py', '--describe'], { encoding: 'utf8' }));
const sourceManifest = async () => Object.fromEntries(await Promise.all(inputPaths.map(async path => [path, hash(await readFile(path))])));
const inputs = {
  platform: process.platform, python: { executable: python, sha256: hash(await readFile(python)) },
  ...(linux ? { displayInputs: describeDisplay(), browserDistribution: await dependencyManifest(dirname(browserPath), ['.']) } : {}),
  sources: await sourceManifest(), installedDependencies: await dependencyManifest(dependencies), bundle: await dependencyManifest(bundle, bundleEntries),
  browserSha256: hash(await readFile(browserPath)), runtime: { executable: runtime, sha256: hash(await readFile(runtime)) },
};
await writeFile(join(output, 'inputs.json'), JSON.stringify(inputs, null, 2) + '\n', { flag: 'wx' });
const runnerCommand = [runtime, 'benchmarks/cypress-admission.mjs', join(output, 'sample.json')];
const command = linux ? [python, 'benchmarks/cypress/linux-display.py', output, ...runnerCommand] : runnerCommand;
const arguments_ = ['tools/watchdog.py', '--timeout', '180', '--report', join(output, 'resources.json'), '--', ...command];
const child = spawn(python, arguments_, { env: { ...process.env, CYPRESS_CACHE_FOLDER: dirname(dirname(bundle)), FLASHWRIGHT_BROWSER_PATH: browserPath }, stdio: ['ignore', 'pipe', 'pipe'] });
let stdout = '', stderr = '';
child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
const exit = await new Promise(resolve => { child.on('error', error => resolve({ code: null, error: error.message })); child.on('close', (code, signal) => resolve({ code, signal })); });
await writeFile(join(output, 'stdout.txt'), stdout, { flag: 'wx' });
await writeFile(join(output, 'stderr.txt'), stderr, { flag: 'wx' });
const receipt = { schemaVersion: 1, status: 'failed', exit, runnerOutcomeAdmissionPassed: false, equivalentOperationAdmissionPassed: false, performanceAccepted: false };
try {
  assert.equal(hash(await readFile(python)), inputs.python.sha256);
  if (linux) {
    assert.deepEqual(describeDisplay(), inputs.displayInputs);
    assert.deepEqual(await dependencyManifest(dirname(browserPath), ['.']), inputs.browserDistribution);
  }
  assert.deepEqual(await sourceManifest(), inputs.sources, 'Source changed during execution');
  assert.deepEqual(await dependencyManifest(dependencies), inputs.installedDependencies, 'Dependency bytes changed during execution');
  assert.deepEqual(await dependencyManifest(bundle, bundleEntries), inputs.bundle, 'Cypress bundle changed during execution');
  assert.equal(hash(await readFile(browserPath)), inputs.browserSha256);
  assert.equal(hash(await readFile(runtime)), inputs.runtime.sha256);
  for (const name of ['package.json', 'bun.lock']) assert.equal(inputs.installedDependencies[name], inputs.sources[`benchmarks/competitors/cypress/${name}`]);
  receipt.inputsUnchanged = true;
  assert.equal(exit.code, 0);
  const sampleBytes = await readFile(join(output, 'sample.json'));
  assert.deepEqual(stdout.split(/\r?\n/).filter(line => line.startsWith('flashwright-cypress-report ')), [`flashwright-cypress-report ${hash(sampleBytes)}`]);
  const report = JSON.parse(sampleBytes);
  assert.equal(report.browser.sha256, inputs.browserSha256);
  assert.equal(report.bundle.executableSha256, inputs.bundle[bundleExecutable]);
  assert.equal(report.package.lockSha256, inputs.installedDependencies['bun.lock']);
  for (const name of ['cypress.config.cjs', 'workloads.cy.js', ...(linux ? linuxFiles.filter(name => name.endsWith('.cjs')) : [])]) assert.equal(hash(await readFile(join(output, 'project', name))), inputs.sources[`benchmarks/cypress/${name}`]);
  const json = async path => JSON.parse(await readFile(path, 'utf8'));
  assert.deepEqual(await json(join(output, 'project/admission-configuration.json')), report.configuration);
  if (linux) {
    const display = await json(join(output, 'display.json'));
    assert.equal(display.displayExecutable, inputs.displayInputs.executable);
    assert.equal(display.displayExecutableSha256, inputs.displayInputs.files[display.displayExecutable]);
    const { verifyLinuxLaunch } = await import('../benchmarks/cypress/linux-launch-contract.mjs');
    verifyLinuxLaunch(report, display, output);
    receipt.browserRuntimeEnvironmentVerified = report.browserProcesses[0].environmentObservation.mode === 'proc-selected-environment';
    receipt.environmentEvidence = report.browserProcesses[0].environmentObservation.mode;
    receipt.environmentLimitation = 'For title-overwritten proc storage, only exact overwritten bytes and runner launch environment are verified. The relocated live libc browser environment is not observed.';
  }
  Object.assign(receipt, verifyCypressOutcomeAdmission(report, await json(join(output, 'resources.json')), await json('benchmarks/configurations/baseline.json'), await json('benchmarks/configurations/competitors.json'), await json(launchPolicyPath)), { status: 'passed-runner-outcome-admission' });
} catch (error) { receipt.error = error.stack; }
receipt.files = {};
receipt.symlinks = {};
receipt.specialFiles = {};
async function recordFiles(path = '') {
  for (const name of (await readdir(join(output, path))).sort()) {
    const relative = join(path, name);
    const entry = await lstat(join(output, relative));
    if (entry.isSymbolicLink()) receipt.symlinks[relative] = await readlink(join(output, relative));
    else if (entry.isDirectory()) await recordFiles(relative);
    else if (entry.isFile()) receipt.files[relative] = hash(await readFile(join(output, relative)));
    else receipt.specialFiles[relative] = { mode: entry.mode, bytes: entry.size };
  }
}
try { await recordFiles(); } catch (error) {
  receipt.status = 'failed'; receipt.runnerOutcomeAdmissionPassed = false;
  receipt.error = [receipt.error, error.stack].filter(Boolean).join('\n');
}
await writeFile(join(output, 'admission.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ output, status: receipt.status, differences: receipt.differences, error: receipt.error }, null, 2));
process.exitCode = receipt.runnerOutcomeAdmissionPassed ? 0 : 1;
