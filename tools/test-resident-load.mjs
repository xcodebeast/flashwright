import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { chromium } from 'playwright';
import { runResidentLoad } from '../benchmarks/execute-resident-load.mjs';
import { loadModes, verifyResidentLoad } from '../benchmarks/resident-load-contract.mjs';
import { residentLoadPlan } from '../benchmarks/resident-load-analysis.mjs';
import { sourceManifest } from './source-manifest.mjs';
import { sha256 } from './resident-load-evidence.mjs';

const configuration = JSON.parse(await readFile('benchmarks/configurations/resident-load.json', 'utf8'));
const launchPolicy = JSON.parse(await readFile('crates/flashwright-browser/src/chromium-launch-policy.json', 'utf8'));
const driverPath = resolve(process.env.FLASHWRIGHT_DRIVER_PATH ?? 'target/debug/flashwright-driver');
const executablePath = process.env.FLASHWRIGHT_BROWSER_PATH ?? chromium.executablePath();
const destination = await mkdtemp(resolve(`compatibility/evidence/resident-load-contract-${process.platform}-${process.arch}-${process.versions.node}-`));
const sources = await sourceManifest();
const launches = [];
for (const workload of configuration.workloads) {
  const scenario = { workload, conditionCount: workload === 'mutation-text' ? 128 : 1 };
  for (const mode of loadModes) {
    const result = await runResidentLoad({ mode, scenario, launchGroup: 0, destination, configuration, launchPolicy, driverPath, executablePath, functionalConformance: true });
    assert.deepEqual(result.contractFailures, [], `${mode}/${workload}: see ${destination}`);
    launches.push(result);
  }
}
const diagnostic = await runResidentLoad({ mode: 'flashwright-on', scenario: { workload: 'mutation-text', conditionCount: 128 },
  launchGroup: 1, destination, configuration, launchPolicy, driverPath, executablePath, diagnostic: true, functionalConformance: true });
assert.deepEqual(diagnostic.contractFailures, [], `Counter diagnostics: see ${destination}`);
const valid = launches.find(launch => launch.mode === 'flashwright-on' && launch.scenario.workload === 'mutation-text');
const corruptions = {
  'wrong execution purpose': record => { record.executionPurpose = 'comparison'; },
  'wrong assertion deadline': record => { record.assertionTimeoutMilliseconds++; },
  'wrong watchdog deadline': record => { record.resources.timeoutSeconds++; },
  'missing execution purpose': record => { delete record.executionPurpose; },
  'missing sample version': record => { delete record.schemaVersion; },
  'omitted assertion': record => record.assertionsCompleted--,
  'dropped application task': record => record.observations.tasks--,
  'dropped mutation': record => record.observations.mutations--,
  'omitted backend request': record => record.backend.backendRequests--,
  'wrong final target': record => { record.observations.targetValues[0] = 'before'; },
  'wrong final element count': record => record.observations.elementCount--,
  'early application completion': record => { record.observations.readyAt = record.observations.startedAt; },
  'CPU total differs from process records': record => record.resources.observedCpuSeconds++,
  'coherent CPU totals disagree with raw observations': record => {
    record.resources.processes[0].cpuSeconds++;
    record.resources.observedCpuSeconds = record.resources.processes.reduce((total, process) => total + process.cpuSeconds, 0);
  },
  'CPU falls to zero when an observed process exits': record => {
    const process = record.resources.processes.find(process => process.cpuSeconds > 0);
    const last = record.resources.samples.at(-1);
    record.resources.samples.push({ elapsedSeconds: last.elapsedSeconds + 0.1, concurrentRssBytes: 0, liveOwnedProcesses: 1,
      processes: [{ ...process, cpuSeconds: 0, rssBytes: 0 }] });
    process.cpuSeconds = 0;
    record.resources.observedCpuSeconds = record.resources.processes.reduce((total, process) => total + process.cpuSeconds, 0);
  },
  'memory peak differs from samples': record => record.resources.maximumSampledConcurrentRssBytes++,
  'unobserved claimed process': record => record.resources.observedProcessCount++,
  'watchdog had to terminate a process': record => record.resources.cleanupSignals.push({ process: 1, signal: 'SIGTERM' }),
  'wrong residency mode': record => { record.engineConfiguration.residentAssertions = false; },
  'counters enabled in production comparison': record => { record.engineConfiguration.conditionInstrumentation = true; },
};
for (const [name, corrupt] of Object.entries(corruptions)) {
  const altered = structuredClone(valid);
  corrupt(altered);
  assert.throws(() => verifyResidentLoad(altered, configuration, launchPolicy, executablePath, false, true), name);
}
assert.throws(() => verifyResidentLoad(diagnostic, configuration, launchPolicy, executablePath, false, true), 'Diagnostic runs cannot enter the ordinary functional sample class');
assert.throws(() => verifyResidentLoad(valid, configuration, launchPolicy, executablePath), 'Functional runs cannot enter production comparisons');
const unmatchedPolicy = { ...launchPolicy, headless: [], headed: [] };
assert.throws(() => verifyResidentLoad(valid, configuration, unmatchedPolicy, executablePath, false, true), 'Different browser policy');
const plan = residentLoadPlan(configuration);
assert.equal(plan.length, 162);
for (const workload of configuration.workloads) for (const conditionCount of configuration.conditionCounts) {
  const matching = plan.filter(entry => entry.scenario.workload === workload && entry.scenario.conditionCount === conditionCount);
  const orders = Array.from({ length: 6 }, (_, group) => matching.filter(entry => entry.launchGroup === group).map(entry => entry.mode));
  assert.equal(new Set(orders.map(order => order.join(','))).size, 6);
  for (const order of orders) assert.deepEqual([...order].sort(), [...loadModes].sort());
}
assert.deepEqual(await sourceManifest(), sources);
const files = launches.concat(diagnostic).flatMap(launch => {
  const name = `${launch.launchGroup}-${launch.scenario.workload}-${launch.scenario.conditionCount}-${launch.mode}`;
  return [`launch-${name}.json`, `resources-${name}.json`];
});
const report = { status: 'passed', node: process.version, platform: process.platform, architecture: process.arch,
  scope: 'Functional workload contract only; nine uninstrumented launches and one separate counter diagnostic, all with the explicitly labeled functional deadline. These samples cannot enter production comparisons.',
  functionalConformance: configuration.functionalConformance,
  sources, driverSha256: sha256(await readFile(driverPath)), executablePath,
  checks: [...Object.keys(corruptions), 'diagnostic exclusion', 'functional sample exclusion from production comparison', 'matched browser policy', 'all six engine orders in every scenario'],
  retainedFileHashes: Object.fromEntries(await Promise.all(files.map(async name => [name, sha256(await readFile(join(destination, name)))]))) };
await writeFile(join(destination, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(`Resident load contracts passed: ${destination}/report.json`);
