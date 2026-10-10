import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { comparePaired, quantile } from '../benchmarks/statistics.mjs';
const [inputDirectory, recordedWorkspace, outputFile] = process.argv.slice(2);
assert.ok(inputDirectory && recordedWorkspace && outputFile, 'Usage: analyze-broad-pair.mjs EVIDENCE_DIRECTORY RECORDED_WORKSPACE NEW_OUTPUT_JSON');
const workspace = resolve(recordedWorkspace);
const directory = pathToFileURL(resolve(inputDirectory) + '/');
execFileSync(process.execPath, [join(workspace, 'tools/verify-broad-matrix.mjs'), resolve(inputDirectory)], { cwd: workspace, stdio: 'pipe' });
const read = async name => JSON.parse(await readFile(new URL(name, directory), 'utf8'));
const metadata = await read('metadata.json');
const broad = await read('summary.json');
assert.equal(broad.valid, true);
assert.equal(broad.attempts.length, 40);
assert.equal(createHash('sha256').update(await readFile(new URL('../benchmarks/statistics.mjs', import.meta.url))).digest('hex'), metadata.sources['benchmarks/statistics.mjs'], 'Use the recorded statistics implementation');
const configuration = metadata.configuration;
const launches = { playwright: [], flashwright: [] };
const fileHashes = {};
for (let index = 0; index < 8; index++) for (const engine of Object.keys(launches)) {
  const name = `launch-${index}-${engine}.json`;
  const bytes = await readFile(new URL(name, directory));
  const record = JSON.parse(bytes);
  assert.equal(record.launchIndex, index);
  assert.equal(record.engine, engine);
  assert.deepEqual(record.contractFailures, []);
  launches[engine].push(record);
  fileHashes[name] = createHash('sha256').update(bytes).digest('hex');
}
const compare = extract => comparePaired(launches.playwright.map(extract), launches.flashwright.map(extract), configuration.statistics);
const resourceSummary = (result, unit) => ({ unit, ...JSON.parse(JSON.stringify(result).replaceAll('Milliseconds', 'Value')) });
const report = {
  schemaVersion: 1,
  kind: 'paired-analysis-of-rotated-broad-blocks',
  processWallDefinition: 'Common watchdog child interval, matching the broad matrix and excluding parent dependency verification.',
  recordedSources: metadata.sources,
  inputSummarySha256: createHash('sha256').update(await readFile(new URL('summary.json', directory))).digest('hex'),
  fileHashes,
  completeLaunch: compare(launch => [launch.completeMilliseconds]),
  processWall: compare(launch => [launch.resources.elapsedSeconds * 1000]),
  startup: compare(launch => [launch.launchMilliseconds]),
  cpu: resourceSummary(compare(launch => [launch.resources.observedCpuSeconds]), 'seconds'),
  memory: resourceSummary(compare(launch => [launch.resources.maximumSampledConcurrentRssBytes]), 'bytes'),
  workloads: Object.fromEntries(configuration.workloads.map(name => [name, {
    operation: compare(launch => launch.workloads.find(workload => workload.name === name).samples.map(sample => sample.milliseconds)),
    preparationInclusive: compare(launch => [launch.workloads.find(workload => workload.name === name).completeMilliseconds]),
  }])),
  setupShare: Object.fromEntries(Object.entries(launches).map(([engine, records]) => [engine, quantile(records.map(record => record.workloads.find(workload => workload.name === 'setup').completeMilliseconds / record.completeMilliseconds), 0.5)])),
  limitations: ['Eight rotated blocks, with each reference/candidate observation paired by block; engines are not necessarily adjacent.', `${metadata.platform}-${metadata.architecture}; ${metadata.measuredRuntime.name}${metadata.measuredRuntime.version} workloads and ${metadata.orchestrator.runtime}${metadata.orchestrator.version} coordinator. Results do not verify another platform or runtime.`, 'Interpretation is limited to the input metadata and recorded source snapshot; this calculation does not establish broader diagnostic or artifact parity.', 'Other contenders have recorded input, launch or runner differences. This paired derivation does not rank them.', 'No release or performance-leadership acceptance.'],
};
const acceptance = configuration.acceptance;
report.policy = {
  materialCompleteFlowImprovement: report.completeLaunch.medianPairedSpeedup >= 1 / (1 - acceptance.minimumMaterialImprovementFraction) && report.completeLaunch.pairedSpeedupConfidenceInterval[0] > 1,
  medianRegressionWorkloads: configuration.workloads.filter(name => report.workloads[name].operation.medianPairedSpeedup < 1 / (1 + acceptance.maximumMedianRegressionFraction)),
  observedMaximumRegressionWorkloads: configuration.workloads.filter(name => report.workloads[name].operation.observedMaximumRatio > 1 + acceptance.maximumObservedTailRegressionFraction),
  memoryWithinPolicy: report.memory.candidate.observedMaximumValue <= report.memory.reference.observedMaximumValue * (1 + acceptance.maximumConcurrentResidentMemoryRegressionFraction),
  releaseAccepted: false,
};
await writeFile(resolve(outputFile), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
const brief = result => ({ ratio: result.medianPairedSpeedup, interval: result.pairedSpeedupConfidenceInterval, observedMaximumRatio: result.observedMaximumRatio });
console.log(JSON.stringify({ complete: brief(report.completeLaunch), cpu: brief(report.cpu), memory: brief(report.memory), setupShare: report.setupShare, workloads: Object.fromEntries(Object.entries(report.workloads).map(([name, value]) => [name, brief(value.operation)])), policy: report.policy }, null, 2));
