import assert from 'node:assert/strict';
import { requireVerifiedBrowser } from './browser-identity.mjs';
import { readEngineConfiguration } from './engine-configuration.mjs';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { verifyLaunch } from '../benchmarks/paired-contract.mjs';
import { analyzeProtocol } from '../benchmarks/protocol-profile.mjs';

const root = resolve(process.argv[2]);
const read = async path => JSON.parse(await readFile(path, 'utf8'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const summary = await read(join(root, 'summary.json'));
const metadata = await read(join(root, 'metadata.json'));
assert.equal(summary.kind, 'instrumented-protocol-attribution');
assert.equal(summary.valid, true);
assert.ok(summary.sourcesUnchanged && summary.driverUnchanged && summary.browserUnchanged);
for (const [path, digest] of Object.entries(summary.retainedFileHashes)) assert.equal(hash(await readFile(join(root, path))), digest, path);
const verification = await read(metadata.verification.path);
assert.equal(hash(await readFile(metadata.verification.path)), metadata.verification.sha256);
assert.equal(verification.status, 'passed');
// Historical snapshots predate browser binding; new producers always require it.
if (metadata.verificationBrowserBound) requireVerifiedBrowser(verification, metadata.browser);
assert.equal(verification.sourceChangedDuringVerification, false);
assert.deepEqual(verification.sources, metadata.sources);
assert.deepEqual(verification.engineConfiguration ?? readEngineConfiguration({}), metadata.engineConfiguration ?? readEngineConfiguration({}));
assert.equal(verification.driverSha256, metadata.driver.sha256);
for (const check of verification.checks) {
  assert.equal(check.code, 0);
  assert.equal(hash(await readFile(join(dirname(metadata.verification.path), check.log))), check.logSha256);
}
assert.equal(summary.launches.length, metadata.independentLaunchPairs * 2);
assert.equal(new Set(summary.launches.map(launch => `${launch.launchIndex}/${launch.engine}`)).size, summary.launches.length);
for (const launch of summary.launches) {
  assert.deepEqual(launch.failures, []);
  const result = await read(join(root, `launch-${launch.launchIndex}-${launch.engine}.json`));
  verifyLaunch(result, metadata.configuration, metadata.browser.launchPolicy, metadata.proxy.path);
  assert.equal(result.protocolPhases.length, metadata.configuration.workloads.length * (metadata.configuration.warmupIterations + metadata.configuration.measuredIterations + 3) + 2);
  const traceDirectory = join(root, `trace-${launch.launchIndex}-${launch.engine}`);
  const files = await readdir(traceDirectory);
  assert.equal(files.length, 1);
  const records = (await readFile(join(traceDirectory, files[0]), 'utf8')).trim().split('\n').map(JSON.parse);
  const profile = analyzeProtocol(records, result.protocolPhases, metadata.browser.path, metadata.browser.launchPolicy.headless);
  assert.deepEqual(profile, launch.profile);
  assert.equal(profile.commandCounts['Input.dispatchMouseEvent'], (metadata.configuration.warmupIterations + metadata.configuration.measuredIterations) * 6);
  assert.equal(profile.phases.reduce((sum, phase) => sum + phase.commandCount, 0) + profile.ambiguousPhaseCommands.length + profile.outsidePhaseCommands.length, profile.commandCount);
}
console.log(`Verified ${summary.launches.length} instrumented launches, exact forwarded-byte accounting, clock bounds, semantic outcomes and retained hashes: ${root}`);
