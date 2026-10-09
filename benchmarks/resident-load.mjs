import { runtimeMetadata } from '../tools/javascript-runtime.mjs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import os from 'node:os';
import { chromium } from 'playwright';
import { identifyBrowser } from '../tools/browser-identity.mjs';
import { sourceManifest } from '../tools/source-manifest.mjs';
import { retainLoadCoreReport, sha256 } from '../tools/resident-load-evidence.mjs';
import { runResidentLoad, residentLoadName } from './execute-resident-load.mjs';
import { residentLoadPlan, summarizeResidentLoad } from './resident-load-analysis.mjs';

assert.equal(process.env.FLASHWRIGHT_PROFILE_PROTOCOL_DIRECTORY, undefined, 'Production resource comparison requires the ordinary browser path');
const configurationBytes = await readFile('benchmarks/configurations/resident-load.json');
const configuration = JSON.parse(configurationBytes);
assert.equal(configuration.workers, 1);
const policyBytes = await readFile('crates/flashwright-browser/src/chromium-launch-policy.json');
const launchPolicy = JSON.parse(policyBytes);
const driverPath = resolve(process.env.FLASHWRIGHT_DRIVER_PATH ?? 'target/release/flashwright-driver');
const browser = await identifyBrowser(process.env.FLASHWRIGHT_BROWSER_PATH ?? chromium.executablePath());
assert.equal(browser.version, configuration.browserVersion);
const plan = residentLoadPlan(configuration);
const metadata = {
  schemaVersion: 1, kind: 'resident-sustained-load', configuration, plan,
  sources: await sourceManifest(), ...runtimeMetadata, platform: process.platform, architecture: process.arch,
  operatingSystem: os.version(), release: os.release(), cpu: os.cpus()[0]?.model,
  logicalProcessors: os.cpus().length, totalMemoryBytes: os.totalmem(), initialLoadAverage: os.loadavg(),
  toolchains: Object.fromEntries(['rustc', 'cargo', 'npm'].map(command => [command, execFileSync(command, ['--version'], { encoding: 'utf8' }).trim()])),
  driver: { path: driverPath, sha256: sha256(await readFile(driverPath)) }, browser: { ...browser, launchPolicy }, verification: {},
  environmentClass: process.env.FLASHWRIGHT_ENVIRONMENT_CLASS ?? 'shared-native-development-host',
  instrumentation: 'All modes disable predicate counters; no protocol proxy.',
  limitations: ['Single worker, shared native host; no native Linux or contention acceptance.',
    '10 Hz process-tree observations can miss short-lived descendants and final CPU work before exit; CPU sums each observed PID/start identity maximum. Platform ps precision applies.',
    'Memory is maximum sampled concurrent RSS. Six independent groups support observed maxima and bootstrap intervals, not percentile tails.',
    'Detection-lag upper bounds include the final observation call. These workloads do not establish a release or fastest-engine claim.'],
};
const destination = resolve('benchmarks/results', `${new Date().toISOString().replaceAll(':', '-')}-${process.platform}-${process.arch}-resident-load-${randomUUID().slice(0, 8)}`);
await mkdir(destination, { recursive: true });
const retainedNames = ['metadata.json', 'configuration.json', 'launch-policy.json'];
for (const [mode, variable] of Object.entries({ off: 'FLASHWRIGHT_BASELINE_VERIFICATION_REPORT', on: 'FLASHWRIGHT_VERIFICATION_REPORT' })) {
  assert.ok(process.env[variable], `Set ${variable} to matching passed core evidence`);
  const retained = await retainLoadCoreReport(resolve(process.env[variable]), destination, mode, metadata);
  metadata.verification[mode] = retained.verification;
  retainedNames.push(...retained.retainedNames);
}
await writeFile(join(destination, 'configuration.json'), configurationBytes, { flag: 'wx' });
await writeFile(join(destination, 'launch-policy.json'), policyBytes, { flag: 'wx' });
await writeFile(join(destination, 'metadata.json'), JSON.stringify(metadata, null, 2) + '\n', { flag: 'wx' });
const launches = [];
console.log(`Retaining all ${plan.length} launches in ${destination}`);
for (const entry of plan) {
  const launch = await runResidentLoad({ ...entry, destination, configuration, launchPolicy, driverPath, executablePath: browser.executablePath });
  launches.push(launch);
  const name = residentLoadName(entry);
  retainedNames.push(`launch-${name}.json`, `resources-${name}.json`);
  console.log(`${launches.length}/${plan.length} ${name}: ${launch.contractFailures.length ? 'INVALID' : 'verified'}`);
}
const summary = {
  complete: true,
  sourceChangedDuringTiming: JSON.stringify(metadata.sources) !== JSON.stringify(await sourceManifest()),
  driverChangedDuringTiming: sha256(await readFile(driverPath)) !== metadata.driver.sha256,
  browserChangedDuringTiming: sha256(await readFile(browser.executablePath)) !== browser.sha256,
  unexpectedFailures: launches.reduce((total, launch) => total + launch.contractFailures.length, 0),
};
summary.valid = !summary.sourceChangedDuringTiming && !summary.driverChangedDuringTiming && !summary.browserChangedDuringTiming && summary.unexpectedFailures === 0;
if (summary.valid) summary.scenarios = summarizeResidentLoad(launches, configuration);
summary.retainedFileHashes = Object.fromEntries(await Promise.all(retainedNames.sort().map(async name => [name, sha256(await readFile(join(destination, name)))])));
await writeFile(join(destination, 'summary.json'), JSON.stringify(summary, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ destination, valid: summary.valid, unexpectedFailures: summary.unexpectedFailures }, null, 2));
process.exitCode = summary.valid ? 0 : 1;
