import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { reconstructFinalGoalLinuxCapturedOutputs, reconstructFinalGoalLinuxResourceEvidence,
  linuxCapturedOutputLimits } from './final-goal-linux-evidence.mjs';
import { finalGoalHash } from '../benchmarks/final-goal-contract.mjs';
import { verifyFinalGoalEvidence } from './verify-final-goal.mjs';

const fixture = JSON.parse(await readFile(new URL('../compatibility/evidence/fixtures/linux-cgroup-originals-synthetic.json', import.meta.url)));
const configuration = JSON.parse(await readFile(new URL('../benchmarks/configurations/final-goal-linux.json', import.meta.url)));
const temporaryRoot = fileURLToPath(new URL('../workbench/final-goal-linux-output-tests/', import.meta.url));
await mkdir(temporaryRoot, { recursive: true });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

function bundle(changeCapture = () => {}) {
  const files = new Map();
  const outputs = [Buffer.from('{"status":"failed","exitCode":7}\n'), Buffer.alloc(0), Buffer.from([0xff, 0, 0xfe])]
    .map((bytes, index) => {
      const path = `outputs/${index}.bin`; files.set(path, bytes);
      return { path, originalPath: `/synthetic/not-on-disk/output-${index}`, bytes: bytes.length, sha256: hash(bytes) };
    });
  const capture = JSON.parse(fixture.originals.capture);
  capture.requestedOutputs = outputs.map(row => row.originalPath);
  capture.capturedOutputs = outputs.map(row => ({ path: row.originalPath, resolvedPath: row.originalPath, bytes: row.bytes, sha256: row.sha256 }));
  changeCapture(capture);
  const resourceManifest = { schemaVersion: 1, accountingClass: fixture.header.accountingClass,
    files: Object.fromEntries(Object.entries(fixture.originals).map(([name, raw]) => {
      const bytes = Buffer.from(name === 'capture' ? JSON.stringify(capture) : raw), path = `originals/${name}.json`;
      files.set(path, bytes); return [name, { path, bytes: bytes.length, sha256: hash(bytes) }];
    })) };
  const manifest = { schemaVersion: 1, accountingClass: fixture.header.accountingClass,
    captureSha256: resourceManifest.files.capture.sha256, outputs };
  const reads = [];
  const reader = async (receipt, limits) => {
    assert(!receipt.path.startsWith('/'), 'Original paths must remain inert');
    reads.push(receipt.path);
    const bytes = files.get(receipt.path); assert(bytes);
    assert.equal(bytes.length, limits.expectedSize); assert(bytes.length <= limits.maximumFileBytes);
    return bytes;
  };
  return { resourceManifest, manifest, files, reader, reads };
}

test('original captured outputs bind every exact retained byte, including empty and non-UTF8 logs', async () => {
  const b = bundle();
  const result = await reconstructFinalGoalLinuxCapturedOutputs(b.resourceManifest, b.manifest, b.reader);
  assert.equal(result.status, 'verified-retained-captured-outputs');
  assert.equal(result.captureIdentity, fixture.expected.captureIdentity);
  assert.deepEqual(result.outputs, b.manifest.outputs);
  assert.equal(result.resourceAdmission, false); assert.equal(result.performanceAccepted, false);
  assert.equal(b.reads.length, 7);
  const resources = await reconstructFinalGoalLinuxResourceEvidence(b.resourceManifest, b.reader);
  assert.equal(resources.wrapperExitCode, 7, 'Failed workload outcome is not promoted');
  assert.equal(resources.nativeCleanObservedTeardown, false);
});

for (const [name, change] of [
  ['another capture', m => { m.captureSha256 = 'a'.repeat(64); }],
  ['wrong class', m => { m.accountingClass = 'atomic-wait4-original-owner'; }],
  ['missing inventory', m => { delete m.outputs; }],
  ['empty inventory', m => { m.outputs = []; }],
  ['too many outputs', m => { m.outputs = Array(linuxCapturedOutputLimits.maximumFiles + 1).fill(m.outputs[0]); }],
  ['per-file overflow', m => { m.outputs[0].bytes = linuxCapturedOutputLimits.maximumFileBytes + 1; }],
  ['aggregate overflow', m => { m.outputs = Array.from({ length: 5 }, (_, i) => ({ ...m.outputs[0], path: `outputs/${i}`, originalPath: `/synthetic/${i}`, bytes: linuxCapturedOutputLimits.maximumFileBytes })); }],
  ['boolean size', m => { m.outputs[0].bytes = true; }],
  ['negative size', m => { m.outputs[0].bytes = -1; }],
  ['invalid hash', m => { m.outputs[0].sha256 = 'bad'; }],
  ['absolute retained path', m => { m.outputs[0].path = '/outside/retained'; }],
  ['retained traversal', m => { m.outputs[0].path = '../outside'; }],
  ['duplicate retained path', m => { m.outputs[1].path = m.outputs[0].path; }],
  ['resource file alias', m => { m.outputs[0].path = 'originals/capture.json'; }],
  ['relative original path', m => { m.outputs[0].originalPath = 'relative'; }],
  ['original traversal', m => { m.outputs[0].originalPath = '/synthetic/../outside'; }],
  ['duplicate original path', m => { m.outputs[1].originalPath = m.outputs[0].originalPath; }],
]) test(`reject ${name} before reading any resource or payload`, async () => {
  const b = bundle(); change(b.manifest);
  await assert.rejects(() => reconstructFinalGoalLinuxCapturedOutputs(b.resourceManifest, b.manifest, b.reader));
  assert.deepEqual(b.reads, []);
});

for (const [name, change] of [
  ['omitted original output', m => { m.outputs.pop(); }],
  ['reordered outputs', m => { m.outputs.reverse(); }],
  ['changed outer digest', m => { m.outputs[0].sha256 = 'a'.repeat(64); }],
  ['changed outer size', m => { m.outputs[0].bytes++; }],
]) test(`reject ${name} before reading payloads`, async () => {
  const b = bundle(); change(b.manifest);
  await assert.rejects(() => reconstructFinalGoalLinuxCapturedOutputs(b.resourceManifest, b.manifest, b.reader), /original captured inventory/);
  assert(b.reads.every(path => path.startsWith('originals/')));
});

test('changed payload content and actual size cannot be hidden by matching manifest entries', async () => {
  const b = bundle();
  b.files.get('outputs/0.bin')[0] = 0;
  await assert.rejects(() => reconstructFinalGoalLinuxCapturedOutputs(b.resourceManifest, b.manifest, b.reader), /bytes changed/);
  const c = bundle();
  await assert.rejects(() => reconstructFinalGoalLinuxCapturedOutputs(c.resourceManifest, c.manifest, async (receipt, limits) =>
    receipt.path === 'outputs/1.bin' ? Buffer.from('nonempty') : c.reader(receipt, limits)), /size differs/);
});

for (const [name, change] of [
  ['missing requested outputs', c => { delete c.requestedOutputs; }],
  ['missing captured output', c => { c.capturedOutputs.pop(); }],
  ['original receipt order', c => { c.capturedOutputs.reverse(); }],
  ['original resolved alias', c => { c.capturedOutputs[1].resolvedPath = c.capturedOutputs[0].resolvedPath; }],
]) test(`strict bridge rejects ${name}`, async () => {
  const b = bundle(change);
  await assert.rejects(() => reconstructFinalGoalLinuxCapturedOutputs(b.resourceManifest, b.manifest, b.reader));
  assert(b.reads.every(path => path.startsWith('originals/')));
});

test('draft campaign verifies original output custody while preserving failed outcomes and closed admission', async () => {
  const directory = await mkdtemp(join(temporaryRoot, 'retained-'));
  try {
    const b = bundle();
    for (const child of ['outputs', 'originals']) await mkdir(join(directory, child));
    for (const [path, bytes] of b.files) await writeFile(join(directory, path), bytes);
    const save = async (path, value) => {
      const bytes = Buffer.from(JSON.stringify(value)); await writeFile(join(directory, path), bytes);
      return { path, sha256: hash(bytes) };
    };
    const resources = await reconstructFinalGoalLinuxResourceEvidence(b.resourceManifest, b.reader), report = { tests: [] };
    const evidence = [
      { ...await save('report.json', report), kind: 'report' }, { ...await save('resources.json', resources), kind: 'resources' },
      { ...await save('originals.json', b.resourceManifest), kind: 'linux-cgroup-originals' },
      { ...await save('captured-outputs.json', b.manifest), kind: 'linux-captured-outputs' },
    ];
    const campaign = { schemaVersion: 1, configuration: await save('configuration.json', configuration),
      declaration: await save('declaration.json', { status: 'draft', configurationSha256: finalGoalHash(configuration) }), scenarios: [] };
    for (const [i, scenario] of configuration.scenarios.entries()) {
      const result = { id: scenario.id, cells: configuration.cells.map((cell, slot) => i === 0 && slot === 0
        ? { id: cell.id, status: 'noncomparable', reason: 'Synthetic failed captured workload', attempts: [{ runs: { playwright: { report, resources, evidence } } }] }
        : { id: cell.id, status: 'unmeasured', attempts: [] }) };
      campaign.scenarios.push({ ...await save(`${scenario.id}.json`, result), scenarioId: scenario.id });
    }
    await save('campaign.json', campaign);
    const verified = await verifyFinalGoalEvidence(directory);
    assert.equal(verified.analysis.goalAccepted, false);
    assert.equal(verified.linuxResourceObservations[0].wrapperExitCode, 7);
    assert.equal(verified.linuxCapturedOutputs.length, 1);
    assert.deepEqual(verified.linuxCapturedOutputs[0].outputs, b.manifest.outputs);
    assert.equal(verified.checkedFiles['outputs/1.bin'], hash(Buffer.alloc(0)));
    assert.equal(verified.checkedFiles['outputs/2.bin'], hash(Buffer.from([0xff, 0, 0xfe])));
    await writeFile(join(directory, 'outputs/1.bin'), 'hidden replacement');
    await assert.rejects(() => verifyFinalGoalEvidence(directory), /size differs before read/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
