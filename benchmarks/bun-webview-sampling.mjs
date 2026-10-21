import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startFixtureServer } from './fixture-server.mjs';
import { identifyBrowser } from '../tools/browser-identity.mjs';
import { bunWebViewPin, bunWebViewNativeLaunchPolicy, bunWebViewError, requireBunWebViewRuntime, bunWebViewOptions, createBunWebViewSession, bunWebViewDraftClassifications, prepareBunWebViewWorkload } from './bun-webview-workloads.mjs';
import { verifyBunWebViewSample } from './bun-webview-sampling-contract.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export const bunWebViewSamplingSources = Object.freeze([
  'benchmarks/bun-webview-sampling.mjs', 'benchmarks/bun-webview-sampling-contract.mjs',
  'benchmarks/bun-webview-workloads.mjs', 'benchmarks/fixture-server.mjs',
  'tools/http-fixture.mjs', 'tools/browser-identity.mjs', 'benchmarks/configurations/baseline.json',
]);

/** Native library observations only; neither context equivalence nor process drain is inferred here. */
export async function sampleBunWebView(reportPath, browserPath, launchIndex) {
  requireBunWebViewRuntime(globalThis.Bun);
  assert.equal(process.platform, 'linux');
  const configuration = JSON.parse(await readFile('benchmarks/configurations/baseline.json', 'utf8'));
  assert.ok(Number.isInteger(launchIndex) && launchIndex >= 0 && launchIndex < configuration.independentLaunches);
  const readInputs = async () => Object.fromEntries(await Promise.all(bunWebViewSamplingSources.map(async path => [path, hash(await readFile(path))])));
  const inputs = await readInputs();
  const browser = await identifyBrowser(browserPath);
  assert.equal(browser.version, configuration.browserVersion);
  assert.equal(browser.distribution, 'chromium-headless-shell');
  const runtime = { ...bunWebViewPin, executable: process.execPath, sha256: hash(await readFile(process.execPath)) };
  const options = bunWebViewOptions(browser.executablePath, configuration.viewport);
  const report = {
    schemaVersion: 1, engine: 'bun-webview', classification: 'linux-native-chrome-library-observation',
    status: 'incomplete', runtime, browser, options, configuration, inputs,
    sampling: { launchIndex, reportPersistence: 'after-completion', isolationProbe: 'separate-admission', protocolLogging: 'off' },
    nativeLaunchPolicy: bunWebViewNativeLaunchPolicy, classifications: bunWebViewDraftClassifications(),
    equivalentWorkAdmission: false, resourceAdmission: false, performanceAccepted: false,
    timing: 'Samples include native workload calls and outcome assertions; setup samples also include fresh-view creation and their close request. Other preparation, observation and close requests are separate. Complete host time includes fixture startup and cleanup requests; only an external collector can observe process drain. Identity checks and report writes are outside host time but inside the external command interval.',
    cleanupMechanism: 'Unacknowledged view.close requests followed by native WebView.closeAll SIGKILL; not graceful browser shutdown.',
    workloads: [], failures: [],
  };
  // Reserve the output before opening a browser; never overwrite an earlier attempt.
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  const started = performance.now();
  let server;
  let session;
  try {
    server = await startFixtureServer(configuration.backendDelayMilliseconds);
    session = createBunWebViewSession(Bun.WebView, options);
    const offset = launchIndex % configuration.workloads.length;
    const order = configuration.workloads.slice(offset).concat(configuration.workloads.slice(0, offset));
    for (const name of order) {
      const record = { name, samples: [], warmupSamples: [], failures: [] };
      report.workloads.push(record);
      const workloadStarted = performance.now();
      let workload;
      try {
        workload = await prepareBunWebViewWorkload(name, session, server.origin, configuration);
        record.preparationMilliseconds = performance.now() - workloadStarted;
        for (const [phase, count] of [['warmupSamples', configuration.warmupIterations], ['samples', configuration.measuredIterations]]) {
          for (let iteration = 0; iteration < count; iteration++) {
            const sampleStarted = performance.now();
            try {
              await workload.run();
              record[phase].push({ iteration, milliseconds: performance.now() - sampleStarted });
            } catch (error) {
              record.failures.push({ phase, iteration, milliseconds: performance.now() - sampleStarted, error: bunWebViewError(error) });
              throw error;
            }
          }
        }
        const observationStarted = performance.now();
        record.observations = await workload.observe();
        record.observationMilliseconds = performance.now() - observationStarted;
      } catch (error) {
        if (!record.failures.length) record.failures.push({ phase: 'preparation-or-observation', error: bunWebViewError(error) });
      } finally {
        const closeStarted = performance.now();
        try { await workload?.close(); } catch (error) { record.failures.push({ phase: 'cleanup', error: bunWebViewError(error) }); }
        record.closeRequestMilliseconds = performance.now() - closeStarted;
        record.completeMilliseconds = performance.now() - workloadStarted;
      }
      if (record.failures.length) break;
    }
  } catch (error) { report.failures.push(bunWebViewError(error)); }
  finally {
    const cleanupStarted = performance.now();
    try { session?.close(); } catch (error) { report.failures.push(bunWebViewError(error)); }
    try { await server?.close(); } catch (error) { report.failures.push(bunWebViewError(error)); }
    report.cleanupRequestMilliseconds = performance.now() - cleanupStarted;
    report.completeHostMilliseconds = performance.now() - started;
    report.backend = server?.counts;
    report.createdViews = session?.createdViews;
    try {
      assert.deepEqual(await readInputs(), inputs, 'Selected source bytes changed');
      assert.equal(hash(await readFile(process.execPath)), runtime.sha256, 'Runtime changed');
      assert.equal(hash(await readFile(browser.executablePath)), browser.sha256, 'Browser changed');
      report.selectedInputsUnchanged = true;
      report.status = 'completed-native-observations';
      verifyBunWebViewSample(report, configuration);
    } catch (error) { report.failures.push(bunWebViewError(error)); report.status = 'failed-native-observations'; }
    await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  assert.equal(process.argv.length, 4, 'Usage: bun benchmarks/bun-webview-sampling.mjs NEW_REPORT_PATH LAUNCH_INDEX');
  assert.ok(process.env.FLASHWRIGHT_BROWSER_PATH);
  const report = await sampleBunWebView(process.argv[2], process.env.FLASHWRIGHT_BROWSER_PATH, Number(process.argv[3]));
  console.log(JSON.stringify({ status: report.status, launchIndex: report.sampling.launchIndex, performanceAccepted: false }));
  process.exitCode = report.status === 'completed-native-observations' ? 0 : 1;
}
