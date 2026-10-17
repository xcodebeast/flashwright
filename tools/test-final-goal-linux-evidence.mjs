import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { linuxResourceEvidenceLimits, loadFinalGoalLinuxEvidence, reconstructFinalGoalLinuxResourceEvidence } from './final-goal-linux-evidence.mjs';
import { reconstructFinalGoalResourceEvidence } from './final-goal-owner-evidence.mjs';
import { finalGoalHash } from '../benchmarks/final-goal-contract.mjs';
import { verifyFinalGoalEvidence } from './verify-final-goal.mjs';

const fixture = JSON.parse(await readFile(new URL('../compatibility/evidence/fixtures/linux-cgroup-originals-synthetic.json', import.meta.url), 'utf8'));
const configuration = JSON.parse(await readFile(new URL('../benchmarks/configurations/final-goal-linux.json', import.meta.url), 'utf8'));
const temporaryRoot = fileURLToPath(new URL('../workbench/final-goal-linux-evidence-tests/', import.meta.url));
await mkdir(temporaryRoot, { recursive: true });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function input() {
  return { schemaVersion: 1, accountingClass: fixture.header.accountingClass,
    files: Object.fromEntries(Object.entries(fixture.header.files).map(([name, receipt]) => [name, { ...receipt, path: `originals/${name}.json` }])) };
}
const reader = async (receipt, limits) => {
  const name = Object.keys(fixture.originals).find(name => receipt.path === `originals/${name}.json`);
  assert(name);
  assert.equal(limits.maximumFileBytes, linuxResourceEvidenceLimits.files[name]);
  assert.equal(limits.expectedSize, receipt.bytes);
  return Buffer.from(fixture.originals[name]);
};

test('bounded portable originals reconstruct the unchanged Linux diagnostic class through the shared interface', async () => {
  const manifest = input();
  const result = await reconstructFinalGoalResourceEvidence(manifest, {}, reader);
  assert.deepEqual(result, fixture.expected);
  assert.equal(result.cgroupCpu.usageMicroseconds, '12');
  assert.equal(result.originalCollectorWait.userSeconds, 50);
  assert.equal(result.wrapperExitCode, 7);
  assert.equal(result.adoptedChildren, 1);
  assert.equal(result.observedDrainedMembership, true);
  assert.equal(result.nativeCleanObservedTeardown, false);
  assert.equal(result.resourceAdmission, false);
  assert.equal(result.performanceAccepted, false);
  assert.equal(result.sampledConcurrentBytes, undefined);
  assert.equal(result.originalOwnerInclusiveCpuSeconds, undefined);
  assert.deepEqual(manifest, input());
});

test('Linux and macOS adapter options cannot be mixed', async () => {
  await assert.rejects(() => reconstructFinalGoalResourceEvidence(input(), { lifecycle: {} }, reader), /macOS owner adaptation/);
});

for (const [name, change] of [
  ['missing file', m => { delete m.files.native; }],
  ['extra file', m => { m.files.extra = m.files.native; }],
  ['wrong accounting class', m => { m.accountingClass = 'atomic-wait4-original-owner'; }],
  ['missing accounting class', m => { delete m.accountingClass; }],
  ['extra manifest property', m => { m.verified = true; }],
  ['borrowed path', m => { m.files.before.path = m.files.after.path; }],
  ['absolute path', m => { m.files.native.path = '/synthetic/native.json'; }],
  ['parent traversal', m => { m.files.native.path = '../native.json'; }],
  ['path normalization', m => { m.files.native.path = 'originals/./native.json'; }],
  ['backslash path', m => { m.files.native.path = 'originals\\native.json'; }],
  ['NUL path', m => { m.files.native.path = 'originals/\0native.json'; }],
  ['invalid hash', m => { m.files.native.sha256 = 'missing'; }],
  ['boolean byte count', m => { m.files.native.bytes = true; }],
  ['empty byte count', m => { m.files.native.bytes = 0; }],
  ['per-file overflow', m => { m.files.native.bytes = linuxResourceEvidenceLimits.files.native + 1; }],
  ['aggregate overflow', m => { for (const [name, receipt] of Object.entries(m.files)) receipt.bytes = linuxResourceEvidenceLimits.files[name]; }],
]) test(`reject ${name} before any member read`, async () => {
  const manifest = input(); change(manifest);
  let reads = 0;
  await assert.rejects(() => loadFinalGoalLinuxEvidence(manifest, async () => { reads++; throw new Error('Early read'); }));
  assert.equal(reads, 0);
});

test('changed bytes and actual file sizes cannot be hidden by declared limits', async () => {
  await assert.rejects(() => loadFinalGoalLinuxEvidence(input(), async (receipt, limits) => {
    const bytes = await reader(receipt, limits); bytes[0] = 0; return bytes;
  }), /bytes changed/);
  await assert.rejects(() => loadFinalGoalLinuxEvidence(input(), async (receipt, limits) =>
    (await reader(receipt, limits)).subarray(1)), /size differs/);
});

test('updated outer hash does not conceal a changed original native receipt', async () => {
  const manifest = input();
  const changed = Buffer.from(fixture.originals.native.replace('usage_usec 12', 'usage_usec 99'));
  manifest.files.native = { ...manifest.files.native, bytes: changed.length, sha256: hash(changed) };
  await assert.rejects(() => reconstructFinalGoalLinuxResourceEvidence(manifest,
    (receipt, limits) => receipt.path.endsWith('/native.json') ? Promise.resolve(changed) : reader(receipt, limits)));
});

test('duplicate JSON keys in original bytes are rejected by the shared strict parser', async () => {
  const manifest = input(), bytes = Buffer.from('{"status":"captured","status":"captured"}');
  manifest.files.capture = { ...manifest.files.capture, bytes: bytes.length, sha256: hash(bytes) };
  await assert.rejects(() => reconstructFinalGoalLinuxResourceEvidence(manifest,
    (receipt, limits) => receipt.path.endsWith('/capture.json') ? Promise.resolve(bytes) : reader(receipt, limits)));
});

async function retain(directory, mutate = () => {}) {
  await mkdir(join(directory, 'originals'));
  const save = async (path, value) => {
    const bytes = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
    await writeFile(join(directory, path), bytes);
    return { path, sha256: hash(bytes) };
  };
  for (const [name, raw] of Object.entries(fixture.originals)) await save(`originals/${name}.json`, raw);
  const resources = structuredClone(fixture.expected);
  mutate(resources);
  const report = { tests: [] };
  const evidence = [
    { ...await save('report.json', report), kind: 'report' },
    { ...await save('resources.json', resources), kind: 'resources' },
    { ...await save('linux-originals.json', input()), kind: 'linux-cgroup-originals' },
  ];
  const campaign = { schemaVersion: 1, configuration: await save('configuration.json', configuration),
    declaration: await save('declaration.json', { status: 'draft', configurationSha256: finalGoalHash(configuration) }), scenarios: [] };
  for (const [index, scenario] of configuration.scenarios.entries()) {
    const result = { id: scenario.id, cells: configuration.cells.map((cell, slot) => index === 0 && slot === 0
      ? { id: cell.id, status: 'noncomparable', reason: 'Synthetic local observations only; final admission absent',
        attempts: [{ runs: { playwright: { report, resources, evidence } } }] }
      : { id: cell.id, status: 'unmeasured', attempts: [] }) };
    campaign.scenarios.push({ ...await save(`${scenario.id}.json`, result), scenarioId: scenario.id });
  }
  await save('campaign.json', campaign);
}

test('unsealed retained campaign reconstructs declared originals without admitting them', async () => {
  const directory = await mkdtemp(join(temporaryRoot, 'retained-'));
  try {
    await retain(directory);
    const verified = await verifyFinalGoalEvidence(directory);
    assert.equal(verified.analysis.goalAccepted, false);
    assert.equal(verified.analysis.evidenceComplete, false);
    assert.equal(verified.analysis.declaredScenarioCount, 9);
    assert.equal(verified.checkedFiles['originals/native.json'], fixture.header.files.native.sha256);
    await writeFile(join(directory, 'originals/native.json'), '{}');
    await assert.rejects(() => verifyFinalGoalEvidence(directory), /size differs before read/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('matching summary receipts cannot bypass original Linux reconstruction', async () => {
  const directory = await mkdtemp(join(temporaryRoot, 'forged-'));
  try {
    await retain(directory, resources => { resources.cgroupCpu.usageMicroseconds = '0'; });
    await assert.rejects(() => verifyFinalGoalEvidence(directory), /Linux observations differ/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
