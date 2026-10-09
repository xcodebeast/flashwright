import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { startFixtureServer } from './fixture-server.mjs';
import { prepareWorkload } from './workloads/index.mjs';
import { startProfileClock } from './profile-clock.mjs';
import { readEngineConfiguration } from '../tools/engine-configuration.mjs';

const configuration = JSON.parse(await readFile(new URL('./configurations/baseline.json', import.meta.url), 'utf8'));
const launchIndex = Number(process.argv[2]);
const engine = process.argv[3] ?? 'playwright';
assert.ok(['playwright', 'flashwright'].includes(engine));
let chromium;
let expect;
if (engine === 'flashwright') {
  const upstream = await import('flashwright-upstream-runner/test');
  for (const browser of [upstream.chromium, upstream.firefox, upstream.webkit]) {
    for (const method of ['launch', 'launchPersistentContext', 'connect', 'connectOverCDP']) browser[method] = async () => { throw new Error('Forbidden upstream browser backend entered'); };
  }
  upstream.request.newContext = async () => { throw new Error('Forbidden upstream request backend entered'); };
  ({ chromium } = await import('flashwright'));
  ({ expect } = await import('@flashwright/test'));
} else {
  ({ chromium, expect } = await import('@playwright/test'));
}
const started = performance.now();
const server = await startFixtureServer(configuration.backendDelayMilliseconds);
let browser;
const result = { launchIndex, engine, engineConfiguration: readEngineConfiguration(), workloads: [], failures: [] };
const profile = process.env.FLASHWRIGHT_PROFILE_PROTOCOL_DIRECTORY ? [] : undefined;
const stopProfileClock = profile ? await startProfileClock() : undefined;
if (profile) result.protocolPhases = profile;
const phaseStart = () => profile ? process.hrtime.bigint().toString() : undefined;
const phaseEnd = (name, started) => { if (profile) profile.push({ name, started, finished: process.hrtime.bigint().toString() }); };
try {
  const launchStarted = performance.now();
  const launchPhase = phaseStart();
  browser = await chromium.launch({
    headless: configuration.headless,
    ...(process.env.FLASHWRIGHT_BROWSER_PATH ? { executablePath: process.env.FLASHWRIGHT_BROWSER_PATH } : { channel: 'chromium' }),
  });
  phaseEnd('launch', launchPhase);
  result.launchMilliseconds = performance.now() - launchStarted;
  result.browserVersion = browser.version();
  if (result.browserVersion !== configuration.browserVersion) throw new Error(`Browser mismatch: ${result.browserVersion}`);
  const workloads = configuration.workloads;
  const order = workloads.slice(launchIndex % workloads.length).concat(workloads.slice(0, launchIndex % workloads.length));
  for (const name of order) {
    const workloadStarted = performance.now();
    const record = { name, samples: [], warmupSamples: [], failures: [] };
    result.workloads.push(record);
    let workload;
    try {
      const preparationPhase = phaseStart();
      workload = await prepareWorkload(name, browser, server.origin, expect, configuration);
      phaseEnd(`${name}.prepare`, preparationPhase);
      record.preparationMilliseconds = performance.now() - workloadStarted;
      record.accounting = workload.accounting;
      for (const [phase, count] of [['warmupSamples', configuration.warmupIterations], ['samples', configuration.measuredIterations]]) {
        for (let iteration = 0; iteration < count; iteration++) {
          const operationStarted = performance.now();
          const operationPhase = phaseStart();
          try {
            const details = await workload.run();
            record[phase].push({ iteration, milliseconds: performance.now() - operationStarted, ...details });
          } catch (error) {
            record.failures.push({ phase, iteration, milliseconds: performance.now() - operationStarted, error: error.stack });
          }
          phaseEnd(`${name}.${phase}.${iteration}`, operationPhase);
        }
      }
      if (process.env.FLASHWRIGHT_BENCHMARK_OBSERVATIONS) {
        const observationPhase = phaseStart();
        record.observations = await workload.observe();
        phaseEnd(`${name}.observe`, observationPhase);
      }
    } catch (error) { record.failures.push({ phase: 'preparation', error: error.stack }); }
    finally {
      const cleanupStarted = performance.now();
      const cleanupPhase = phaseStart();
      try { await workload?.close(); } catch (error) { record.failures.push({ phase: 'cleanup', error: error.stack }); }
      phaseEnd(`${name}.cleanup`, cleanupPhase);
      record.cleanupMilliseconds = performance.now() - cleanupStarted;
      record.completeMilliseconds = performance.now() - workloadStarted;
    }
  }
} catch (error) { result.failures.push(error.stack); }
finally {
  const cleanupStarted = performance.now();
  const cleanupPhase = phaseStart();
  try { await browser?.close(); } catch (error) { result.failures.push(error.stack); }
  phaseEnd('browser.cleanup', cleanupPhase);
  try { await server.close(); } catch (error) { result.failures.push(String(error.stack ?? error)); }
  try { await stopProfileClock?.(); } catch (error) { result.failures.push(String(error.stack ?? error)); }
  result.cleanupMilliseconds = performance.now() - cleanupStarted;
  result.completeMilliseconds = performance.now() - started;
  result.backend = server.counts;
  process.stdout.write(JSON.stringify(result) + '\n');
}
