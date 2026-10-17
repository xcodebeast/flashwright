import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { applicationGeneratedSources } from '../benchmarks/application-corpus.mjs';
import { applicationResults, verifyApplicationOutcomes } from '../benchmarks/application-suite-contract.mjs';
import { finalGoalAccountingClasses } from '../benchmarks/final-goal-resource-policy.mjs';
import { linuxCapturedOutputLimits, reconstructFinalGoalLinuxCapturedOutputs, reconstructFinalGoalLinuxResourceEvidence } from './final-goal-linux-evidence.mjs';
import { decodeLinuxApplicationJson } from './final-goal-linux-json.mjs';
import { verifyLinuxApplicationDispatch } from './final-goal-linux-dispatch.mjs';
export { decodeLinuxApplicationJson } from './final-goal-linux-json.mjs';

export const linuxApplicationEvidenceLimits = Object.freeze({ maximumFiles: 64,
  maximumFileBytes: 4 * 1024 ** 2, maximumAggregateBytes: 16 * 1024 ** 2 });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const absolute = path => typeof path === 'string' && path.length > 0 && path.length <= 4096
  && !path.includes('\0') && !path.includes('\\') && posix.isAbsolute(path) && posix.normalize(path) === path;
const relative = path => typeof path === 'string' && path.length > 0 && path.length <= 4096
  && !path.includes('\0') && !path.includes('\\') && !posix.isAbsolute(path) && posix.normalize(path) === path
  && !path.split('/').some(part => ['', '.', '..'].includes(part));

function validateManifest(manifest, resourceManifest, outputManifest) {
  assert.deepEqual(Object.keys(manifest ?? {}).sort(), ['accountingClass', 'captureSha256',
    ...(Object.hasOwn(manifest ?? {}, 'dispatch') ? ['dispatch'] : []), 'generated', 'prepared', 'schemaVersion']);
  if (Object.hasOwn(manifest, 'dispatch')) {
    assert.deepEqual(Object.keys(manifest.dispatch ?? {}), ['observerOriginalPath']);
    assert(absolute(manifest.dispatch.observerOriginalPath), 'Invalid original dispatch observer path');
  }
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.accountingClass, finalGoalAccountingClasses.linux);
  assert.equal(manifest.captureSha256, resourceManifest.files?.capture?.sha256, 'Application manifest borrows another capture');
  assert.equal(manifest.captureSha256, outputManifest.captureSha256);
  assert(Array.isArray(manifest.generated) && manifest.generated.length > 0
    && manifest.generated.length < linuxApplicationEvidenceLimits.maximumFiles, 'Application input count limit exceeded');
  assert.deepEqual(Object.keys(resourceManifest.files ?? {}).sort(), ['after', 'before', 'capture', 'native']);
  assert(Array.isArray(outputManifest.outputs) && outputManifest.outputs.length > 0
    && outputManifest.outputs.length <= linuxCapturedOutputLimits.maximumFiles, 'Captured output inventory limit exceeded');
  if (manifest.dispatch) assert(Number.isSafeInteger(outputManifest.outputs[4]?.bytes) && outputManifest.outputs[4].bytes > 0
    && outputManifest.outputs[4].bytes <= linuxApplicationEvidenceLimits.maximumFileBytes, 'Dispatch report byte limit exceeded');
  const paths = new Set([...Object.values(resourceManifest.files), ...outputManifest.outputs].map(r => r.path));
  const originals = new Set(); let total = 0;
  for (const receipt of [manifest.prepared, ...manifest.generated]) {
    assert.deepEqual(Object.keys(receipt ?? {}).sort(), ['bytes', 'originalPath', 'path', 'sha256']);
    assert(relative(receipt.path) && !paths.has(receipt.path), 'Application retained path must be unique and contained');
    assert(absolute(receipt.originalPath) && !originals.has(receipt.originalPath), 'Invalid or reused application original path');
    assert(Number.isSafeInteger(receipt.bytes) && receipt.bytes > 0
      && receipt.bytes <= linuxApplicationEvidenceLimits.maximumFileBytes, 'Application input byte limit exceeded');
    assert.match(receipt.sha256 ?? '', /^[a-f0-9]{64}$/);
    paths.add(receipt.path); originals.add(receipt.originalPath); total += receipt.bytes;
  }
  assert(total <= linuxApplicationEvidenceLimits.maximumAggregateBytes, 'Application input aggregate limit exceeded');
}

function time(value) {
  assert(typeof value === 'string' && /^(0|[1-9][0-9]{0,29})$/.test(value), 'Invalid owner timestamp');
  return BigInt(value);
}

/** Verify reported application work from retained bytes; never open original paths. */
export async function reconstructFinalGoalLinuxApplication({ resourceManifest, outputManifest, manifest, readBytes,
  corpus, application, engine, workers }) {
  assert(['todomvc', 'svgomg'].includes(application));
  assert(['playwright', 'flashwright'].includes(engine) && [1, 4].includes(workers));
  validateManifest(manifest, resourceManifest, outputManifest);
  const retained = new Map();
  const needed = new Set([resourceManifest.files.capture.path, resourceManifest.files.before.path,
    ...outputManifest.outputs.slice(0, 2).map(r => r.path),
    ...(manifest.dispatch ? outputManifest.outputs.slice(4, 5).map(r => r.path) : [])]);
  const reader = async (receipt, limits) => {
    const bytes = await readBytes(receipt, limits);
    if (needed.has(receipt.path)) retained.set(receipt.path, bytes);
    return bytes;
  };
  const outputs = await reconstructFinalGoalLinuxCapturedOutputs(resourceManifest, outputManifest, reader);
  const resources = await reconstructFinalGoalLinuxResourceEvidence(resourceManifest, reader);
  // These exact records already passed the strict Python parser and original
  // resource reconstruction. The potentially large before inventory is bounded
  // by the resource loader, independently of the smaller application records.
  const capture = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(retained.get(resourceManifest.files.capture.path)));
  const before = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(retained.get(resourceManifest.files.before.path)));
  assert(Array.isArray(before.inputs.files) && before.inputs.files.length <= 65536, 'Captured input inventory limit exceeded');
  const inputs = new Map();
  for (const receipt of before.inputs.files) {
    assert(absolute(receipt.path) && !inputs.has(receipt.path), 'Duplicate or invalid captured input path');
    inputs.set(receipt.path, receipt);
  }
  const hasCapturedSource = path => {
    assert(absolute(path), 'Invalid original command source path');
    const aliases = before.inputs.files.filter(receipt => receipt.path === path || receipt.resolvedPath === path);
    assert(aliases.length > 0, 'Original command source is not captured');
    for (const receipt of aliases) {
      assert.match(receipt.sha256 ?? '', /^[a-f0-9]{64}$/);
      assert(Number.isSafeInteger(receipt.bytes) && receipt.bytes > 0);
      assert.equal(receipt.sha256, aliases[0].sha256, 'Captured command aliases disagree');
      assert.equal(receipt.bytes, aliases[0].bytes, 'Captured command aliases disagree');
    }
  };
  // Bind the complete selected inventory before asking for any of its payloads.
  for (const receipt of [manifest.prepared, ...manifest.generated]) {
    const original = inputs.get(receipt.originalPath);
    assert(original && original.sha256 === receipt.sha256 && original.bytes === receipt.bytes, 'Application input differs from original capture');
  }
  const readInput = async receipt => {
    const bytes = await readBytes(receipt, { maximumFileBytes: linuxApplicationEvidenceLimits.maximumFileBytes, expectedSize: receipt.bytes });
    assert(Buffer.isBuffer(bytes) && bytes.length === receipt.bytes && hash(bytes) === receipt.sha256, 'Retained application input bytes changed');
    return bytes;
  };
  const prepared = decodeLinuxApplicationJson(await readInput(manifest.prepared));
  assert.equal(prepared.schemaVersion, 1);
  assert.equal(prepared.application, application); assert.equal(prepared.engine, engine); assert.equal(prepared.workers, workers);
  assert(absolute(prepared.workspaceDirectory) && absolute(prepared.directory));
  assert.equal(prepared.project, posix.join(prepared.directory, 'project'));
  assert.equal(manifest.prepared.originalPath, posix.join(prepared.directory, 'prepared.json'));
  assert.equal(prepared.corpusManifestSha256, corpus.manifestSha256, 'Captured corpus differs from pinned corpus');
  assert.deepEqual(prepared.ownerCommand, capture.workloadCommand);
  assert.equal(prepared.ownerCommand.length, 3);
  assert.equal(prepared.ownerCommand[0], before.inputs.executables.runtime.path);
  assert.equal(prepared.ownerCommand[2], prepared.directory);
  hasCapturedSource(prepared.ownerCommand[1]);
  assert.equal(prepared.browser.executablePath, before.inputs.executables.browser.path);
  assert.equal(prepared.browser.sha256, before.inputs.executables.browser.sha256);
  assert.equal(prepared.driverPath, before.inputs.executables.driver.path);
  assert(Array.isArray(prepared.runnerCommand) && prepared.runnerCommand.length === 5);
  assert.equal(prepared.runnerCommand[0], prepared.ownerCommand[0]);
  hasCapturedSource(prepared.runnerCommand[1]);
  assert.deepEqual(prepared.runnerCommand.slice(2), ['test', '--config', posix.join(prepared.project, 'runner.config.mjs')]);

  const generated = applicationGeneratedSources(corpus, posix.join(prepared.project, 'adapter.mjs'));
  assert.deepEqual(prepared.generatedSources, generated.map(source => source.record), 'Generated upstream source declarations differ');
  const names = ['adapter.mjs', 'runner.config.mjs', ...generated.map(source => source.record.path)].sort();
  assert.deepEqual(Object.keys(prepared.generatedHashes).sort(), names);
  assert.deepEqual(manifest.generated.map(r => r.originalPath).sort(), names.map(name => posix.join(prepared.project, name)).sort(), 'Incomplete generated source inventory');
  const expected = new Map(generated.map(source => [posix.join(prepared.project, source.record.path), Buffer.from(source.contents)]));
  for (const receipt of manifest.generated) {
    const name = posix.relative(prepared.project, receipt.originalPath);
    assert.equal(receipt.sha256, prepared.generatedHashes[name]);
    const bytes = await readInput(receipt);
    if (expected.has(receipt.originalPath)) assert.deepEqual(bytes, expected.get(receipt.originalPath), 'Original test or fixture source changed');
  }
  const expectedOutputs = ['owner-report.json', 'project/report.json', 'runner-stdout.txt', 'runner-stderr.txt', 'dispatch-report.json']
    .map(name => posix.join(prepared.directory, name));
  assert.deepEqual(outputs.outputs.map(r => r.originalPath), expectedOutputs, 'Unexpected application output roles or order');
  const owner = decodeLinuxApplicationJson(retained.get(outputManifest.outputs[0].path));
  const runner = decodeLinuxApplicationJson(retained.get(outputManifest.outputs[1].path));
  assert.equal(owner.application, application); assert.equal(owner.engine, engine); assert.equal(owner.workers, workers);
  assert.equal(owner.serviceClosed, true);
  assert(Array.isArray(owner.failures));
  assert.equal(owner.status, owner.failures.length ? 'failed' : 'completed-owner');
  assert.deepEqual(owner.runnerCommand, prepared.runnerCommand);
  assert.equal(owner.clock.captureIdentity, resources.captureIdentity);
  assert.equal(owner.clock.domain, 'linux-clock-monotonic');
  assert.equal(owner.clock.originNanoseconds, resources.workloadClock.originNanoseconds);
  assert.equal(owner.clock.implementation, resources.clock);
  assert.deepEqual(owner.events.map(e => e.name), ['fixture-start-requested', 'fixture-listening', 'runner-spawn-requested',
    'runner-closed', 'runner-streams-retained', ...(owner.runnerExit.code === 0 ? ['reporter-output-readable'] : []),
    'fixture-close-requested', 'fixture-closed', 'owner-report-write-requested']);
  let previous = time(resources.commandInterval.startedNanoseconds);
  const finished = time(resources.commandInterval.finishedNanoseconds);
  for (const event of owner.events) {
    const now = time(event.nanoseconds); assert(now >= previous && now <= finished, 'Owner event escapes original capture interval'); previous = now;
  }
  const run = { command: prepared.runnerCommand, exit: owner.runnerExit, configuration: prepared.configuration,
    requests: owner.requests, generatedSources: prepared.generatedSources, tests: applicationResults(runner), errors: runner.errors };
  const outcome = verifyApplicationOutcomes({ run, report: runner, corpus, project: prepared.project,
    browser: prepared.browser, command: prepared.runnerCommand, workers });
  assert.equal(resources.wrapperExitCode, owner.runnerExit.code, 'Original terminal outcome differs from reported workload');
  assert.equal(owner.failures.length === 0, outcome.passed, 'Owner failure diagnostics disagree with workload outcome');
  let dispatch;
  if (manifest.dispatch) {
    assert(outcome.passed, 'Dispatch journal admission currently supports passing corpora only');
    dispatch = verifyLinuxApplicationDispatch({ bytes: retained.get(outputManifest.outputs[4].path), prepared,
      preparedSha256: manifest.prepared.sha256, owner, reporter: runner, before, resources,
      observerOriginalPath: manifest.dispatch.observerOriginalPath });
  }
  return { schemaVersion: 1, status: 'verified-retained-linux-application-outcomes', accountingClass: finalGoalAccountingClasses.linux,
    captureIdentity: resources.captureIdentity, captureSha256: manifest.captureSha256, application, engine, workers,
    tests: outcome.tests, completeCorpusExecuted: outcome.completeCorpusExecuted, passed: outcome.passed,
    generatedSourceCount: generated.length, corpusManifestSha256: corpus.manifestSha256,
    observedDrainedMembership: resources.observedDrainedMembership, nativeCleanObservedTeardown: resources.nativeCleanObservedTeardown,
    resourceAdmission: false, performanceAccepted: false, callbackDispatchVerified: false,
    ...(dispatch ? { dispatch } : {}),
    scope: 'Captured input/output integrity, exact generated upstream test/fixture sources, reported outcomes, fixture requests and owner timeline. Adapter/config/owner/runner source admission, actual callback dispatch, native context/process custody and final policy admission remain separate.' };
}
