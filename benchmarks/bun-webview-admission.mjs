import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, readlink, realpath, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout } from 'node:timers/promises';
import { startFixtureServer } from './fixture-server.mjs';
import { identifyBrowser } from '../tools/browser-identity.mjs';
import { bunWebViewPin, bunWebViewNativeLaunchPolicy, bunWebViewError, requireBunWebViewRuntime, bunWebViewOptions, createBunWebViewSession, bunWebViewDraftClassifications, prepareBunWebViewWorkload } from './bun-webview-workloads.mjs';
import { probeBunWebViewIsolation, probeBunWebViewInput, probeBunWebViewLifetime } from './bun-webview-controls.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');

/** Diagnostic live identities only. This neither measures resources nor proves complete custody. */
export async function observeBunWebViewProcesses(browserPath, label) {
  if (process.platform !== 'linux') return { label, status: 'unsupported-platform', processes: [] };
  const executable = await realpath(browserPath);
  const records = [];
  for (const entry of await readdir('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const fields = (await readFile(`/proc/${entry}/stat`, 'utf8')).split(/\) /).at(-1).trim().split(/\s+/);
      records.push({ pid: Number(entry), parent: Number(fields[1]), state: fields[0], startTicks: fields[19] });
    } catch (error) { if (!['ENOENT', 'ESRCH', 'EACCES', 'EPERM'].includes(error.code)) throw error; }
  }
  const owned = new Set([process.pid]);
  for (let changed = true; changed;) {
    changed = false;
    for (const record of records) if (owned.has(record.parent) && !owned.has(record.pid)) { owned.add(record.pid); changed = true; }
  }
  const processes = [];
  for (const record of records.filter(record => record.pid !== process.pid && owned.has(record.pid))) {
    try {
      const path = await readlink(`/proc/${record.pid}/exe`);
      if (path !== executable) continue;
      const command = await readFile(`/proc/${record.pid}/cmdline`);
      const finalFields = (await readFile(`/proc/${record.pid}/stat`, 'utf8')).split(/\) /).at(-1).trim().split(/\s+/);
      assert.equal(finalFields[19], record.startTicks, 'Process identity changed during observation');
      assert.equal(Number(finalFields[1]), record.parent, 'Process parent changed during observation');
      processes.push({ ...record, executable: path, executableSha256: hash(await readFile(`/proc/${record.pid}/exe`)), commandLine: {
        source: '/proc/PID/cmdline', representation: 'uninterpreted-proc-bytes-may-be-overwritten-process-title',
        rawBase64: command.toString('base64'), nulSeparatedUtf8Fields: command.toString('utf8').split('\0'), originalArgvVerified: false,
      } });
    } catch (error) { if (!['ENOENT', 'ESRCH', 'EACCES', 'EPERM'].includes(error.code)) throw error; }
  }
  return { label, status: 'diagnostic-snapshot', processes, limitation: 'Racy descendant snapshot; exited, reparented or unsampled processes may be absent. Not a resource or cleanup admission.' };
}

export async function runBunWebViewDraft(destination, browserPath, runtime = globalThis.Bun) {
  requireBunWebViewRuntime(runtime);
  assert.equal(process.platform, 'linux', 'This draft targets native Linux with the pinned headless shell');
  destination = resolve(destination);
  const configuration = JSON.parse(await readFile('benchmarks/configurations/baseline.json', 'utf8'));
  const browser = await identifyBrowser(browserPath);
  assert.equal(browser.version, configuration.browserVersion);
  assert.equal(browser.distribution, 'chromium-headless-shell');
  const options = bunWebViewOptions(browser.executablePath, configuration.viewport);
  await mkdir(destination);
  const reportPath = join(destination, 'draft-admission.json');
  const paths = ['benchmarks/bun-webview-admission.mjs', 'benchmarks/bun-webview-controls.mjs', 'benchmarks/bun-webview-workloads.mjs', 'benchmarks/fixture-server.mjs', 'tools/http-fixture.mjs', 'tools/browser-identity.mjs', 'benchmarks/configurations/baseline.json'];
  const readInputs = async () => Object.fromEntries(await Promise.all(paths.map(async path => [path, hash(await readFile(path))])));
  const inputs = await readInputs();
  const runtimeSha256 = hash(await readFile(process.execPath));
  const report = {
    schemaVersion: 1, engine: 'bun-webview', status: 'incomplete', runtime: { ...bunWebViewPin, executable: process.execPath, sha256: runtimeSha256 },
    browser, options, inputs, configuration, nativeLaunchPolicy: bunWebViewNativeLaunchPolicy, iterationsPerWorkload: 2, classifications: bunWebViewDraftClassifications(),
    functionalAdmissionPassed: false, resourceAdmission: false, performanceAccepted: false,
    scope: 'Draft functional observations only; no comparative timing samples. All admission decisions remain with the project lead.',
    cleanupMechanism: 'view.close requests Target.closeTarget without acknowledgement; final native WebView.closeAll sends SIGKILL to the shared Chrome process. Collector must independently verify original teardown.',
    controls: {}, workloads: [], failures: [],
  };
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  const save = () => writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  let session;
  let server;
  let shutdownRequested = false;
  try {
    server = await startFixtureServer(configuration.backendDelayMilliseconds);
    session = createBunWebViewSession(runtime.WebView, options);
    const observe = label => observeBunWebViewProcesses(browser.executablePath, label);
    for (const [name, probe] of [
      ['isolation', () => probeBunWebViewIsolation(session, server.origin, observe)],
      ['input', () => probeBunWebViewInput(session, server.origin)],
      ['lifetime', () => probeBunWebViewLifetime(session, server.origin, observe)],
    ]) {
      process.stderr.write(`bun-webview draft: ${name}\n`);
      report.controls[name] = await probe();
      await save();
    }
    report.controls.liveBrowserBeforeWorkloads = await observe('before-seven-workloads');
    const countsBeforeWorkloads = structuredClone(server.counts);
    for (const name of configuration.workloads) {
      process.stderr.write(`bun-webview draft: ${name}\n`);
      const record = { name, completedIterations: 0, observations: null, failures: [] };
      report.workloads.push(record);
      let workload;
      try {
        workload = await prepareBunWebViewWorkload(name, session, server.origin, configuration);
        for (let iteration = 0; iteration < report.iterationsPerWorkload; iteration++) { await workload.run(); record.completedIterations++; }
        record.observations = await workload.observe();
      } catch (error) { record.failures.push(bunWebViewError(error)); }
      finally {
        try { await workload?.close(); } catch (error) { record.failures.push(bunWebViewError(error)); }
        await save();
      }
      if (record.failures.length) break;
    }
    report.workloadRequests = Object.fromEntries(Object.keys(server.counts).map(key => [key, server.counts[key] - countsBeforeWorkloads[key]]));
    report.controls.beforeFinalShutdown = await observe('before-native-closeAll');
    shutdownRequested = true;
    session.close();
    await setTimeout(50);
    report.controls.afterFinalShutdown = await observe('50ms-after-native-closeAll');
  } catch (error) { report.failures.push(bunWebViewError(error)); }
  finally {
    if (session && !shutdownRequested) {
      try { session.close(); } catch (error) { report.failures.push(bunWebViewError(error)); }
    }
    try { await server?.close(); } catch (error) { report.failures.push(bunWebViewError(error)); }
    report.requests = server?.counts;
    report.createdViews = session?.createdViews;
    try {
      assert.deepEqual(await readInputs(), inputs, 'Draft source changed during the probe');
      assert.equal(hash(await readFile(process.execPath)), runtimeSha256, 'Runtime bytes changed');
      assert.equal(hash(await readFile(browser.executablePath)), browser.sha256, 'Browser bytes changed');
      report.declaredInputsUnchanged = true;
    } catch (error) { report.failures.push(bunWebViewError(error)); report.declaredInputsUnchanged = false; }
    report.status = report.failures.length || report.workloads.length !== 7 || report.workloads.some(workload => workload.failures.length || workload.completedIterations !== 2) ? 'failed-draft-probe' : 'completed-draft-observations';
    await save();
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  assert.equal(process.argv.length, 3, 'Usage: bun benchmarks/bun-webview-admission.mjs NEW_OUTPUT_DIRECTORY');
  assert.ok(process.env.FLASHWRIGHT_BROWSER_PATH, 'Select the pinned stock Chromium headless shell');
  const report = await runBunWebViewDraft(process.argv[2], process.env.FLASHWRIGHT_BROWSER_PATH);
  console.log(JSON.stringify({ status: report.status, functionalAdmissionPassed: false, resourceAdmission: false, performanceAccepted: false }));
  process.exitCode = report.status === 'completed-draft-observations' ? 0 : 1;
}
