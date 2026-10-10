import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join, normalize } from 'node:path';
import { verifyPuppeteerAdmission, verifyWebdriverAdmission } from '../benchmarks/competitor-contract.mjs';

const directory = process.argv[2];
assert.ok(directory, 'Usage: verify-competitor-snapshot.mjs SNAPSHOT_DIRECTORY');
const readJson = async path => JSON.parse(await readFile(path, 'utf8'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function relativePath(path) {
  assert.ok(!isAbsolute(path) && normalize(path) === path && !path.split(/[\\/]/).includes('..'), `Expected a contained relative path: ${path}`);
  return path;
}
const baseline = await readJson('benchmarks/configurations/baseline.json');
const competitors = await readJson('benchmarks/configurations/competitors.json');
const launchPolicy = await readJson('crates/flashwright-browser/src/chromium-launch-policy.json');
const driverPolicy = await readJson('benchmarks/configurations/webdriverio-launch-policy.json');
const manifest = await readJson(join(directory, 'manifest.json'));
const results = [];
for (const item of manifest.cases) {
  const path = join(directory, relativePath(item.directory));
  for (const [file, expected] of Object.entries(item.exportedFileSha256)) assert.equal(hash(await readFile(join(path, relativePath(file)))), expected, `${item.name}/${file}`);
  const receipt = await readJson(join(path, 'admission.json'));
  for (const [file, expected] of Object.entries(receipt.files)) assert.equal(hash(await readFile(join(path, relativePath(file)))), expected, `${item.name}/${file}`);
  const inputs = await readJson(join(path, 'inputs.json'));
  for (const [file, expected] of Object.entries(inputs.inputs)) assert.equal(hash(await readFile(relativePath(file))), expected, `Current source differs: ${file}`);
  const sample = await readJson(join(path, 'sample.json'));
  assert.ok(['puppeteer', 'webdriverio'].includes(sample.engine));
  for (const name of ['package.json', 'bun.lock']) assert.equal(inputs.installedDependencies[name], inputs.inputs[`benchmarks/competitors/${sample.engine}/${name}`]);
  assert.equal(sample.package.lockSha256, inputs.installedDependencies['bun.lock']);
  assert.equal(sample.package.manifestSha256, inputs.installedDependencies[`node_modules/${sample.package.name}/package.json`]);
  assert.equal(sample.browser.sha256, inputs.browserSha256);
  if (sample.engine === 'webdriverio') assert.equal(sample.driver.sha256, inputs.driverSha256);
  assert.deepEqual(await readJson(join(path, 'stdout.txt')), sample);
  assert.equal(receipt.inputsUnchanged, true);
  assert.equal(receipt.performanceAccepted, false);
  const verify = sample.engine === 'puppeteer' ? verifyPuppeteerAdmission : verifyWebdriverAdmission;
  const result = verify(sample, await readJson(join(path, 'resources.json')), baseline, competitors, launchPolicy, driverPolicy);
  assert.equal(receipt.status, 'passed-functional-admission');
  assert.equal(receipt.functionalAdmissionPassed, result.functionalAdmissionPassed);
  assert.deepEqual(receipt.differences, result.differences);
  assert.deepEqual(receipt.outcomeMatchedWorkloads, result.outcomeMatchedWorkloads);
  assert.equal(receipt.launchPolicyEquivalent, result.launchPolicyEquivalent);
  results.push({ name: item.name, engine: sample.engine, iterations: sample.workloads.reduce((sum, workload) => sum + workload.samples.length + workload.warmupSamples.length, 0) });
}
assert.ok(results.length > 0);
console.log(JSON.stringify({ status: 'passed-current-source-snapshot-verification', performanceAccepted: false, cases: results }, null, 2));
