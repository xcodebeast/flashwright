import { runtimeMetadata, reportRuntime, javascriptRuntime } from '../tools/javascript-runtime.mjs';
import assert from 'node:assert/strict';
import { identifyBrowser, requireVerifiedBrowser } from '../tools/browser-identity.mjs';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import os from 'node:os';
import { chromium } from 'playwright';
import { sourceManifest } from '../tools/source-manifest.mjs';
import { readEngineConfiguration } from '../tools/engine-configuration.mjs';
import { runSample } from './execute-sample.mjs';
import { analyzeProtocol } from './protocol-profile.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const configuration = JSON.parse(await readFile('benchmarks/configurations/baseline.json', 'utf8'));
const launchPolicy = JSON.parse(await readFile('crates/flashwright-browser/src/chromium-launch-policy.json', 'utf8'));
const driverPath = resolve(process.env.FLASHWRIGHT_DRIVER_PATH ?? 'target/release/flashwright-driver');
const browserIdentity = await identifyBrowser(process.env.FLASHWRIGHT_BROWSER_PATH ?? chromium.executablePath());
const browserPath = browserIdentity.executablePath;
assert.equal(browserIdentity.version, configuration.browserVersion);
const proxyPath = resolve('benchmarks/protocol-proxy.py');
const verificationPath = process.env.FLASHWRIGHT_VERIFICATION_REPORT;
assert.ok(verificationPath, 'Provide the passed core verification report for this source snapshot and driver');
const verification = JSON.parse(await readFile(verificationPath, 'utf8'));
const sources = await sourceManifest();
const engineConfiguration = readEngineConfiguration();
assert.deepEqual(verification.engineConfiguration ?? readEngineConfiguration({}), engineConfiguration);
assert.equal(verification.status, 'passed');
requireVerifiedBrowser(verification, browserIdentity);
assert.equal(verification.sourceChangedDuringVerification, false);
assert.deepEqual(reportRuntime(verification), javascriptRuntime);
assert.equal(verification.platform, process.platform);
assert.equal(verification.architecture, process.arch);
assert.deepEqual(verification.sources, sources);
assert.equal(verification.driverSha256, hash(await readFile(driverPath)));
for (const check of verification.checks) {
  assert.equal(check.code, 0);
  assert.equal(hash(await readFile(join(dirname(verificationPath), check.log))), check.logSha256);
}
const destination = resolve('benchmarks/results', `${new Date().toISOString().replaceAll(':', '-')}-${process.platform}-${process.arch}-attribution-${randomUUID().slice(0, 8)}`);
await mkdir(destination, { recursive: true });
const metadata = {
  verificationBrowserBound: true,
  kind: 'instrumented-protocol-attribution', schemaVersion: 1, independentLaunchPairs: 2,
  ...runtimeMetadata, platform: process.platform, architecture: process.arch,
  operatingSystem: os.version(), release: os.release(), cpu: os.cpus()[0]?.model,
  logicalProcessors: os.cpus().length, totalMemoryBytes: os.totalmem(), initialLoadAverage: os.loadavg(),
  python: execFileSync('python3', ['--version'], { encoding: 'utf8' }).trim(),
  driver: { path: driverPath, sha256: hash(await readFile(driverPath)) },
  browser: { ...browserIdentity, path: browserPath, launchPolicy },
  proxy: { path: proxyPath, sha256: hash(await readFile(proxyPath)) },
  verification: { path: resolve(verificationPath), sha256: hash(await readFile(verificationPath)) },
  sources, configuration, engineConfiguration,
  scope: 'Exact forwarded CDP message bytes, command/evaluation counts and acknowledgement intervals for the shared benchmark workloads. Added proxy work and clock calibration perturb timing; these runs cannot establish production speed or resource improvements.',
  limitations: [
    'Acknowledgement intervals include proxy parsing/forwarding, browser work and pipe scheduling; they are not browser CPU measurements.',
    'Time outside acknowledgement intervals includes adapter work, retry sleeps, lifecycle/backend waits and instrumentation; it is not pure adapter overhead.',
    'Evaluation counts refer to CDP Runtime.evaluate/callFunctionOn commands, not every internal predicate invocation or DOM discovery visit.',
    'Commands crossing a phase boundary within measured clock uncertainty are reported separately rather than assigned arbitrarily.',
    'The guardian may terminate the proxy during normal browser shutdown; complete correlated command/reply records, calibration and the independent resource audit validate that path.',
  ],
};
await writeFile(join(destination, 'metadata.json'), JSON.stringify(metadata, null, 2) + '\n', { flag: 'wx' });
const launches = [];
for (let launchIndex = 0; launchIndex < metadata.independentLaunchPairs; launchIndex++) {
  for (const engine of launchIndex % 2 ? ['flashwright', 'playwright'] : ['playwright', 'flashwright']) {
    const traceDirectory = join(destination, `trace-${launchIndex}-${engine}`);
    await mkdir(traceDirectory);
    process.env.FLASHWRIGHT_PROFILE_BROWSER_PATH = browserPath;
    process.env.FLASHWRIGHT_PROFILE_PROTOCOL_DIRECTORY = traceDirectory;
    const result = await runSample({ launchIndex, engine, destination, configuration, launchPolicy, driverPath, executablePath: proxyPath });
    delete process.env.FLASHWRIGHT_PROFILE_BROWSER_PATH;
    delete process.env.FLASHWRIGHT_PROFILE_PROTOCOL_DIRECTORY;
    let profile;
    try {
      assert.deepEqual(result.contractFailures, []);
      const files = await readdir(traceDirectory);
      assert.equal(files.length, 1, 'Expected one traced Chromium connection per launch');
      const records = (await readFile(join(traceDirectory, files[0]), 'utf8')).trim().split('\n').map(JSON.parse);
      assert.equal(result.protocolPhases.length, configuration.workloads.length * (configuration.warmupIterations + configuration.measuredIterations + 3) + 2);
      profile = analyzeProtocol(records, result.protocolPhases, browserPath, launchPolicy.headless);
      const nativeMouseCommands = profile.commandCounts['Input.dispatchMouseEvent'];
      assert.equal(nativeMouseCommands, (configuration.warmupIterations + configuration.measuredIterations) * 6);
    } catch (error) {
      result.contractFailures.push(error.stack);
    }
    launches.push({ engine, launchIndex, profile, failures: result.contractFailures });
    console.log(`Retained attribution ${engine} ${launchIndex + 1}: ${result.contractFailures.length ? 'invalid' : 'verified'}`);
  }
}
const sourcesUnchanged = JSON.stringify(sources) === JSON.stringify(await sourceManifest());
const driverUnchanged = metadata.driver.sha256 === hash(await readFile(driverPath));
const browserUnchanged = metadata.browser.sha256 === hash(await readFile(browserPath));
const summary = {
  kind: metadata.kind, valid: sourcesUnchanged && driverUnchanged && browserUnchanged && launches.every(launch => !launch.failures.length),
  sourcesUnchanged, driverUnchanged, browserUnchanged, launches,
  retainedFileHashes: {},
};
async function retainHashes(directory, prefix = '') {
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((first, second) => first.name.localeCompare(second.name))) {
    const name = prefix + entry.name;
    if (entry.isDirectory()) await retainHashes(join(directory, entry.name), name + '/');
    else summary.retainedFileHashes[name] = hash(await readFile(join(directory, entry.name)));
  }
}
await retainHashes(destination);
await writeFile(join(destination, 'summary.json'), JSON.stringify(summary, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ destination, valid: summary.valid, failures: launches.flatMap(launch => launch.failures) }, null, 2));
process.exitCode = summary.valid ? 0 : 1;
