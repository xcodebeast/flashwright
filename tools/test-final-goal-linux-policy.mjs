import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { analyzeFinalGoal, finalGoalHash, verifyFinalGoalConfiguration } from '../benchmarks/final-goal-contract.mjs';
import { finalGoalAccountingClass, finalGoalAccountingClasses } from '../benchmarks/final-goal-resource-policy.mjs';
import { verifyFinalGoalEvidence } from './verify-final-goal.mjs';

const linux = JSON.parse(await readFile(new URL('../benchmarks/configurations/final-goal-linux.json', import.meta.url), 'utf8'));
const mac = JSON.parse(await readFile(new URL('../benchmarks/configurations/final-goal.json', import.meta.url), 'utf8'));
const temporaryRoot = fileURLToPath(new URL('../workbench/final-goal-linux-policy-tests/', import.meta.url));
await mkdir(temporaryRoot, { recursive: true });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const analyze = (configuration, status = 'draft') => analyzeFinalGoal({ configuration,
  declaration: { status, configurationSha256: finalGoalHash(configuration) }, scenarioResults: [] });

test('Linux preserves the complete matrix, scheduling, artifacts and acceptance threshold', () => {
  verifyFinalGoalConfiguration(linux);
  for (const key of ['scenarios', 'cells', 'statistics', 'minimumSpeedup', 'minimumApplicationWins', 'independentPairs',
    'requiredGateIds', 'clockBoundary', 'samplingPolicy', 'confidencePolicy']) assert.deepEqual(linux[key], mac[key], key);
  const result = analyze(linux);
  assert.equal(result.declaredScenarioCount, 9);
  assert.equal(result.requiredMajority, 5);
  assert.equal(result.scenarios.length, 9);
  assert(result.scenarios.every(scenario => scenario.cells.length === 2));
  assert.equal(result.goalAccepted, false);
  assert.equal(result.evidenceComplete, false);
  assert.equal(result.sealed, false);
  assert.match(result.scope, /Native Linux x64/);
  assert.match(result.scope, /charged memory, not wait4 CPU or sampled RSS/);
  assert.doesNotMatch(result.scope, /Native macOS arm64/);
});

test('historical macOS class remains implicit and its policy remains unchanged', () => {
  verifyFinalGoalConfiguration(mac);
  assert.equal(finalGoalAccountingClass(mac), finalGoalAccountingClasses.darwin);
  const explicit = structuredClone(mac);
  explicit.accountingClass = finalGoalAccountingClasses.darwin;
  verifyFinalGoalConfiguration(explicit);
  assert.match(analyze(mac).scope, /Native macOS arm64/);
  assert.equal(mac.resourcePolicy.maximumSampledConcurrentBytes, 8 * 1024 ** 3);
  assert.equal(mac.maximumRegressionRatios.originalOwnerInclusiveCpuMedian, 1.1);
});

const invalidLinux = [
  ['missing accounting class', c => { delete c.accountingClass; }],
  ['macOS accounting class', c => { c.accountingClass = finalGoalAccountingClasses.darwin; }],
  ['unknown accounting class', c => { c.accountingClass = 'cpu-and-memory'; }],
  ['unmatched architecture', c => { c.architecture = 'arm64'; }],
  ['unknown platform', c => { c.platform = 'win32'; }],
  ['host count below workload quota', c => { c.resourcePolicy.logicalCpuCount = 3; }],
  ['fractional host count', c => { c.resourcePolicy.logicalCpuCount = 4.5; }],
  ['host memory below workload limit', c => { c.resourcePolicy.physicalMemoryBytes = 4 * 1024 ** 3; }],
  ['invalid host memory', c => { c.resourcePolicy.physicalMemoryBytes = Infinity; }],
  ['unenforced limits', c => { c.resourcePolicy.operatingSystemEnforcedLimits = false; }],
  ['extra CPU quota', c => { c.resourcePolicy.cpuMax.quotaMicroseconds = 800000; }],
  ['different CPU period', c => { c.resourcePolicy.cpuMax.periodMicroseconds = 50000; }],
  ['increased memory ceiling', c => { c.resourcePolicy.maximumCgroupChargedBytes *= 2; }],
  ['swap enabled', c => { c.resourcePolicy.maximumSwapBytes = 1024; }],
  ['RSS relabelled as charged memory', c => { c.resourcePolicy.maximumSampledConcurrentBytes = c.resourcePolicy.maximumCgroupChargedBytes; delete c.resourcePolicy.maximumCgroupChargedBytes; }],
  ['legacy RSS regression metric', c => { c.maximumRegressionRatios.sampledConcurrentMemoryMaximum = 1.1; delete c.maximumRegressionRatios.cgroupChargedMemoryMaximum; }],
  ['legacy wait4 regression metric', c => { c.maximumRegressionRatios.originalOwnerInclusiveCpuMedian = 1.1; delete c.maximumRegressionRatios.cgroupCpuUsageMedian; }],
  ['relaxed charged-memory regression', c => { c.maximumRegressionRatios.cgroupChargedMemoryMaximum = 2; }],
  ['relaxed cgroup CPU regression', c => { c.maximumRegressionRatios.cgroupCpuUsageMedian = 2; }],
  ['smaller matrix', c => { c.scenarios.pop(); }],
  ['weaker speed threshold', c => { c.minimumSpeedup = 1.1; }],
  ['fewer application wins', c => { c.minimumApplicationWins = 1; }],
  ['fewer independent pairs', c => { c.independentPairs = 4; }],
  ['missing throughput cell', c => { c.cells.pop(); }],
];
for (const [name, change] of invalidLinux) test(`Linux policy rejects ${name}`, () => {
  const configuration = structuredClone(linux); change(configuration);
  assert.throws(() => verifyFinalGoalConfiguration(configuration));
});

test('Linux resource labels cannot be attached to the historical macOS policy', () => {
  const configuration = structuredClone(mac);
  configuration.accountingClass = finalGoalAccountingClasses.linux;
  assert.throws(() => verifyFinalGoalConfiguration(configuration));
});

test('sealing status cannot promote diagnostic Linux captures through the macOS adapter', () => {
  const configuration = structuredClone(linux);
  configuration.status = 'sealed';
  for (const scenario of configuration.scenarios) {
    scenario.sourceManifest = { 'synthetic.ts': hash(scenario.id) };
    scenario.applicationPolicySha256 = hash('synthetic-policy');
    scenario.previouslySupported = { 'single-worker': false, 'matched-throughput': false };
    scenario.expectedTests = Array.from({ length: scenario.expectedTestCount }, (_, index) => ({
      id: `${scenario.id}/${index}`, bodySha256: hash(`${index}`), outcome: 'passed', observations: {},
    }));
  }
  verifyFinalGoalConfiguration(configuration);
  assert.throws(() => analyze(configuration, 'sealed'), /Linux original-resource reconstruction and campaign admission are not integrated/);
  assert.equal(analyze(configuration, 'draft').goalAccepted, false);
  assert.equal(analyze(linux, 'sealed').goalAccepted, false);
});

async function retain(directory) {
  async function save(path, value) {
    const bytes = Buffer.from(JSON.stringify(value));
    await writeFile(join(directory, path), bytes);
    return { path, sha256: hash(bytes) };
  }
  const failed = await save('original-failed-attempt.json', { status: 'failed', reason: 'Synthetic original timeout; no measured browser data' });
  const campaign = { schemaVersion: 1, configuration: await save('configuration.json', linux),
    declaration: await save('declaration.json', { status: 'draft', configurationSha256: finalGoalHash(linux) }), scenarios: [] };
  for (const [index, scenario] of linux.scenarios.entries()) {
    const result = { id: scenario.id, cells: linux.cells.map((cell, cellIndex) => index === 0 && cellIndex === 0
      ? { id: cell.id, status: 'failed', reason: 'Synthetic original timeout', evidence: [failed],
        attempts: [{ failure: { code: 'TimeoutError', message: 'Synthetic original timeout' }, evidence: [failed] }] }
      : { id: cell.id, status: 'unmeasured', attempts: [] }) };
    campaign.scenarios.push({ ...await save(`${scenario.id}.json`, result), scenarioId: scenario.id });
  }
  await save('campaign.json', campaign);
  return { campaign, failed };
}

test('retained Linux draft checks all scenario files and original failed evidence without accepting it', async () => {
  const directory = await mkdtemp(join(temporaryRoot, 'retained-'));
  try {
    const { failed } = await retain(directory);
    const result = await verifyFinalGoalEvidence(directory);
    assert.equal(result.analysis.goalAccepted, false);
    assert.equal(result.analysis.declaredScenarioCount, 9);
    assert.equal(result.checkedFiles[failed.path], failed.sha256);
    assert.equal(Object.keys(result.checkedFiles).length, 13);
    await writeFile(join(directory, failed.path), '{}');
    await assert.rejects(() => verifyFinalGoalEvidence(directory), /Retained evidence bytes changed/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
