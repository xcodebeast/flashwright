import assert from 'node:assert/strict';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { isAbsolute, join, normalize } from 'node:path';
import { hash } from './competitor-inputs.mjs';
import { requireVerifiedBrowser } from './browser-identity.mjs';
import { reportRuntime } from './javascript-runtime.mjs';
import { sourceManifest } from './source-manifest.mjs';
import { broadEngines, broadLaunchOrder, normalizeBroadLaunch, renderBroadMatrixTable, summarizeBroadMatrix } from '../benchmarks/broad-matrix-contract.mjs';

const directory = process.argv[2];
assert.ok(directory, 'Usage: verify-broad-matrix.mjs RETAINED_DIRECTORY');
const read = async path => JSON.parse(await readFile(join(directory, path), 'utf8'));
function contained(path) {
  assert.ok(typeof path === 'string' && path && !isAbsolute(path) && normalize(path) === path && !path.split(/[\\/]/).includes('..'), `Expected a contained relative path: ${path}`);
  return path;
}
const metadata = await read('metadata.json');
const summary = await read('summary.json');
assert.equal(summary.schemaVersion, 1);
assert.equal(summary.complete, true);
assert.equal(summary.valid, true);
assert.equal(summary.performanceLeadershipEstablished, false);
for (const field of ['sourceChangedDuringTiming', 'binaryChangedDuringTiming', 'dependenciesChangedDuringTiming', 'bundleChangedDuringTiming']) assert.equal(summary[field], false);
assert.deepEqual(await sourceManifest(), metadata.sources, 'Verify from the recorded source checkout');
const retainedFiles = [];
async function inventory(path = '') {
  for (const name of (await readdir(join(directory, path))).sort()) {
    const relative = join(path, name);
    const information = await lstat(join(directory, relative));
    assert.equal(information.isSymbolicLink(), false, 'Retained evidence must contain original regular files');
    if (information.isDirectory()) await inventory(relative);
    else if (!['summary.json', 'table.md'].includes(relative)) retainedFiles.push(relative);
  }
}
await inventory();
assert.deepEqual(Object.keys(summary.retainedFileHashes).sort(), retainedFiles.sort(), 'Retained file set changed');
for (const [path, expected] of Object.entries(summary.retainedFileHashes)) assert.equal(hash(await readFile(join(directory, contained(path)))), expected, path);

const verification = await read('verification/report.json');
assert.equal(hash(await readFile(join(directory, 'verification/report.json'))), metadata.verificationSha256);
assert.equal(verification.status, 'passed');
assert.equal(verification.sourceChangedDuringVerification, false);
assert.deepEqual(verification.sources, metadata.sources);
assert.equal(verification.driverSha256, metadata.driverSha256);
assert.deepEqual(reportRuntime(verification), { name: metadata.measuredRuntime.name, version: metadata.measuredRuntime.version });
assert.deepEqual(verification.engineConfiguration, metadata.engineConfiguration);
assert.equal(metadata.engineConfiguration.conditionInstrumentation, false);
assert.equal(verification.platform, metadata.platform);
assert.equal(verification.architecture, metadata.architecture);
requireVerifiedBrowser(verification, metadata.browser);
assert.ok(verification.checks.length > 0);
for (const check of verification.checks) {
  assert.equal(check.code, 0);
  assert.equal(hash(await readFile(join(directory, 'verification', contained(check.log)))), check.logSha256);
}
const { configuration, contenders, policies } = metadata;
const sourceJson = async path => JSON.parse(await readFile(path, 'utf8'));
assert.deepEqual(configuration, await sourceJson('benchmarks/configurations/baseline.json'));
assert.deepEqual(contenders, await sourceJson('benchmarks/configurations/competitors.json'));
assert.deepEqual(policies.chromium, await sourceJson('crates/flashwright-browser/src/chromium-launch-policy.json'));
assert.deepEqual(policies.webdriverio, await sourceJson('benchmarks/configurations/webdriverio-launch-policy.json'));
assert.deepEqual(policies.cypress, await sourceJson('benchmarks/configurations/cypress-launch-policy.json'));
assert.deepEqual(metadata.plan.engines, broadEngines);
assert.equal(configuration.workers, 1);
assert.deepEqual(configuration.artifacts, { trace: 'off', video: 'off', screenshot: 'off' });
const expectedOrder = Array.from({ length: configuration.independentLaunches }, (_, launchIndex) => broadLaunchOrder(launchIndex).map(engine => ({ launchIndex, engine }))).flat();
assert.deepEqual(summary.attempts.map(({ launchIndex, engine, status }) => ({ launchIndex, engine, status })), expectedOrder.map(attempt => ({ ...attempt, status: 'passed' })));
assert.deepEqual((await read('progress.json')).attempts, summary.attempts);
const launches = Object.fromEntries(broadEngines.map(engine => [engine, []]));
const referenceObservations = {};
for (const { engine, launchIndex } of expectedOrder) {
  let report, receipt, resources;
  if (engine === 'playwright' || engine === 'flashwright') {
    report = await read(`launch-${launchIndex}-${engine}.json`);
    resources = await read(`resources-${launchIndex}-${engine}.json`);
    assert.deepEqual(report.engineConfiguration, metadata.engineConfiguration);
    assert.equal(report.protocolPhases, undefined);
    assert.deepEqual(resources.command, [metadata.measuredRuntime.executable, 'benchmarks/sample.mjs', String(launchIndex), engine]);
    referenceObservations[`${engine}-${launchIndex}`] = report.workloads.map(workload => ({ name: workload.name, observations: workload.observations }));
  } else {
    const root = `launch-${launchIndex}-${engine}`;
    report = await read(`${root}/sample.json`);
    receipt = await read(`${root}/admission.json`);
    resources = await read(`${root}/resources.json`);
    const inputs = await read(`${root}/inputs.json`);
    for (const [file, expected] of Object.entries(receipt.files)) assert.equal(hash(await readFile(join(directory, root, contained(file)))), expected, `${root}/${file}`);
    for (const [file, expected] of Object.entries(inputs.sources ?? inputs.inputs)) assert.equal(metadata.sources[contained(file)], expected, `Admission source changed: ${file}`);
    assert.deepEqual(inputs.installedDependencies, metadata.competitorDependencies[engine]);
    assert.equal(inputs.browserSha256, metadata.browser.sha256);
    assert.deepEqual(inputs.runtime, { executable: metadata.measuredRuntime.executable, sha256: metadata.measuredRuntime.sha256 });
    assert.deepEqual(reportRuntime(report), { name: metadata.measuredRuntime.name, version: metadata.measuredRuntime.version });
    assert.equal(report.browser.sha256, metadata.browser.sha256);
    assert.equal(resources.command[0], metadata.measuredRuntime.executable);
    assert.equal(resources.command[1], `benchmarks/${engine}-admission.mjs`);
    assert.equal(resources.command.length, 3);
    assert.ok(resources.command[2].endsWith(`/${root}/sample.json`));
    for (const file of ['package.json', 'bun.lock']) assert.equal(inputs.installedDependencies[file], metadata.sources[`benchmarks/competitors/${engine}/${file}`]);
    if (engine === 'webdriverio') {
      assert.equal(inputs.driverSha256, metadata.chromeDriverSha256);
      assert.equal(report.driver.sha256, metadata.chromeDriverSha256);
    }
    if (engine === 'cypress') {
      assert.deepEqual(inputs.bundle, metadata.cypressBundleFiles);
      assert.equal(report.bundle.executableSha256, metadata.cypressBundleFiles['Contents/MacOS/Cypress']);
    }
  }
  launches[engine].push(normalizeBroadLaunch({ engine, launchIndex, report, receipt, resources, configuration, contenders, policies, browserPath: metadata.browser.executablePath }));
}
for (let index = 0; index < configuration.independentLaunches; index++) assert.deepEqual(referenceObservations[`flashwright-${index}`], referenceObservations[`playwright-${index}`]);
const comparison = summarizeBroadMatrix(launches, configuration, contenders);
assert.deepEqual(summary.comparison, comparison);
assert.equal(await readFile(join(directory, 'table.md'), 'utf8'), renderBroadMatrixTable(comparison));
console.log(`Verified ${expectedOrder.length} launches, core evidence, original admission reports, resources, hashes, statistics and table. Broad performance leadership remains unproven.`);
