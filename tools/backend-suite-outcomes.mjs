import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { decodeLinuxApplicationJson } from './final-goal-linux-json.mjs';
import { analyzeBackendCorpusReferenceReport } from './backend-corpus-reference.mjs';
import { analyzeBackendCorpusCandidateReport } from './backend-corpus-candidate.mjs';

/** Verify the passing owned-backend profile; reported state is not native ownership attestation. */
export function verifyBackendSuiteOutcomes({ prepared, owner, runner, runnerResources, authBytes, engine, workers }) {
  assert(['playwright', 'flashwright'].includes(engine));
  assert([1, 4].includes(workers));
  assert.equal(prepared.engine, engine); assert.equal(prepared.workers, workers);
  assert.equal(owner.engine, engine); assert.equal(owner.workers, workers);
  assert.equal(prepared.expectedTests, 62);
  assert.equal(prepared.mode, 'stock');
  assert.equal(prepared.project, posix.join(prepared.directory, 'project'));
  assert.deepEqual(prepared.artifacts, { trace: 'on-first-retry', video: 'off', screenshot: 'off' });
  const options = { ...prepared.options, backendURL: owner.urls.api };
  assert.equal(options.frontendDirectory, prepared.project);
  assert.equal(options.outputDirectory, posix.join(prepared.directory, 'test-output'));
  assert.equal(options.jsonReportPath, posix.join(prepared.directory, 'runner-report.json'));
  assert.equal(options.workers, workers);
  const analyze = engine === 'playwright' ? analyzeBackendCorpusReferenceReport : analyzeBackendCorpusCandidateReport;
  const analysis = analyze(runner, options);
  assert(analysis.allTestsPassed, 'Incomplete, changed or unsuccessful original backend corpus: ' + JSON.stringify({ configuration: analysis.configurationIssues, report: analysis.reportIssues, outcomes: analysis.outcomeCounts }));
  const configuration = runner.config;
  assert.equal(configuration.configFile, posix.join(prepared.project, 'runner.config.mjs'));
  assert.equal(configuration.rootDir, posix.join(prepared.project, 'tests'));
  assert.equal(configuration.version, '1.60.0');
  assert.equal(configuration.fullyParallel, true); assert.equal(configuration.forbidOnly, true);
  for (const key of ['maxFailures', 'globalTimeout']) assert.equal(configuration[key], 0);
  for (const key of ['globalSetup', 'globalTeardown', 'shard', 'webServer', 'grepInvert']) assert.equal(configuration[key], null);
  assert.deepEqual(configuration.grep, {});
  assert.deepEqual(configuration.reporter, [['json', { outputFile: options.jsonReportPath }]]);
  for (const project of configuration.projects) {
    assert.equal(project.id, project.name);
    assert.equal(project.timeout, 30000);
    assert.deepEqual(project.testIgnore, []);
    assert.deepEqual(project.testMatch, project.name === 'setup' ? ['**/*.setup.ts'] : ['**/*.@(spec|test).?(c|m)[jt]s?(x)']);
  }
  const setup = analysis.records.filter(record => record.projectName === 'setup');
  const chromium = analysis.records.filter(record => record.projectName === 'chromium');
  assert.equal(setup.length, 1); assert.equal(chromium.length, 61);
  const setupResult = setup[0].results[0];
  const setupEnd = Date.parse(setupResult.startTime) + setupResult.duration;
  assert(Number.isFinite(setupEnd));
  const slots = new Map();
  for (const record of analysis.records) {
    assert.equal(record.expectedStatus, 'passed');
    assert.equal(record.projectId, record.projectName);
    assert.equal(record.originalTest.timeout, 30000);
    assert.deepEqual(record.originalTest.annotations, []);
    assert.equal(record.originalSpec.ok, true);
    assert.deepEqual(record.originalSpec.tags, []);
    const result = record.results[0];
    assert.deepEqual(result.errors, []);
    assert.equal(result.error, undefined);
    assert.deepEqual(result.attachments, [], 'Passing on-first-retry profile must not retain retry artifacts');
    assert(Number.isFinite(result.duration) && result.duration >= 0);
    assert(Number.isFinite(Date.parse(result.startTime)));
    assert(Number.isSafeInteger(result.workerIndex) && result.workerIndex >= 0);
    assert(Number.isSafeInteger(result.parallelIndex) && result.parallelIndex >= 0 && result.parallelIndex < workers);
    if (slots.has(result.workerIndex)) assert.equal(slots.get(result.workerIndex), result.parallelIndex, 'Reported worker changed parallel slot');
    slots.set(result.workerIndex, result.parallelIndex);
    if (record.projectName === 'chromium') {
      assert.notEqual(result.workerIndex, setupResult.workerIndex, 'Setup must retain its distinct project worker');
      assert(Date.parse(result.startTime) >= setupEnd, 'Dependent test precedes setup completion');
    }
  }
  assert.equal(slots.size, workers + 1);
  assert.equal(new Set(chromium.map(record => record.results[0].workerIndex)).size, workers);
  assert.deepEqual([...new Set(chromium.map(record => record.results[0].parallelIndex))].sort((a, b) => a - b), Array.from({ length: workers }, (_, i) => i));
  assert.equal(owner.status, 'runner-completed-needs-verification');
  assert.equal(owner.runnerExitCode, 0); assert.equal(owner.runnerWatchdogExitCode, 0);
  assert.deepEqual(owner.cleanupErrors, []);
  assert.equal(runnerResources.exitCode, 0);
  assert.equal(runnerResources.timedOut, false); assert.equal(runnerResources.interrupted, false);
  assert.deepEqual(runnerResources.cleanupSignals, []); assert.deepEqual(runnerResources.remainingObservedProcesses, []);
  assert.equal(owner.services.ready, true);
  assert.equal(owner.services.listener.url, owner.urls.api);
  assert.equal(owner.services.listener.workers, 4);
  assert.equal(owner.services.listener.process, owner.services.apiBirth.pid);
  assert.equal(owner.services.mailUrl, owner.urls.mail);
  assert.deepEqual(runnerResources.command, prepared.runnerCommand);
  assert.equal(runnerResources.timeoutSeconds, 180);
  assert.equal(owner.services.cleaned, true); assert.equal(owner.services.apiReaped, true);
  assert.equal(owner.services.apiExitCode, 0); assert.deepEqual(owner.services.apiRemainingGroup, []);
  assert.deepEqual(owner.services.cleanupErrors, []);
  assert.deepEqual(Object.keys(owner.services.ownedServices).sort(), ['mailpit', 'postgres']);
  for (const service of Object.values(owner.services.ownedServices)) {
    assert(Number.isSafeInteger(service.birth.pid) && service.birth.pid > 0);
    assert.equal(service.originalWait.process, service.birth.pid); assert.equal(service.originalWait.exitCode, 0);
    assert.equal(service.originalWait.status, 0);
  }
  assert.deepEqual(owner.closedEndpointChecks.map(row => row.service).sort(), ['api', 'mail']);
  for (const row of owner.closedEndpointChecks) { assert.equal(row.url, owner.urls[row.service]); assert.equal(row.errno, 111); }
  assert.equal(owner.authAbsentBeforeDispatch, true);
  assert(Buffer.isBuffer(authBytes) && authBytes.length > 0 && authBytes.length <= 1024 ** 2);
  assert.equal(createHash('sha256').update(authBytes).digest('hex'), owner.authStateSha256, 'Original auth state bytes changed');
  const auth = decodeLinuxApplicationJson(authBytes);
  assert(Array.isArray(auth.origins));
  const origins = auth.origins.filter(origin => origin.origin === owner.urls.api);
  assert.equal(origins.length, 1);
  const tokens = origins[0].localStorage.filter(item => item.name === 'access_token');
  assert.equal(tokens.length, 1); assert(typeof tokens[0].value === 'string' && tokens[0].value.length > 0);
  const event = name => {
    const rows = owner.events.filter(row => row.name === name); assert.equal(rows.length, 1); return rows[0];
  };
  const timestamp = value => { assert(typeof value === 'string' && /^[1-9][0-9]{0,29}$/.test(value)); return BigInt(value); };
  assert.equal(runnerResources.schemaVersion, 2);
  const terminal = runnerResources.rootPollCpu;
  assert.equal(terminal.status, 'observed'); assert.equal(terminal.method, 'atomic-wait4-original-owner');
  assert(Number.isSafeInteger(terminal.process) && terminal.process > 0);
  assert.equal(terminal.process, runnerResources.ownerLaunch.process);
  assert.equal(terminal.exitCode, runnerResources.exitCode); assert.equal(terminal.waitStatus, 0);
  assert.equal(runnerResources.clock.type, 'monotonic');
  assert.equal(runnerResources.clock.implementation, owner.clock.implementation);
  const runnerStart = timestamp(event('runner-spawn-requested').monotonicNanoseconds);
  const runnerEnd = timestamp(event('runner-reaped').monotonicNanoseconds);
  const reaped = timestamp(terminal.reapedNanoseconds), origin = timestamp(runnerResources.clock.originNanoseconds);
  assert(origin >= runnerStart && origin <= reaped && reaped <= runnerEnd, 'Original runner wait escapes owner interval');
  const authTime = timestamp(owner.authStateModifiedNanoseconds);
  assert(authTime >= timestamp(event('runner-spawn-requested').wallTimeNanoseconds)
    && authTime <= timestamp(event('runner-reaped').wallTimeNanoseconds), 'Auth state was not written inside the reported runner interval');
  // Reporter milliseconds are rounded and remain distinct from the native monotonic clock.
  const earliest = Number(timestamp(event('runner-spawn-requested').wallTimeNanoseconds) / 1000000n);
  const latest = Number(timestamp(event('runner-reaped').wallTimeNanoseconds) / 1000000n) + 1;
  const checkInterval = (startTime, duration) => {
    const start = Date.parse(startTime);
    assert(Number.isSafeInteger(start) && Number.isFinite(duration) && duration >= 0);
    assert(start >= earliest && start + duration <= latest, 'Reported interval escapes original runner wall interval');
    return { start, end: start + duration };
  };
  checkInterval(runner.stats.startTime, runner.stats.duration);
  const intervals = new Map();
  for (const record of analysis.records) {
    const result = record.results[0], interval = checkInterval(result.startTime, result.duration);
    const values = intervals.get(result.workerIndex) ?? []; values.push(interval); intervals.set(result.workerIndex, values);
  }
  for (const values of intervals.values()) {
    values.sort((a, b) => a.start - b.start);
    for (let index = 1; index < values.length; index++) assert(values[index].start + 1 >= values[index - 1].end, 'Reported worker test intervals overlap');
  }
  return { schemaVersion: 1, status: 'verified-reported-backend-suite-outcomes', engine, workers,
    originalTests: 62, setupTests: 1, chromiumTests: 61, reportedWorkerIndexes: slots.size,
    authStateBytesVerified: true, reportedServiceClosureVerified: true,
    tests: analysis.records.map(record => ({ id: record.id, title: record.title, file: record.originalFile, line: record.line,
      project: record.projectName, status: record.actualStatus, workerIndex: record.results[0].workerIndex, parallelIndex: record.results[0].parallelIndex })),
    sourceBytesVerified: false, callbackDispatchVerified: false, nativeContextOwnershipVerified: false,
    resourceAdmission: false, performanceAccepted: false,
    scope: 'Pinned passing backend report/configuration, setup dependency ordering, reported worker slots, original auth bytes and reported service closure. Executed source/configuration bytes, actual callback/native ownership, capture clocks and final admission require separate verification.' };
}
