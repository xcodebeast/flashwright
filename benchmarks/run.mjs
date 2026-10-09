import { requireBun, bunVersion } from '../tools/bun-toolchain.mjs';
import { runtimeMetadata } from '../tools/javascript-runtime.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { summarize } from './statistics.mjs';

const configuration = JSON.parse(await readFile('benchmarks/configurations/baseline.json', 'utf8'));
const runIdentifier = `${new Date().toISOString().replaceAll(':', '-')}-${process.platform}-${process.arch}-${randomUUID().slice(0, 8)}`;
const destination = process.env.FLASHWRIGHT_RESULT_DIRECTORY ?? path.resolve('benchmarks/results', runIdentifier);
await mkdir(destination, { recursive: true });

async function hashFile(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function sourceHashes(directory = '.') {
  const hashes = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (['node_modules', '.git', '.tools', '.cache', 'target', 'test-results', 'playwright-report'].includes(entry.name) || file === 'benchmarks/results') continue;
    if (entry.isDirectory()) Object.assign(hashes, await sourceHashes(file));
    else if (entry.isFile()) hashes[file] = await hashFile(file);
  }
  return hashes;
}

function runSample(launchIndex) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, ['benchmarks/sample.mjs', String(launchIndex)], { env: { ...process.env, DEBUG: 'pw:browser' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let diagnostics = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { diagnostics += chunk; });
    child.on('error', error => resolve({ launchIndex, failures: [error.stack], diagnostics }));
    child.on('close', (code, signal) => {
      try { resolve({ ...JSON.parse(output), processExit: { code, signal }, diagnostics }); }
      catch (error) { resolve({ launchIndex, failures: [error.stack], processExit: { code, signal }, output, diagnostics }); }
    });
  });
}

const executablePath = process.env.FLASHWRIGHT_BROWSER_PATH ?? chromium.executablePath();
const metadata = {
  schemaVersion: 1, runIdentifier, startedAt: new Date().toISOString(),
  purpose: 'Reference baseline only; no Flashwright speed claim',
  platform: process.platform, architecture: process.arch, operatingSystem: os.version(), release: os.release(),
  cpu: os.cpus()[0]?.model, logicalProcessors: os.cpus().length, totalMemoryBytes: os.totalmem(),
  ...runtimeMetadata, playwright: JSON.parse(await readFile('node_modules/playwright/package.json', 'utf8')).version,
  typescript: JSON.parse(await readFile('node_modules/typescript/package.json', 'utf8')).version,
  packageManager: `bun@${bunVersion}`,
  packageManagerExecutable: requireBun(),
  rust: (() => { try { return execFileSync('rustc', ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; } })(),
  browser: { executablePath, sha256: await hashFile(executablePath), revision: '1223', version: configuration.browserVersion, flagsSource: 'Each raw launch retains DEBUG=pw:browser actual launch flags.' },
  environmentClass: process.env.FLASHWRIGHT_ENVIRONMENT_CLASS ?? 'native',
  containerImage: process.env.FLASHWRIGHT_CONTAINER_IMAGE ?? null,
  resourceReportPath: process.env.FLASHWRIGHT_RESOURCE_REPORT ?? null,
  configuration, sourceHashes: await sourceHashes(),
  instrumentation: {
    browserLaunchLogging: true, protocolWireCapture: false, protocolCrossings: null, payloadBytes: null,
    discoveryVisits: null, residentEvaluations: null,
    detectionLag: 'Upper bound includes one additional browser evaluation after the assertion.',
    resources: 'Run under tools/watchdog.py with --report for sampled descendant-tree CPU and concurrent RSS.',
  },
};
await writeFile(path.join(destination, 'metadata.json'), JSON.stringify(metadata, null, 2) + '\n', { flag: 'wx' });
const launches = [];
for (let launchIndex = 0; launchIndex < configuration.independentLaunches; launchIndex++) {
  const result = await runSample(launchIndex);
  launches.push(result);
  await writeFile(path.join(destination, `launch-${launchIndex}.json`), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  console.log(`Retained launch ${launchIndex + 1}/${configuration.independentLaunches}`);
}
const summary = {
  kind: 'reference-baseline', complete: launches.length === configuration.independentLaunches,
  unexpectedFailures: launches.reduce((count, launch) => count + launch.failures.length + (launch.workloads ?? []).reduce((total, workload) => total + workload.failures.length, 0) + (launch.processExit?.code !== 0 ? 1 : 0), 0),
  workloads: Object.fromEntries(configuration.workloads.map(name => [name, summarize(launches.map(launch => launch.workloads?.find(workload => workload.name === name)?.samples.map(sample => sample.milliseconds) ?? []), configuration.statistics)])),
  completeLaunch: summarize(launches.map(launch => launch.completeMilliseconds === undefined ? [] : [launch.completeMilliseconds]), configuration.statistics),
};
await writeFile(path.join(destination, 'summary.json'), JSON.stringify(summary, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ destination, unexpectedFailures: summary.unexpectedFailures, medians: Object.fromEntries(Object.entries(summary.workloads).map(([name, values]) => [name, values.medianMilliseconds])) }, null, 2));
if (summary.unexpectedFailures) process.exitCode = 1;
