import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join, normalize } from 'node:path';
import { hash } from './competitor-inputs.mjs';
import { verifyCypressOutcomeAdmission } from '../benchmarks/cypress-contract.mjs';

const directory = process.argv[2];
assert.ok(directory, 'Usage: verify-cypress-snapshot.mjs SNAPSHOT_DIRECTORY');
const readJson = async path => JSON.parse(await readFile(path, 'utf8'));
function containedPath(path) {
  assert.ok(!isAbsolute(path) && normalize(path) === path && !path.split(/[\\/]/).includes('..'), `Expected a contained relative path: ${path}`);
  return path;
}
const baseline = await readJson('benchmarks/configurations/baseline.json');
const competitors = await readJson('benchmarks/configurations/competitors.json');
const launchPolicy = await readJson('benchmarks/configurations/cypress-launch-policy.json');
const manifest = await readJson(join(directory, 'manifest.json'));
assert.equal(manifest.performanceAccepted, false);
const results = [];
for (const item of manifest.cases) {
  const path = join(directory, containedPath(item.directory));
  for (const [file, expected] of Object.entries(item.exportedFileSha256)) assert.equal(hash(await readFile(join(path, containedPath(file)))), expected, `${item.name}/${file}`);
  const receipt = await readJson(join(path, 'admission.json'));
  for (const [file, expected] of Object.entries(receipt.files)) assert.equal(hash(await readFile(join(path, containedPath(file)))), expected, `${item.name}/${file}`);
  assert.equal(receipt.inputsUnchanged, true);
  assert.equal(receipt.status, 'passed-runner-outcome-admission');
  const inputs = await readJson(join(path, 'inputs.json'));
  for (const [file, expected] of Object.entries(inputs.sources)) assert.equal(hash(await readFile(containedPath(file))), expected, `Current source differs: ${file}`);
  const sample = await readJson(join(path, 'sample.json'));
  for (const name of ['package.json', 'bun.lock']) assert.equal(inputs.installedDependencies[name], inputs.sources[`benchmarks/competitors/cypress/${name}`]);
  assert.equal(sample.package.lockSha256, inputs.installedDependencies['bun.lock']);
  assert.equal(sample.package.manifestSha256, inputs.installedDependencies['node_modules/cypress/package.json']);
  assert.equal(sample.bundle.executableSha256, inputs.bundle['Contents/MacOS/Cypress']);
  assert.equal(sample.browser.sha256, inputs.browserSha256);
  for (const name of ['cypress.config.cjs', 'workloads.cy.js']) assert.equal(hash(await readFile(join(path, 'project', name))), inputs.sources[`benchmarks/cypress/${name}`]);
  assert.deepEqual(await readJson(join(path, 'project/admission-configuration.json')), sample.configuration);
  assert.deepEqual(await readJson(join(path, 'launch.json')), sample.launch);
  assert.deepEqual(await readJson(join(path, 'browser-processes.json')), sample.browserProcesses);
  const observations = (await readFile(join(path, 'observations.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(observations, sample.observations);
  const stdout = await readFile(join(path, 'stdout.txt'), 'utf8');
  assert.deepEqual(stdout.split(/\r?\n/).filter(line => line.startsWith('flashwright-cypress-report ')), [`flashwright-cypress-report ${item.originalFileSha256['sample.json']}`]);
  const result = verifyCypressOutcomeAdmission(sample, await readJson(join(path, 'resources.json')), baseline, competitors, launchPolicy);
  for (const [key, value] of Object.entries(result)) assert.deepEqual(receipt[key], value);
  results.push({ name: item.name, tests: sample.result.totalTests, expectedFailures: result.expectedFailures, unexpectedFailures: result.unexpectedFailures });
}
assert.ok(results.length > 0);
for (const item of manifest.failedAttempts) {
  const path = join(directory, containedPath(item.directory));
  for (const [file, expected] of Object.entries(item.exportedFileSha256)) assert.equal(hash(await readFile(join(path, containedPath(file)))), expected, `${item.name}/${file}`);
  const receipt = await readJson(join(path, 'admission.json'));
  assert.equal(receipt.status, 'failed');
  assert.equal(receipt.runnerOutcomeAdmissionPassed, false);
  const sample = await readJson(join(path, 'sample.json'));
  const resources = await readJson(join(path, 'resources.json'));
  assert.throws(() => verifyCypressOutcomeAdmission(sample, resources, baseline, competitors, launchPolicy));
}
console.log(JSON.stringify({ status: 'passed-current-source-cypress-snapshot-verification', performanceAccepted: false, cases: results }, null, 2));
