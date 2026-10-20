import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { reconstructFinalGoalLinuxBackend, linuxBackendEvidenceLimits, linuxBackendBrowserProfile } from './final-goal-linux-backend.mjs';
import { createBackendCorpusReferenceConfigurationData } from './backend-corpus-reference.mjs';
import { createBackendCorpusCandidateConfigurationData } from './backend-corpus-candidate.mjs';
import { backendCorpusInventory } from './backend-corpus-common.mjs';
import { reconstructFinalGoalLinuxResourceEvidence } from './final-goal-linux-evidence.mjs';
import { verifyFinalGoalEvidence } from './verify-final-goal.mjs';
import { finalGoalHash } from '../benchmarks/final-goal-contract.mjs';

const fixture = JSON.parse(await readFile(new URL('../compatibility/evidence/fixtures/linux-cgroup-originals-synthetic.json', import.meta.url)));
const consumer = JSON.parse(await readFile(new URL('../compatibility/evidence/fixtures/backend-consumer-sources.json', import.meta.url)));
const policy = JSON.parse(await readFile(new URL('../crates/flashwright-browser/src/chromium-launch-policy.json', import.meta.url)));
const hash = b => createHash('sha256').update(b).digest('hex'), encode = value => Buffer.from(JSON.stringify(value));
const dependencyPaths = ['tools/backend-corpus-common.mjs', 'tools/backend-corpus-reference.mjs', 'tools/backend-corpus-candidate.mjs',
  'benchmarks/configurations/backend-corpus-inventory.json', 'tools/watchdog.py', 'benchmarks/native-backend-guard.mjs'];
const dependencies = Object.fromEntries(await Promise.all(dependencyPaths.map(async path => [path, await readFile(new URL('../' + path, import.meta.url))])));

// Native identities, clocks and observations are synthetic. Only licensed pinned consumer bytes are upstream source.
function bundle({ engine = 'flashwright', workers = 1, change = () => {} } = {}) {
  const originals = Object.fromEntries(Object.entries(fixture.originals).map(([name, bytes]) => [name, JSON.parse(bytes)]));
  const workspace = '/synthetic/missing', base = workspace + '/capture', directory = base + '/case', project = directory + '/project';
  const native = engine === 'flashwright', bun = workspace + '/.tools/bun-v1.4.2-linux-x64/bin/bun';
  const cli = workspace + (native ? '/packages/flashwright-test/cli.cjs' : '/node_modules/.bun/playwright@1.60.0/node_modules/playwright/cli.js');
  const browser = { path: '/synthetic/chrome', bytes: linuxBackendBrowserProfile.bytes, sha256: linuxBackendBrowserProfile.sha256 };
  const options = { frontendDirectory: project, outputDirectory: directory + '/test-output', jsonReportPath: directory + '/runner-report.json',
    browserExecutablePath: base + '/stock-browser', workers, ...(native ? { candidateWorkspace: workspace } : {}) };
  const aliases = { '@playwright/test': workspace + (native ? '/packages/flashwright-test' : '/node_modules/.bun/@playwright+test@1.60.0/node_modules/@playwright/test'),
    axios: '/synthetic/axios', dotenv: '/synthetic/dotenv' };
  const sourceBytes = Object.fromEntries(Object.entries(consumer.files).map(([name, text]) => [name, Buffer.from(text)]));
  const module = native ? 'backend-corpus-candidate.mjs' : 'backend-corpus-reference.mjs';
  const factory = native ? 'createBackendCorpusCandidateConfigurationData' : 'createBackendCorpusReferenceConfigurationData';
  const guard = native ? `
import { verifyBackendCorpusCandidateIdentity } from "file://${workspace}/tools/${module}";
import { forbidUpstreamBrowserBackend } from "file://${workspace}/benchmarks/native-backend-guard.mjs";
const requireCanonical = createRequire("${workspace}/package.json");
verifyBackendCorpusCandidateIdentity(frontend, requireCanonical('@flashwright/test'));
forbidUpstreamBrowserBackend();
` : `if (requireConsumer('@playwright/test/package.json').version !== '1.60.0') throw new Error('Reference version differs');\n`;
  const generated = {
    'package.json': Buffer.from(JSON.stringify({ name: `private-backend-${engine}-${workers}-stock`, private: true, type: 'module',
      description: 'Development consumer with explicitly recorded local dependency aliases; not packed installation.' }) + '\n'),
    'runner.config.mjs': Buffer.from(`import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { ${factory} } from "file://${workspace}/tools/${module}";
if (resolve(process.cwd()) !== "${project}") throw new Error('Wrong consumer working directory');
const requireConsumer = createRequire(import.meta.url);
const frontend = requireConsumer('@playwright/test');
${guard}
const options = ${JSON.stringify(options)};
options.backendURL = process.env.FLASHWRIGHT_BACKEND_URL;
const configuration = ${factory}(options);
configuration.projects[1].use = { ...frontend.devices['Desktop Chrome'], ...configuration.projects[1].use };
configuration.use.trace = 'on-first-retry';
export default frontend.defineConfig(configuration);
`),
  };
  let wrapper = Buffer.from(`#!/usr/bin/python3
"""Record the original launch and exec the pinned stock browser unchanged."""
import json
import os
import sys
from pathlib import Path

executable = Path('${browser.path}').resolve(strict=True)
record = Path(os.environ['FLASHWRIGHT_NATIVE_LAUNCH_DIRECTORY']) / (str(os.getpid()) + '.json')
with record.open('x') as stream:
    json.dump({'mode': 'stock', 'pid': os.getpid(), 'executable': str(executable),
        'argv': [str(executable), *sys.argv[1:]]}, stream, indent=2)
os.execv(executable, [str(executable), *sys.argv[1:]])
`);
  const prepared = { engine, workers, mode: 'stock', directory, project, options, aliases, expectedTests: 62,
    sources: Object.fromEntries(Object.entries(sourceBytes).map(([name, b]) => [name, hash(b)])),
    generated: Object.fromEntries(Object.entries(generated).map(([name, b]) => [name, hash(b)])),
    runnerCommand: [bun, cli, 'test', '--config', project + '/runner.config.mjs'], artifacts: { trace: 'on-first-retry', video: 'off', screenshot: 'off' },
    ownerCommand: ['/usr/bin/bwrap', '--unshare-user', '--unshare-net', '--bind', '/', '/', '--dev-bind', '/dev', '/dev', '--size', '268435456',
      '--tmpfs', directory + '/service-data', '--size', '134217728', '--tmpfs', '/dev/shm', '--proc', '/proc', '--cap-drop', 'ALL', '--', '/usr/bin/python3', '-B', base + '/owner.py', directory],
    browser, driverPath: '/synthetic/driver' };
  const urls = { api: 'http://127.0.0.1:32109', mail: 'http://127.0.0.1:8025' };
  const configuration = (native ? createBackendCorpusCandidateConfigurationData : createBackendCorpusReferenceConfigurationData)({ ...options, backendURL: urls.api });
  const wall = Date.parse('2026-01-01T00:00:00.000Z'); let chromiumIndex = 0, identityIndex = 0;
  const suites = backendCorpusInventory.files.map(file => ({ title: file.path, file: file.path.slice('frontend/tests/'.length), specs: file.declarations.map(declaration => {
    const index = file.projectName === 'setup' ? -1 : chromiumIndex++;
    return { id: 'synthetic-' + identityIndex++, title: declaration.title, file: file.path.slice('frontend/tests/'.length), line: declaration.line, column: 0, ok: true, tags: [],
      tests: [{ projectName: file.projectName, projectId: file.projectName, timeout: 30000, annotations: [], expectedStatus: 'passed', status: 'expected',
        results: [{ status: 'passed', retry: 0, duration: 5, workerIndex: index < 0 ? 0 : index % workers + 1, parallelIndex: index < 0 ? 0 : index % workers,
          startTime: new Date(wall + 3000 + (index + 1) * 10).toISOString(), errors: [], stdout: [], stderr: [], attachments: [] }] }] };
  }) }));
  const runner = { config: { configFile: project + '/runner.config.mjs', rootDir: project + '/tests', version: '1.60.0', fullyParallel: true, forbidOnly: true,
    workers, metadata: configuration.metadata, maxFailures: 0, globalTimeout: 0, globalSetup: null, globalTeardown: null, shard: null, webServer: null, grepInvert: null, grep: {}, reporter: configuration.reporter,
    projects: configuration.projects.map(p => ({ id: p.name, name: p.name, timeout: 30000, testIgnore: [],
      testMatch: p.name === 'setup' ? ['**/*.setup.ts'] : ['**/*.@(spec|test).?(c|m)[jt]s?(x)'], testDir: configuration.testDir, outputDir: configuration.outputDir, retries: 0, repeatEach: 1 })) },
    suites, errors: [], stats: { expected: 62, unexpected: 0, skipped: 0, flaky: 0, startTime: new Date(wall + 2500).toISOString(), duration: 5000 } };
  const auth = Buffer.from(JSON.stringify({ cookies: [], origins: [{ origin: urls.api, localStorage: [{ name: 'access_token', value: 'synthetic-only' }] }] }));
  const listener = { url: urls.api, process: 40, workers: 4 };
  const launches = Array.from({ length: workers + 1 }, (_, index) => ({ pid: 100 + index, mode: 'stock', executable: browser.path,
    argv: [browser.path, ...policy.headless.map(arg => arg.replace('__FLASHWRIGHT_PROFILE__', '/synthetic/profile-' + index))] }));
  const owner = { engine, workers, status: 'runner-completed-needs-verification', preparedSha256: hash(encode(prepared)), runnerExitCode: 0, runnerWatchdogExitCode: 0, cleanupErrors: [],
    runnerCommand: ['/usr/bin/python3', workspace + '/tools/watchdog.py', '--timeout', '180', '--report', directory + '/runner-resources.json', '--', ...prepared.runnerCommand],
    urls, authAbsentBeforeDispatch: true, authStateSha256: hash(auth), authStateModifiedNanoseconds: String(BigInt(wall + 4000) * 1000000n),
    clock: { schemaVersion: 1, type: 'monotonic', implementation: 'clock_gettime(CLOCK_MONOTONIC)', identity: originals.capture.captureIdentity, originNanoseconds: '200', resolutionSeconds: 1e-9 },
    events: ['services-start-requested', 'services-ready', 'runner-spawn-requested', 'runner-reaped', 'outputs-retained', 'service-close-requested', 'services-closed', 'owner-report-write-requested']
      .map((name, i) => ({ name, monotonicNanoseconds: String(250 + i * 10), wallTimeNanoseconds: String(BigInt(wall + [0, 1000, 2000, 10000, 10001, 10002, 10003, 10004][i]) * 1000000n) })),
    closedEndpointChecks: Object.entries(urls).map(([service, url]) => ({ service, url, errno: 111 })),
    services: { ready: true, listener, apiBirth: { pid: 40 }, mailUrl: urls.mail, cleaned: true, apiReaped: true, apiExitCode: 0, apiRemainingGroup: [], cleanupErrors: [],
      ownedServices: { postgres: { birth: { pid: 41 }, originalWait: { process: 41, status: 0, exitCode: 0 } }, mailpit: { birth: { pid: 42 }, originalWait: { process: 42, status: 0, exitCode: 0 } } } },
    processExecutableObservations: [...launches.map(row => ({ pid: row.pid, startTicks: String(row.pid + 200), parent: 300, executable: browser.path, argv: row.argv })),
      { pid: 300, executable: native ? prepared.driverPath : bun }] };
  const runnerResources = { schemaVersion: 2, rootPollCpu: { status: 'observed', method: 'atomic-wait4-original-owner', process: 301, exitCode: 0, waitStatus: 0, reapedNanoseconds: '275' },
    ownerLaunch: { process: 301 }, clock: { type: 'monotonic', implementation: 'clock_gettime(CLOCK_MONOTONIC)', originNanoseconds: '271' }, command: prepared.runnerCommand, timeoutSeconds: 180, exitCode: 0, timedOut: false, interrupted: false, cleanupSignals: [], remainingObservedProcesses: [] };
  const sources = [bun, cli, '/usr/bin/bwrap', '/usr/bin/python3', base + '/owner.py', base + '/service_stack_owned.py', ...Object.values(aliases).map(path => path + '/package.json')]
    .map(path => ({ path, resolvedPath: path, bytes: 1, sha256: 'a'.repeat(64) }));
  sources.push({ path: browser.path, resolvedPath: browser.path, bytes: browser.bytes, sha256: browser.sha256 });
  for (const [path, bytes] of Object.entries(dependencies)) sources.push({ path: workspace + '/' + path, resolvedPath: workspace + '/' + path, bytes: bytes.length, sha256: hash(bytes) });
  const data = { prepared, owner, runner, runnerResources, auth, listener, launches, sourceBytes, generated, wrapper, sources, originals };
  change(data); wrapper = data.wrapper;
  const files = new Map(), retain = (path, originalPath, bytes) => { files.set(path, bytes); return { path, originalPath, bytes: bytes.length, sha256: hash(bytes) }; };
  const preparedReceipt = retain('inputs/prepared.json', directory + '/prepared.json', encode(prepared));
  const members = Object.entries({ ...sourceBytes, ...generated }).map(([name, bytes]) => retain('inputs/project/' + name, project + '/' + name, bytes));
  const wrapperReceipt = retain('inputs/stock-browser', base + '/stock-browser', wrapper);
  const inputs = [preparedReceipt, ...members, wrapperReceipt].map(({ originalPath, bytes, sha256 }) => ({ path: originalPath, resolvedPath: originalPath, bytes, sha256 }));
  for (const phase of ['before', 'after']) {
    originals[phase].workloadCommand = prepared.ownerCommand;
    originals[phase].inputs = { executables: { runtime: { path: '/usr/bin/bwrap', resolvedPath: '/usr/bin/bwrap' }, browser: { ...browser, resolvedPath: browser.path },
      driver: { path: prepared.driverPath, resolvedPath: prepared.driverPath } }, files: [...sources, ...inputs] };
  }
  originals.native.originalWait.exitCode = 0; originals.native.originalWait.status = 0;
  originals.capture.native.originalWrapperWait = structuredClone(originals.native.originalWait);
  originals.capture.workloadCommand = prepared.ownerCommand;
  originals.capture.wrapperCommand.splice(-2, 2, ...prepared.ownerCommand);
  originals.capture.collectorCommand.splice(-2, 2, ...prepared.ownerCommand);
  originals.native.commandBytes = originals.capture.wrapperCommand;
  originals.capture.workloadClock = owner.clock;
  const outputs = [['owner-report.json', encode(owner)], ['runner-report.json', encode(runner)], ['runner-stdout.txt', Buffer.alloc(0)], ['runner-stderr.txt', Buffer.alloc(0)],
    ['runner-resources.json', encode(runnerResources)], ['native-launches.json', encode({ launches })], ['project/playwright/.auth/user.json', data.auth], ['listener.json', encode(listener)],
    ['api.log', Buffer.alloc(0)], ['postgres.log', Buffer.alloc(0)], ['mailpit.log', Buffer.alloc(0)]].map(([name, bytes]) => retain('outputs/' + name, directory + '/' + name, bytes));
  originals.capture.requestedOutputs = outputs.map(r => r.originalPath);
  originals.capture.capturedOutputs = outputs.map(({ originalPath, bytes, sha256 }) => ({ path: originalPath, resolvedPath: originalPath, bytes, sha256 }));
  const resourceManifest = { schemaVersion: 1, accountingClass: fixture.header.accountingClass, files: {} };
  for (const name of ['before', 'after', 'native']) {
    const { originalPath, ...r } = retain('originals/' + name + '.json', '/unused', encode(originals[name])); resourceManifest.files[name] = r;
    const key = name === 'native' ? 'nativeReceipt' : name; originals.capture[key] = { ...originals.capture[key], bytes: r.bytes, sha256: r.sha256 };
  }
  const { originalPath, ...captureReceipt } = retain('originals/capture.json', '/unused', encode(originals.capture)); resourceManifest.files.capture = captureReceipt;
  const outputManifest = { schemaVersion: 1, accountingClass: fixture.header.accountingClass, captureSha256: captureReceipt.sha256, outputs };
  const manifest = { schemaVersion: 1, accountingClass: fixture.header.accountingClass, captureSha256: captureReceipt.sha256,
    workspaceDirectory: workspace, prepared: preparedReceipt, consumer: members, wrapper: wrapperReceipt };
  const reads = [];
  return { files, reads, args: { resourceManifest, outputManifest, manifest, engine, workers, readBytes: async (receipt, limits) => {
    assert(!receipt.path.startsWith('/')); reads.push(receipt.path); const b = files.get(receipt.path); assert(b); assert.equal(b.length, limits.expectedSize); assert(b.length <= limits.maximumFileBytes); return b;
  } } };
}

for (const engine of ['playwright', 'flashwright']) for (const workers of [1, 4]) test(`retained backend ${engine}/${workers} validates without original paths`, async () => {
  const result = await reconstructFinalGoalLinuxBackend(bundle({ engine, workers }).args);
  assert.equal(result.tests.length, 62); assert.equal(result.originalConsumerFiles, 28); assert.equal(result.reportedWorkerIndexes, workers + 1);
  assert.equal(result.reportedBrowserLaunches, workers + 1); assert.equal(result.sourceBytesVerified, true);
  for (const key of ['callbackDispatchVerified', 'nativeContextOwnershipVerified', 'resourceAdmission', 'performanceAccepted']) assert.equal(result[key], false);
});
const first = d => d.runner.suites[0].specs[0], result = d => first(d).tests[0].results[0];
for (const [name, change] of [
  ['consumer bytes', d => d.sourceBytes['tests/utils/user.ts'] = Buffer.from('changed helper')],
  ['extra captured consumer source', d => d.sources.push({ path: d.prepared.project + '/tests/extra.spec.ts', resolvedPath: d.prepared.project + '/tests/extra.spec.ts', bytes: 1, sha256: 'a'.repeat(64) })],
  ['changed generated configuration', d => d.generated['runner.config.mjs'] = Buffer.from('changed configuration')],
  ['changed stock wrapper', d => d.wrapper = Buffer.from('changed wrapper')],
  ['factory dependency', d => d.sources.find(r => r.path.endsWith('backend-corpus-common.mjs')).sha256 = 'b'.repeat(64)],
  ['missing alias input', d => d.sources.splice(d.sources.findIndex(r => r.path.endsWith('/axios/package.json')), 1)],
  ['conflicting dependency alias', d => d.sources.push({ ...d.sources[0], path: '/alias', sha256: 'b'.repeat(64) })],
  ['borrowed prepared report', d => d.owner.preparedSha256 = 'b'.repeat(64)],
  ['changed runner command', d => d.owner.runnerCommand[2] = '--changed'],
  ['custom browser labelled stock', d => { d.prepared.browser.sha256 = 'b'.repeat(64); d.sources.find(r => r.path === d.prepared.browser.path).sha256 = 'b'.repeat(64); }],
  ['borrowed terminal owner', d => d.runnerResources.rootPollCpu.process++],
  ['terminal exit mismatch', d => d.runnerResources.rootPollCpu.exitCode = 1],
  ['terminal wait status', d => d.runnerResources.rootPollCpu.waitStatus = 256],
  ['late root reap', d => d.runnerResources.rootPollCpu.reapedNanoseconds = '999'],
  ['wrong terminal method', d => d.runnerResources.rootPollCpu.method = 'sampled'],
  ['borrowed runner resources', d => d.runnerResources.command = ['different']],
  ['test project identity', d => first(d).tests[0].projectId = 'foreign'],
  ['test timeout policy', d => first(d).tests[0].timeout = 1],
  ['hidden annotation', d => first(d).tests[0].annotations.push({ type: 'skip' })],
  ['unsuccessful spec', d => first(d).ok = false],
  ['missing original attempt', d => first(d).tests[0].results = []],
  ['retry', d => result(d).retry = 1],
  ['artifact during passing run', d => result(d).attachments.push({ path: '/foreign' })],
  ['worker outside slots', d => result(d).parallelIndex = 1],
  ['early reported test', d => result(d).startTime = '2000-01-01T00:00:00Z'],
  ['invalid report interval', d => d.runner.stats.duration = -1],
  ['not ready', d => d.owner.services.ready = false],
  ['wrong listener workers', d => d.listener.workers = 1],
  ['mail endpoint mismatch', d => d.owner.services.mailUrl = 'http://127.0.0.1:9000'],
  ['open endpoint', d => d.owner.closedEndpointChecks[0].errno = 0],
  ['wrong service terminal owner', d => d.owner.services.ownedServices.postgres.originalWait.process++],
  ['remaining API member', d => d.owner.services.apiRemainingGroup.push(1)],
  ['forced runner cleanup', d => d.runnerResources.cleanupSignals.push({ signal: 'SIGKILL' })],
  ['stale auth output', d => d.owner.authStateModifiedNanoseconds = '1'],
  ['auth present before run', d => d.owner.authAbsentBeforeDispatch = false],
  ['ambiguous auth JSON', d => { d.auth = Buffer.from('{"origins":[],"origins":[]}'); d.owner.authStateSha256 = hash(d.auth); }],
  ['auth hash mismatch', d => d.auth = Buffer.from('{}')],
  ['outside command event', d => d.owner.events[0].monotonicNanoseconds = '1'],
  ['wrong clock identity', d => d.owner.clock = { ...d.owner.clock, identity: 'b'.repeat(32) }],
  ['reordered owner events', d => d.owner.events.reverse()],
  ['duplicate launch', d => d.launches[1] = d.launches[0]],
  ['no complete argv', d => d.owner.processExecutableObservations[0].argv = []],
  ['changed process argv', d => d.owner.processExecutableObservations[0].argv = ['unexpected']],
  ['reused PID', d => d.owner.processExecutableObservations.push({ ...d.owner.processExecutableObservations[0], startTicks: '99999' })],
  ['missing browser parent', d => d.owner.processExecutableObservations.pop()],
  ['changed launch policy', d => d.launches[0].argv.push('--disable-extra')],
]) test('rejects backend mismatch: ' + name, async () => {
  await assert.rejects(() => reconstructFinalGoalLinuxBackend(bundle({ change }).args));
});
for (const [name, change] of [
  ['missing source', m => m.consumer.pop()], ['borrowed capture', m => m.captureSha256 = 'b'.repeat(64)],
  ['absolute retained path', m => m.prepared.path = '/absolute'], ['escaped path', m => m.wrapper.path = '../escape'],
  ['reused original', m => m.wrapper.originalPath = m.prepared.originalPath], ['reused retained', m => m.wrapper.path = m.prepared.path],
  ['oversize member', m => m.prepared.bytes = linuxBackendEvidenceLimits.maximumFileBytes + 1],
  ['oversize aggregate', m => { for (const r of m.consumer) r.bytes = linuxBackendEvidenceLimits.maximumFileBytes; }],
  ['wrong workspace', m => m.workspaceDirectory = 'relative'], ['extra key', m => m.admitted = true],
]) test('rejects backend manifest before any read: ' + name, async () => {
  const b = bundle(); change(b.args.manifest); await assert.rejects(() => reconstructFinalGoalLinuxBackend(b.args)); assert.equal(b.reads.length, 0);
});
test('reordered launches and an unavailable early argv sample retain complete original observations', async () => {
  const b = bundle({ change: d => { d.launches.reverse(); d.owner.processExecutableObservations.unshift({ ...d.owner.processExecutableObservations[0], argv: [] }); } });
  const r = await reconstructFinalGoalLinuxBackend(b.args); assert.equal(r.unavailableArgvSamples, 1);
});
test('unambiguous Chromium process-title representation passes without inventing argv boundaries', async () => {
  const b = bundle({ change: d => { d.owner.processExecutableObservations[0].argv = [d.launches[0].argv.join(' ')]; } });
  assert.equal((await reconstructFinalGoalLinuxBackend(b.args)).tests.length, 62);
});

test('nine-scenario draft integrates backend evidence without final admission', async () => {
  const b = bundle();
  const configuration = JSON.parse(await readFile(new URL('../benchmarks/configurations/final-goal-linux.json', import.meta.url)));
  const temporaryRoot = new URL('../workbench/final-goal-linux-backend-tests/', import.meta.url).pathname;
  await mkdir(temporaryRoot, { recursive: true }); const directory = await mkdtemp(join(temporaryRoot, 'draft-'));
  try {
    const save = async (path, value) => { const bytes = encode(value); await writeFile(join(directory, path), bytes); return { path, sha256: hash(bytes) }; };
    for (const [path, bytes] of b.files) { await mkdir(join(directory, path, '..'), { recursive: true }); await writeFile(join(directory, path), bytes); }
    const resources = await reconstructFinalGoalLinuxResourceEvidence(b.args.resourceManifest, b.args.readBytes);
    const report = { tests: [] }, evidence = [];
    for (const [kind, path, value] of [['report', 'report.json', report], ['resources', 'resources.json', resources],
      ['linux-cgroup-originals', 'originals.json', b.args.resourceManifest], ['linux-captured-outputs', 'outputs.json', b.args.outputManifest],
      ['linux-backend-workload', 'backend.json', b.args.manifest]]) evidence.push({ kind, ...await save(path, value) });
    const campaign = { schemaVersion: 1, configuration: await save('configuration.json', configuration),
      declaration: await save('declaration.json', { schemaVersion: 1, status: 'draft', configurationSha256: finalGoalHash(configuration),
        accountingClass: configuration.accountingClass, resourceContext: { accountingClass: configuration.accountingClass } }), scenarios: [] };
    let selected;
    for (const scenario of configuration.scenarios) {
      const result = { id: scenario.id, cells: configuration.cells.map((cell, index) => scenario.id === 'application-backend-corpus' && index === 0
        ? { id: cell.id, status: 'noncomparable', reason: 'Synthetic passing backend; final admission absent', attempts: [{ runs: { flashwright: { report, resources, evidence } } }] }
        : { id: cell.id, status: 'unmeasured', attempts: [] }) };
      if (scenario.id === 'application-backend-corpus') selected = result;
      campaign.scenarios.push({ ...await save(scenario.id + '.json', result), scenarioId: scenario.id });
    }
    await save('campaign.json', campaign);
    const verified = await verifyFinalGoalEvidence(directory);
    assert.equal(verified.analysis.goalAccepted, false); assert.equal(verified.analysis.declaredScenarioCount, 9);
    assert.equal(verified.linuxBackendOutcomes.length, 1); assert.equal(verified.linuxBackendOutcomes[0].tests.length, 62);
    assert.equal(verified.linuxBackendOutcomes[0].performanceAccepted, false);
    assert.equal((await verifyFinalGoalEvidence(directory, { maximumAggregateJsonBytes: verified.inputBudget.aggregateJsonBytes })).analysis.goalAccepted, false);
    await assert.rejects(() => verifyFinalGoalEvidence(directory, { maximumAggregateJsonBytes: verified.inputBudget.aggregateJsonBytes - 1 }), /Aggregate JSON byte budget/);
    assert.deepEqual(verified.linuxApplicationOutcomes, []); assert.deepEqual(verified.linuxControlledFamilyOutcomes, []);
    const originalEvidence = [...evidence];
    const refresh = async () => {
      Object.assign(campaign.scenarios.find(s => s.scenarioId === 'application-backend-corpus'), await save('application-backend-corpus.json', selected));
      await save('campaign.json', campaign);
    };
    for (const [change, expected] of [
      [() => evidence.push(originalEvidence.at(-1)), /unique Linux backend/],
      [() => evidence.splice(evidence.findIndex(r => r.kind === 'linux-captured-outputs'), 1), /require captured outputs/],
      [() => evidence.push({ ...originalEvidence.at(-1), kind: 'linux-controlled-family' }), /Cannot mix/],
    ]) {
      change(); await refresh(); await assert.rejects(() => verifyFinalGoalEvidence(directory), expected);
      evidence.splice(0, evidence.length, ...originalEvidence);
    }
    const receipt = evidence.at(-1);
    for (const key of ['schemaVersion', 'schema\\u0056ersion']) {
      const bytes = Buffer.from('{"' + key + '":2,' + JSON.stringify(b.args.manifest).slice(1));
      await writeFile(join(directory, receipt.path), bytes); receipt.sha256 = hash(bytes); await refresh();
      await assert.rejects(() => verifyFinalGoalEvidence(directory), /Duplicate application JSON property/);
    }
    Object.assign(receipt, await save(receipt.path, b.args.manifest)); await refresh();
    await assert.rejects(() => verifyFinalGoalEvidence(directory, { maximumAggregateJsonBytes: 1024 }), /Aggregate JSON byte budget/);
    await writeFile(join(directory, b.args.manifest.consumer[0].path), Buffer.from('substituted consumer'));
    await assert.rejects(() => verifyFinalGoalEvidence(directory));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
