import { runtimeMetadata, runtimeArtifactLabel } from './javascript-runtime.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { runSample } from '../benchmarks/execute-sample.mjs';
import { verifyLaunch } from '../benchmarks/paired-contract.mjs';

const configuration = JSON.parse(await readFile('benchmarks/configurations/baseline.json', 'utf8'));
const launchPolicy = JSON.parse(await readFile('crates/flashwright-browser/src/chromium-launch-policy.json', 'utf8'));
const driverPath = process.env.FLASHWRIGHT_DRIVER_PATH ?? resolve('target/debug/flashwright-driver');
const executablePath = process.env.FLASHWRIGHT_BROWSER_PATH ?? chromium.executablePath();
const destination = await mkdtemp(resolve('.cache/benchmark-contract-'));
const results = {};
for (const engine of ['playwright', 'flashwright']) {
  const result = await runSample({ launchIndex: 0, engine, destination, configuration, launchPolicy, driverPath, executablePath });
  results[engine] = result;
  assert.deepEqual(result.contractFailures, [], `${engine}: retained failure in ${destination}`);
}
assert.deepEqual(results.flashwright.workloads.map(workload => workload.observations), results.playwright.workloads.map(workload => workload.observations));
const missingInput = structuredClone(results.flashwright);
missingInput.workloads.find(workload => workload.name === 'interaction').observations.trustedClicks--;
assert.throws(() => verifyLaunch(missingInput, configuration, launchPolicy, executablePath));
const missingRequest = structuredClone(results.flashwright);
missingRequest.backend.backendRequests--;
assert.throws(() => verifyLaunch(missingRequest, configuration, launchPolicy, executablePath));
const changedPolicy = { ...launchPolicy, headless: launchPolicy.headless.filter(argument => argument !== '--allow-pre-commit-input') };
assert.throws(() => verifyLaunch(results.flashwright, configuration, changedPolicy, executablePath));
const evidencePath = `compatibility/evidence/benchmark-contract-${process.platform}-${process.arch}-${runtimeArtifactLabel}.json`;
await writeFile(evidencePath, JSON.stringify({
  ...runtimeMetadata, platform: process.platform, architecture: process.arch,
  driverSha256: createHash('sha256').update(await readFile(driverPath)).digest('hex'),
  scope: 'Functional harness validation for the seven shared benchmark flows and actual matched launch arguments. This single pair is not performance evidence.',
  checks: ['matched actual launch arguments', 'native trusted input and application outcomes', 'real backend and document request counts', 'owned process cleanup', 'reject omitted trusted input', 'reject omitted backend request', 'reject unmatched browser policy'],
  results,
}, null, 2) + '\n');
console.log(`Seven shared benchmark flows and matched launch policy verified: ${evidencePath}`);
