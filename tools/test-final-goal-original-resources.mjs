import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { adaptFinalGoalResources } from './final-goal-resource-adapter.mjs';
import { verifyFinalGoalOwnerTree } from './final-goal-owner-tree.mjs';
import { loadFinalGoalOwnerEvidence, reconstructFinalGoalResourceEvidence } from './final-goal-owner-evidence.mjs';

const { fixtures } = JSON.parse(await readFile(new URL('../compatibility/evidence/fixtures/original-owner-tree.json', import.meta.url), 'utf8'));
const hash = value => createHash('sha256').update(value).digest('hex');

/** Real normalized ownership records with explicitly invented admission metadata for adapter controls. */
function input(fixture = fixtures[0]) {
  const ownerTreeEvidence = structuredClone(fixture.evidence);
  const tree = verifyFinalGoalOwnerTree(ownerTreeEvidence);
  const plan = JSON.parse(ownerTreeEvidence.planBytes);
  const host = { identitySha256: hash('synthetic-host'), bootIdentitySha256: hash('synthetic-boot') };
  host.namespace = `${host.identitySha256}:${host.bootIdentitySha256}`;
  const lifecycle = { schemaVersion: 2,
    provenance: { sourceSha256: hash('synthetic-observer'), watchdogSha256: tree.provenance.rawInputs.fixed.watchdog.sha256,
      sourceManifestSha256: hash('synthetic-source-manifest'), dependencyManifestSha256: hash('synthetic-dependencies') },
    host, executables: {
      runtime: { path: tree.ownedProcesses.find(process => process.role === 'owner').executablePath, sha256: hash('synthetic-runtime') },
      browser: { path: plan.nativeBrowserExecutable, sha256: hash('synthetic-browser') },
      driver: { path: plan.driverExecutable, sha256: hash('synthetic-driver') },
      launcher: { path: plan.browserExecutable, sha256: hash('synthetic-launcher') },
    },
    capture: { engine: tree.provenance.engine, family: tree.provenance.family, workers: tree.provenance.workers,
      session: tree.provenance.session, ownerProcess: tree.provenance.ownerProcess,
      clockIdentity: tree.provenance.clockIdentity, inventorySha256: tree.provenance.inventorySha256 },
  };
  return { ownerTreeEvidence, lifecycle, collectorSha256: hash('synthetic-collector'),
    requiredResourceComponents: ['runner', 'workers', 'browser', 'driver', 'fixture-backend'] };
}

function inventory(evidence) {
  const bytesByPath = new Map();
  const files = {};
  function receipt(field, bytes, name) {
    const path = `raw/${field}/${name ?? 'record.json'}`;
    const buffer = Buffer.from(bytes);
    bytesByPath.set(path, buffer);
    return { path, sha256: hash(buffer), bytes: buffer.length, ...(name ? { name } : {}) };
  }
  for (const [field, value] of Object.entries(evidence)) files[field] = Array.isArray(value)
    ? value.map(file => receipt(field, file.bytes, file.name)) : receipt(field, value);
  const reads = [];
  const readBytes = async (entry, limits) => {
    reads.push({ path: entry.path, ...limits });
    const bytes = bytesByPath.get(entry.path);
    assert.equal(bytes.length, limits.expectedSize, 'Raw owner evidence size differs before read');
    assert(bytes.length <= limits.maximumFileBytes);
    return bytes;
  };
  return { manifest: { schemaVersion: 1, files }, bytesByPath, readBytes, reads };
}

for (const fixture of fixtures) test(`${fixture.engine}: original files produce complete CPU once and retain every RSS observation`, async () => {
  const options = input(fixture), before = structuredClone(options);
  const retained = inventory(options.ownerTreeEvidence);
  const derived = await reconstructFinalGoalResourceEvidence(retained.manifest, options, retained.readBytes);
  const raw = JSON.parse(options.ownerTreeEvidence.watchdogReportBytes);
  assert.equal(derived.originalOwnerInclusiveCpuSeconds, fixture.expected.originalOwnerInclusiveCpuSeconds);
  assert.equal(derived.sampledConcurrentBytes, fixture.expected.maximumSampledConcurrentRssBytes);
  assert.equal(derived.ownedProcesses.length, fixture.expected.processes);
  assert.equal(derived.originalAttempts.length, 15);
  assert(derived.originalAttempts.every(attempt => attempt.status === 'passed'));
  assert.equal(derived.originalRunnerExitCode, 0);
  assert.equal(derived.workerIntervals.length, 1);
  assert.equal(derived.samples.length, raw.samples.length);
  assert.deepEqual(derived.samples.map(sample => sample.processes.map(process => process.residentBytes)),
    raw.samples.map(sample => sample.processes.map(process => process.rssBytes)));
  assert(derived.coverage.sampledBoundaryObservations.length > 0);
  assert.deepEqual(derived.coverage.missingRequiredComponents, []);
  assert.equal(derived.observedProcessTreeCpuSeconds, undefined);
  assert.equal(derived.sampledProcessCpuSeconds, undefined);
  assert.equal(derived.originalOwnerCpu.process, options.lifecycle.capture.ownerProcess);
  assert.equal(derived.originalOwnerCpu.cpuSeconds, derived.originalOwnerCpu.userSeconds + derived.originalOwnerCpu.systemSeconds);
  assert.deepEqual(options, before);
});

test('changing sampled and descendant-inclusive CPU cannot change the admitted owner total', () => {
  const options = input();
  const before = adaptFinalGoalResources(options);
  const raw = JSON.parse(options.ownerTreeEvidence.watchdogReportBytes);
  for (const sample of raw.samples) for (const process of sample.processes) process.cpuSeconds = 100000;
  options.ownerTreeEvidence.watchdogReportBytes = JSON.stringify(raw);
  for (const file of options.ownerTreeEvidence.nativeCaptures.filter(file => file.name.endsWith('.jsonl'))) {
    const events = file.bytes.trimEnd().split('\n').map(JSON.parse);
    for (const event of events.filter(event => event.event === 'native-child-reaped')) event.inclusiveUserMicroseconds += 100000000;
    file.bytes = events.map(event => JSON.stringify(event)).join('\n') + '\n';
    const complete = options.ownerTreeEvidence.nativeCaptures.find(candidate => candidate.name === file.name.replace('.jsonl', '.complete.json'));
    const value = JSON.parse(complete.bytes); value.retainedBytes = Buffer.byteLength(file.bytes); complete.bytes = JSON.stringify(value);
  }
  const changed = verifyFinalGoalOwnerTree(options.ownerTreeEvidence);
  options.lifecycle.provenance.watchdogSha256 = changed.provenance.rawInputs.fixed.watchdog.sha256;
  options.lifecycle.capture.inventorySha256 = changed.provenance.inventorySha256;
  const after = adaptFinalGoalResources(options);
  assert.equal(after.originalOwnerInclusiveCpuSeconds, before.originalOwnerInclusiveCpuSeconds);
  assert.equal(after.sampledConcurrentBytes, before.sampledConcurrentBytes);
});

test('controlled ownership cannot manufacture application, database or mail component coverage', () => {
  const options = input();
  options.requiredResourceComponents.push('application-server', 'database', 'mail');
  assert.deepEqual(adaptFinalGoalResources(options).coverage.missingRequiredComponents, ['application-server', 'database', 'mail']);
  options.lifecycle.events = [{ type: 'process-owned', components: ['database', 'mail'] }];
  assert.throws(() => adaptFinalGoalResources(options));
});

for (const [description, mutate] of [
  ['engine', value => value.capture.engine = 'playwright'],
  ['family', value => value.capture.family = 'application-todomvc'],
  ['workers', value => value.capture.workers = 4],
  ['session', value => value.capture.session = '0'.repeat(32)],
  ['owner', value => value.capture.ownerProcess++],
  ['clock', value => value.capture.clockIdentity = '0'.repeat(32)],
  ['inventory', value => value.capture.inventorySha256 = '0'.repeat(64)],
  ['watchdog', value => value.provenance.watchdogSha256 = '0'.repeat(64)],
  ['runtime path', value => value.executables.runtime.path = '/different/runtime'],
  ['browser path', value => value.executables.browser.path = '/different/browser'],
  ['driver path', value => value.executables.driver.path = '/different/driver'],
  ['launcher path', value => value.executables.launcher.path = '/different/launcher'],
  ['boot namespace', value => value.host.bootIdentitySha256 = hash('different boot')],
  ['missing boot', value => delete value.host.bootIdentitySha256],
]) test(`reject mismatched original ${description} binding`, () => {
  const options = input(); mutate(options.lifecycle); assert.throws(() => adaptFinalGoalResources(options));
});

for (const [description, mutate] of [
  ['unknown input', manifest => manifest.files.summary = {}],
  ['missing input', manifest => delete manifest.files.ownerReportBytes],
  ['too many journals', manifest => manifest.files.processJournals = Array(65).fill(manifest.files.processJournals[0])],
  ['duplicate filename', manifest => manifest.files.processJournals[1].name = manifest.files.processJournals[0].name],
  ['unsafe filename', manifest => manifest.files.processJournals[0].name = '../escape.jsonl'],
  ['borrowed path', manifest => manifest.files.ownerReportBytes.path = manifest.files.watchdogReportBytes.path],
  ['parent traversal', manifest => manifest.files.ownerReportBytes.path = '../outside.json'],
  ['absolute path', manifest => manifest.files.ownerReportBytes.path = '/outside.json'],
  ['oversized fixed file', manifest => manifest.files.ownerReportBytes.bytes = 1024 ** 2 + 1],
  ['oversized inventory file', manifest => manifest.files.nativeCaptures[0].bytes = 8 * 1024 ** 2 + 1],
  ['aggregate overflow', manifest => {
    manifest.files.processJournals = Array.from({ length: 9 }, (_, index) => ({ name: `record-${index}.jsonl`,
      path: `raw/record-${index}.jsonl`, bytes: 16 * 1024 ** 2, sha256: '0'.repeat(64) }));
  }],
]) test(`reject ${description} before reading any owner evidence`, async () => {
  const retained = inventory(input().ownerTreeEvidence); mutate(retained.manifest);
  await assert.rejects(loadFinalGoalOwnerEvidence(retained.manifest, retained.readBytes));
  assert.equal(retained.reads.length, 0);
});

test('changed retained bytes and understated file sizes cannot enter reconstruction', async () => {
  for (const changeSize of [false, true]) {
    const retained = inventory(input().ownerTreeEvidence), receipt = retained.manifest.files.ownerReportBytes;
    if (changeSize) receipt.bytes--;
    else receipt.sha256 = '0'.repeat(64);
    await assert.rejects(loadFinalGoalOwnerEvidence(retained.manifest, retained.readBytes), /bytes changed|size differs/);
  }
});

test('forged output and bindings cannot replace a missing original guardian wait', async () => {
  const options = input();
  options.originalOwnerInclusiveCpuSeconds = 0;
  options.ownerTreeEvidence.guardianReaps = [];
  const retained = inventory(options.ownerTreeEvidence);
  await assert.rejects(reconstructFinalGoalResourceEvidence(retained.manifest, options, retained.readBytes));
});
