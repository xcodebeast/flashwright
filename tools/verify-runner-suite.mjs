import assert from 'node:assert/strict';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { isAbsolute, join, normalize } from 'node:path';
import { dependencyManifest, hash } from './competitor-inputs.mjs';
import { sourceManifest } from './source-manifest.mjs';
import { renderRunnerSuiteAdmission, verifyRunnerSuite } from '../benchmarks/runner-suite-contract.mjs';
import { verifyRunnerFailureDiagnostics } from '../benchmarks/runner-suite-diagnostics.mjs';

const directory = process.argv[2];
assert.ok(directory && process.argv.length === 3, 'Usage: verify-runner-suite.mjs RETAINED_DIRECTORY');
const read = async path => JSON.parse(await readFile(join(directory, path), 'utf8'));
function contained(path) {
  assert.ok(path && !isAbsolute(path) && normalize(path) === path && !path.split(/[\\/]/).includes('..'));
  return path;
}
const inputs = await read('inputs.json');
const launchInputs = await read('launch-inputs.json');
const receipt = await read('admission.json');
const report = await read('sample.json');
const resources = await read('resources.json');
assert.equal(receipt.status, 'passed-runner-outcomes');
assert.equal(receipt.inputsUnchanged, true);
assert.deepEqual(receipt.exit, { code: 0, signal: null });
assert.deepEqual(await sourceManifest(), inputs.sources, 'Verify from the recorded source checkout');
assert.deepEqual(await dependencyManifest('.'), inputs.dependencies, 'Installed package bytes differ from the recorded runner');
for (const [path, expected] of [[inputs.driverPath, inputs.driverSha256], [inputs.runtime.executable, inputs.runtime.sha256], [inputs.browser.executablePath, inputs.browser.sha256]]) assert.equal(hash(await readFile(path)), expected, path);
const files = [];
async function inventory(path = '') {
  for (const name of (await readdir(join(directory, path))).sort()) {
    const relative = join(path, name);
    const information = await lstat(join(directory, relative));
    assert.equal(information.isSymbolicLink(), false);
    if (information.isDirectory()) await inventory(relative);
    else if (relative !== 'admission.json') files.push(relative);
  }
}
await inventory();
assert.deepEqual(Object.keys(receipt.files).sort(), files.sort());
for (const [path, expected] of Object.entries(receipt.files)) assert.equal(hash(await readFile(join(directory, contained(path)))), expected, path);
assert.deepEqual(Object.keys(inputs.generatedFiles).sort(), ['project/workloads.spec.mjs', 'project/adapter.mjs', 'project/runner.config.mjs', 'project/suite-configuration.json', 'launch-inputs.json'].sort());
for (const [path, expected] of Object.entries(inputs.generatedFiles)) assert.equal(receipt.files[contained(path)], expected, `Generated input changed: ${path}`);
assert.equal(inputs.generatedFiles['project/workloads.spec.mjs'], inputs.sources['benchmarks/runner-suite/workloads.spec.mjs'], 'Both engines must execute the preserved common test body');
assert.deepEqual(report, JSON.parse(await readFile(join(directory, 'stdout.txt'), 'utf8')));
assert.deepEqual(report.runner, await read('runner-report.json'));
assert.deepEqual(report.browser, inputs.browser);
assert.deepEqual(launchInputs.browser, inputs.browser);
assert.equal(report.driverSha256, inputs.driverSha256);
assert.equal(launchInputs.driverSha256, inputs.driverSha256);
assert.equal(launchInputs.driverPath, inputs.driverPath);
assert.equal(launchInputs.engine, report.engine);
assert.equal(launchInputs.launchIndex, report.launchIndex);
assert.equal(resources.command.length, 3);
assert.equal(resources.command[0], inputs.runtime.executable);
assert.equal(resources.command[1], 'benchmarks/runner-suite-sample.mjs');
assert.ok(isAbsolute(resources.command[2]));
assert.deepEqual(launchInputs.runnerCommand.slice(1), ['test', '--config', join(resources.command[2], 'project/runner.config.mjs')]);
assert.ok(launchInputs.runnerCommand[0].endsWith(report.engine === 'playwright' ? '/playwright/cli.js' : '/packages/flashwright-test/cli.cjs'));
assert.equal(report.runner.config.configFile, launchInputs.runnerCommand[3]);
assert.equal(inputs.runnerConfiguration.outputDir, join(resources.command[2], 'test-output'));
assert.deepEqual(inputs.runnerConfiguration.use, { headless: true, viewport: report.configuration.viewport,
  launchOptions: { executablePath: report.browser.executablePath }, trace: 'off', video: 'off', screenshot: 'off', actionTimeout: 5000, navigationTimeout: 10000 });
assert.deepEqual((await read('project/suite-configuration.json')), { configuration: report.configuration, launchIndex: report.launchIndex });
const configuration = JSON.parse(await readFile('benchmarks/configurations/runner-suite.json', 'utf8'));
assert.deepEqual(launchInputs.configuration, configuration);
const policy = JSON.parse(await readFile('crates/flashwright-browser/src/chromium-launch-policy.json', 'utf8'));
const decision = {
  ...verifyRunnerSuite(report, resources, configuration, policy),
  diagnosticAdmission: await verifyRunnerFailureDiagnostics(report, directory),
};
for (const [key, value] of Object.entries(decision)) assert.deepEqual(receipt[key], value, `Changed runner decision: ${key}`);
assert.equal(await readFile(join(directory, 'table.md'), 'utf8'), renderRunnerSuiteAdmission(report, decision));
console.log(`Verified ${report.engine} runner outcomes, preserved test bodies, original predicate diagnostics, raw reports, launch flags and resource cleanup. ${decision.actualRunnerFailures} intentional actual failures; no performance acceptance.`);
