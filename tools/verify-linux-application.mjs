import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { applicationCorpusDirectory, applicationGeneratedSources, loadApplicationCorpus } from '../benchmarks/application-corpus.mjs';
import { applicationConfiguration, applicationResults, verifyApplicationOutcomes } from '../benchmarks/application-suite-contract.mjs';
import { hash } from './competitor-inputs.mjs';

assert.equal(process.platform, 'linux');
assert.equal(process.argv.length, 3, 'Usage: bun tools/verify-linux-application.mjs CAPTURE_DIRECTORY');
const directory = resolve(process.argv[2]);
const read = async path => JSON.parse(await readFile(path, 'utf8'));
const preparedPath = join(directory, 'prepared.json');
const prepared = await read(preparedPath);
assert(['todomvc', 'svgomg'].includes(prepared.application));
assert(['playwright', 'flashwright'].includes(prepared.engine));
assert.equal(prepared.workers, 1);
assert.equal(prepared.workspaceDirectory, resolve('.'));
assert.equal(prepared.directory, directory);
assert.equal(prepared.project, join(directory, 'project'));
const capturePath = join(directory, 'capture', 'capture.json');
const { stdout } = await promisify(execFile)('/usr/bin/python3', ['-B', resolve('tools/linux_cgroup_resources.py'), capturePath],
  { maxBuffer: 32 * 1024 ** 2, timeout: 30000 });
const resources = JSON.parse(stdout);
assert.equal(resources.status, 'verified-local-observations');
assert.equal(resources.accountingClass, 'linux-cgroup-v2-charged-scope-v1');
assert.equal(resources.resourceAdmission, false);
assert.equal(resources.performanceAccepted, false);
const capture = await read(capturePath);
assert.equal(hash(await readFile(capturePath)), resources.originalFiles.capture.sha256);
assert.deepEqual(capture.workloadCommand, prepared.ownerCommand);
assert.deepEqual(capture.wrapperCommand.slice(-prepared.ownerCommand.length), prepared.ownerCommand);
const before = await read(join(directory, 'capture', 'before.json'));
assert.equal(hash(await readFile(join(directory, 'capture', 'before.json'))), resources.originalFiles.before.sha256);
assert.equal(hash(await readFile(preparedPath)), before.inputs.files.find(file => file.path === preparedPath)?.sha256);
// The input reader already bound both the selected path and its resolved file
// at each boundary. Preserve a declared symlink rather than calling it a mismatch.
assert.equal(before.inputs.executables.browser.path, prepared.browser.executablePath);
assert.equal(before.inputs.executables.driver.path, prepared.driverPath);
assert.deepEqual(prepared.ownerCommand, [before.inputs.executables.runtime.path,
  resolve('benchmarks/linux-application-owner.mjs'), directory]);
const require = createRequire(import.meta.url);
const cli = prepared.engine === 'flashwright' ? resolve('packages/flashwright-test/cli.cjs')
  : join(dirname(require.resolve('playwright/package.json')), 'cli.js');
assert.deepEqual(prepared.runnerCommand, [before.inputs.executables.runtime.path, cli, 'test', '--config',
  join(prepared.project, 'runner.config.mjs')]);

const expectedOutputs = [join(directory, 'owner-report.json'), join(prepared.project, 'report.json'),
  join(directory, 'runner-stdout.txt'), join(directory, 'runner-stderr.txt')];
assert.deepEqual(capture.requestedOutputs, expectedOutputs);
assert.deepEqual(capture.capturedOutputs.map(file => file.path), expectedOutputs);
for (const file of capture.capturedOutputs) {
  const bytes = await readFile(file.path);
  assert.equal(bytes.length, file.bytes);
  assert.equal(hash(bytes), file.sha256, 'Original workload output changed after capture');
}
const owner = await read(expectedOutputs[0]);
const runner = await read(expectedOutputs[1]);
assert.equal(owner.status, 'completed-owner');
assert.equal(owner.application, prepared.application);
assert.equal(owner.engine, prepared.engine);
assert.equal(owner.workers, 1);
assert.deepEqual(owner.failures, []);
assert.equal(owner.serviceClosed, true);
assert.deepEqual(owner.runnerCommand, prepared.runnerCommand);
assert.deepEqual(owner.runnerExit, { code: 0, signal: null });
assert.equal(resources.wrapperExitCode, 0);
assert.equal(resources.observedDrainedMembership, true, resources.drainRejectionReasons.join('; '));
assert.equal(owner.clock.captureIdentity, resources.captureIdentity);
assert.equal(owner.clock.domain, 'linux-clock-monotonic');
assert.equal(owner.clock.originNanoseconds, resources.workloadClock.originNanoseconds);
assert.equal(owner.clock.implementation, resources.clock);
assert.deepEqual(owner.events.map(event => event.name), ['fixture-start-requested', 'fixture-listening', 'runner-spawn-requested',
  'runner-closed', 'runner-streams-retained', 'reporter-output-readable', 'fixture-close-requested', 'fixture-closed',
  'owner-report-write-requested']);
let previous = BigInt(resources.commandInterval.startedNanoseconds);
for (const event of owner.events) {
  const now = BigInt(event.nanoseconds);
  assert(now >= previous && now <= BigInt(resources.commandInterval.finishedNanoseconds));
  previous = now;
}
const corpus = await loadApplicationCorpus(applicationCorpusDirectory(prepared.application));
assert.equal(corpus.manifestSha256, prepared.corpusManifestSha256);
const generated = applicationGeneratedSources(corpus, join(prepared.project, 'adapter.mjs'));
assert.deepEqual(prepared.generatedSources, generated.map(source => source.record));
const guard = prepared.engine === 'flashwright' ? `import { forbidUpstreamBrowserBackend } from ${JSON.stringify(pathToFileURL(resolve('benchmarks/native-backend-guard.mjs')).href)}; forbidUpstreamBrowserBackend();\n` : '';
const expectedFiles = {
  'adapter.mjs': `${guard}export {test,expect,defineConfig} from ${JSON.stringify(import.meta.resolve(prepared.engine === 'flashwright' ? '@flashwright/test' : '@playwright/test'))};\n`,
  'runner.config.mjs': `import {defineConfig} from './adapter.mjs';export default defineConfig(${JSON.stringify(applicationConfiguration(prepared.project, prepared.browser))});\n`,
  ...Object.fromEntries(generated.map(source => [source.record.path, source.contents])),
};
assert.deepEqual(prepared.generatedHashes, Object.fromEntries(Object.entries(expectedFiles).map(([name, contents]) => [name, hash(contents)])));
for (const [name, contents] of Object.entries(expectedFiles)) {
  const path = join(prepared.project, name);
  assert.equal(await readFile(path, 'utf8'), contents);
  assert.equal(before.inputs.files.find(file => file.path === path)?.sha256, hash(contents));
}
const run = { command: prepared.runnerCommand, exit: owner.runnerExit, configuration: prepared.configuration,
  requests: owner.requests, generatedSources: prepared.generatedSources, tests: applicationResults(runner), errors: runner.errors };
const outcome = verifyApplicationOutcomes({ run, report: runner, corpus, project: prepared.project,
  browser: prepared.browser, command: prepared.runnerCommand });
assert.equal(outcome.passed, true);
const result = { schemaVersion: 1, status: 'verified-linux-application-capture', application: prepared.application,
  engine: prepared.engine, workers: 1, tests: outcome.tests.length, completeCorpusExecuted: outcome.completeCorpusExecuted,
  observedDrainedMembership: resources.observedDrainedMembership, nativeCleanObservedTeardown: resources.nativeCleanObservedTeardown,
  adoptedChildren: resources.adoptedChildren, cgroupCpu: resources.cgroupCpu,
  cgroupChargedPeakBytes: resources.cgroupChargedPeakBytes, commandInterval: resources.commandInterval,
  captureSha256: resources.originalFiles.capture.sha256, originalOutputs: capture.capturedOutputs,
  resourceAdmission: false, performanceAccepted: false,
  scope: 'Complete owner, original source bodies and runner-reported test identities/results, fixture HTTP work and retained output hashes. This is not callback dispatch attestation, final launch-policy admission or a paired performance result.' };
await writeFile(join(directory, 'resource-observations.json'), JSON.stringify(resources, null, 2) + '\n', { flag: 'wx' });
await writeFile(join(directory, 'application-verification.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ application: result.application, engine: result.engine, tests: result.tests,
  status: result.status, adoptedChildren: result.adoptedChildren, resourceAdmission: false, performanceAccepted: false }));
