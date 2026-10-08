import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { sourceManifest } from '../tools/source-manifest.mjs';
import { sha256 } from '../tools/resident-load-evidence.mjs';
import { runResidentLoad } from '../benchmarks/execute-resident-load.mjs';

const configuration = JSON.parse(await readFile('benchmarks/configurations/resident-load.json'));
const launchPolicy = JSON.parse(await readFile('crates/flashwright-browser/src/chromium-launch-policy.json'));
const destination = resolve('.cache/coalescing-final-diagnostic-' + process.argv[2]);
await mkdir(destination);
const sources = await sourceManifest();
const records = [];
const scenarios = ['quiet-text', 'property-only'].flatMap(workload => [32, 128].map(conditionCount => ({ workload, conditionCount })));
for (const scenario of scenarios) {
  const { workload, conditionCount } = scenario;
  const record = await runResidentLoad({ mode: 'flashwright-on', scenario,
    launchGroup: 0, destination, configuration, launchPolicy,
    driverPath: process.env.FLASHWRIGHT_DRIVER_PATH, executablePath: process.env.FLASHWRIGHT_BROWSER_PATH, diagnostic: true });
  assert.deepEqual(record.contractFailures, []);
  records.push(record);
  console.log(JSON.stringify({ workload, conditionCount, completeMilliseconds: record.completeMilliseconds,
    observedCpuSeconds: record.resources.observedCpuSeconds, memory: record.resources.maximumSampledConcurrentRssBytes,
    metrics: record.conditionMetrics }));
}
assert.deepEqual(await sourceManifest(), sources);
await writeFile(join(destination, 'metadata.json'), JSON.stringify({ sources, driverSha256: sha256(await readFile(process.env.FLASHWRIGHT_DRIVER_PATH)),
  browserSha256: sha256(await readFile(process.env.FLASHWRIGHT_BROWSER_PATH)),
  scope: 'Instrumented development diagnostic only. No matched production speed/resource claim. Fixed work verified for four public-API timer-shape scenarios across two concurrency levels. Historical diagnostics are not a matched before/after comparison.' }, null, 2));
