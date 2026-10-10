import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { dependencyManifest, hash } from './competitor-inputs.mjs';
import { verifyCypressOutcomeAdmission } from '../benchmarks/cypress-contract.mjs';

assert.equal(process.platform, 'darwin', 'This admission harness currently verifies a macOS Cypress.app bundle');
assert.ok(process.argv[2], 'Usage: run-cypress-admission.mjs NEW_OUTPUT_DIRECTORY');
for (const name of ['FLASHWRIGHT_COMPETITOR_DIRECTORY', 'FLASHWRIGHT_CYPRESS_BUNDLE', 'FLASHWRIGHT_BROWSER_PATH']) assert.ok(process.env[name], `Set ${name}`);
const output = resolve(process.argv[2]);
await mkdir(output);
const dependencies = resolve(process.env.FLASHWRIGHT_COMPETITOR_DIRECTORY);
const bundle = resolve(process.env.FLASHWRIGHT_CYPRESS_BUNDLE);
const browserPath = resolve(process.env.FLASHWRIGHT_BROWSER_PATH);
const runtime = process.env.FLASHWRIGHT_COMPETITOR_RUNTIME ?? process.execPath;
assert.ok(isAbsolute(runtime), 'Select an absolute JavaScript runtime executable');
const inputPaths = ['tools/run-cypress-admission.mjs', 'tools/competitor-inputs.mjs', 'tools/watchdog.py', 'tools/http-fixture.mjs', 'tools/browser-identity.mjs', 'tools/javascript-runtime.mjs', 'benchmarks/cypress-admission.mjs', 'benchmarks/cypress-contract.mjs', 'benchmarks/cypress/cypress.config.cjs', 'benchmarks/cypress/workloads.cy.js', 'benchmarks/fixture-server.mjs', 'benchmarks/configurations/baseline.json', 'benchmarks/configurations/competitors.json', 'benchmarks/competitors/cypress/package.json', 'benchmarks/competitors/cypress/bun.lock'];
inputPaths.push('benchmarks/configurations/cypress-launch-policy.json');
const sourceManifest = async () => Object.fromEntries(await Promise.all(inputPaths.map(async path => [path, hash(await readFile(path))])));
const inputs = {
  sources: await sourceManifest(), installedDependencies: await dependencyManifest(dependencies), bundle: await dependencyManifest(bundle, ['Contents']),
  browserSha256: hash(await readFile(browserPath)), runtime: { executable: runtime, sha256: hash(await readFile(runtime)) },
};
await writeFile(join(output, 'inputs.json'), JSON.stringify(inputs, null, 2) + '\n', { flag: 'wx' });
const arguments_ = ['tools/watchdog.py', '--timeout', '180', '--report', join(output, 'resources.json'), '--', runtime, 'benchmarks/cypress-admission.mjs', join(output, 'sample.json')];
const child = spawn('python3', arguments_, { env: { ...process.env, CYPRESS_CACHE_FOLDER: dirname(dirname(bundle)), FLASHWRIGHT_BROWSER_PATH: browserPath }, stdio: ['ignore', 'pipe', 'pipe'] });
let stdout = '', stderr = '';
child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
const exit = await new Promise(resolve => { child.on('error', error => resolve({ code: null, error: error.message })); child.on('close', (code, signal) => resolve({ code, signal })); });
await writeFile(join(output, 'stdout.txt'), stdout, { flag: 'wx' });
await writeFile(join(output, 'stderr.txt'), stderr, { flag: 'wx' });
const receipt = { schemaVersion: 1, status: 'failed', exit, runnerOutcomeAdmissionPassed: false, equivalentOperationAdmissionPassed: false, performanceAccepted: false };
try {
  assert.deepEqual(await sourceManifest(), inputs.sources, 'Source changed during execution');
  assert.deepEqual(await dependencyManifest(dependencies), inputs.installedDependencies, 'Dependency bytes changed during execution');
  assert.deepEqual(await dependencyManifest(bundle, ['Contents']), inputs.bundle, 'Cypress bundle changed during execution');
  assert.equal(hash(await readFile(browserPath)), inputs.browserSha256);
  assert.equal(hash(await readFile(runtime)), inputs.runtime.sha256);
  for (const name of ['package.json', 'bun.lock']) assert.equal(inputs.installedDependencies[name], inputs.sources[`benchmarks/competitors/cypress/${name}`]);
  receipt.inputsUnchanged = true;
  assert.equal(exit.code, 0);
  const sampleBytes = await readFile(join(output, 'sample.json'));
  assert.deepEqual(stdout.split(/\r?\n/).filter(line => line.startsWith('flashwright-cypress-report ')), [`flashwright-cypress-report ${hash(sampleBytes)}`]);
  const report = JSON.parse(sampleBytes);
  assert.equal(report.browser.sha256, inputs.browserSha256);
  assert.equal(report.bundle.executableSha256, inputs.bundle['Contents/MacOS/Cypress']);
  assert.equal(report.package.lockSha256, inputs.installedDependencies['bun.lock']);
  for (const name of ['cypress.config.cjs', 'workloads.cy.js']) assert.equal(hash(await readFile(join(output, 'project', name))), inputs.sources[`benchmarks/cypress/${name}`]);
  const json = async path => JSON.parse(await readFile(path, 'utf8'));
  assert.deepEqual(await json(join(output, 'project/admission-configuration.json')), report.configuration);
  Object.assign(receipt, verifyCypressOutcomeAdmission(report, await json(join(output, 'resources.json')), await json('benchmarks/configurations/baseline.json'), await json('benchmarks/configurations/competitors.json'), await json('benchmarks/configurations/cypress-launch-policy.json')), { status: 'passed-runner-outcome-admission' });
} catch (error) { receipt.error = error.stack; }
receipt.files = {};
async function recordFiles(path = '') {
  for (const name of (await readdir(join(output, path))).sort()) {
    const relative = join(path, name);
    if ((await stat(join(output, relative))).isDirectory()) await recordFiles(relative);
    else receipt.files[relative] = hash(await readFile(join(output, relative)));
  }
}
await recordFiles();
await writeFile(join(output, 'admission.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ output, status: receipt.status, differences: receipt.differences, error: receipt.error }, null, 2));
process.exitCode = receipt.runnerOutcomeAdmissionPassed ? 0 : 1;
