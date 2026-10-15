import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { test } from 'node:test';
import { analyzeFinalGoal, finalGoalHash, finalGoalResourceVerifierPaths, renderFinalGoalReport } from '../benchmarks/final-goal-contract.mjs';
import { finalGoalEvidenceLimits, verifyFinalGoalEvidence } from './verify-final-goal.mjs';
import { attachSyntheticResourceOriginals, retainSyntheticCampaign } from './final-goal-synthetic-fixture.mjs';

const temporaryRoot = fileURLToPath(new URL('../workbench/final-goal-contract/', import.meta.url));
await mkdir(temporaryRoot, { recursive: true });

const draft = JSON.parse(await readFile(new URL('../benchmarks/configurations/final-goal.json', import.meta.url), 'utf8'));
const hash = value => createHash('sha256').update(value).digest('hex');
const receipt = path => ({ path, sha256: hash(path) });

/** Synthetic policy evidence only; these records never represent measured browser or collector admission. */
function fixture(winningIds = draft.scenarios.map(scenario => scenario.id)) {
  const configuration = structuredClone(draft);
  configuration.status = 'sealed';
  for (const scenario of configuration.scenarios) {
    scenario.sourceManifest = { 'fixture-suite.ts': hash(scenario.id) };
    scenario.applicationPolicySha256 = hash(`${scenario.id}-policy`);
    scenario.previouslySupported = { 'single-worker': false, 'matched-throughput': false };
    scenario.expectedTests = Array.from({ length: scenario.expectedTestCount }, (_, index) => ({
      id: `${scenario.id}/test/${index}`, bodySha256: hash(`${scenario.id}/${index}`),
      outcome: scenario.id === 'runner-failure' ? 'intentional-failure' : 'passed', observations: { originalApplicationWork: true },
      ...(scenario.id === 'runner-failure' ? { diagnosticIdentity: { selector: '#missing', timeout: 250, originalCallSite: index } } : {}),
    }));
  }
  const declaration = { status: 'sealed', configurationSha256: finalGoalHash(configuration),
    sourceManifest: { 'fixture-source.mjs': hash('source'), 'fixture-collector.mjs': hash('collector'),
      ...Object.fromEntries(finalGoalResourceVerifierPaths.map(path => [path, hash(`synthetic-source/${path}`)])),
      'fixture-lifecycle.mjs': hash('synthetic-lifecycle-producer'),
      ...Object.fromEntries(configuration.requiredGateIds.map(id => [`${id}.mjs`, hash(id)])) }, dependencyManifest: { 'fixture-package.json': hash('dependencies') },
    runtimeSha256: hash('bun'), browserSha256: hash('browser'), driverSha256: hash('driver'), resourceCollectorSha256: hash('collector'), resourceCollectorPath: 'fixture-collector.mjs',
    lifecycleProducerPath: 'fixture-lifecycle.mjs', lifecycleProducerSha256: hash('synthetic-lifecycle-producer'),
    host: { logicalCpuCount: 11, physicalMemoryBytes: 36 * 1024 ** 3, identitySha256: hash('host'), bootIdentitySha256: hash('boot') },
    launcherSha256: { playwright: hash('reference-launcher'), flashwright: hash('candidate-launcher') },
    approvalEvidence: [receipt('approval.json')], gates: configuration.requiredGateIds.map(id => ({ id, status: 'passed',
      verifierPath: `${id}.mjs`, verifierSha256: hash(id), evidence: [receipt(`${id}.json`)] })) };
  const scenarioResults = configuration.scenarios.map((scenario, scenarioIndex) => ({ id: scenario.id,
    cells: configuration.cells.map((cell, cellIndex) => ({ id: cell.id, status: 'comparable', attempts: Array.from({ length: 8 }, (_, launchIndex) => {
      const order = launchIndex % 2 ? ['flashwright', 'playwright'] : ['playwright', 'flashwright'];
      const runs = {};
      for (const engine of order) {
        const rotatedPosition = (scenarioIndex - launchIndex % configuration.scenarios.length + configuration.scenarios.length) % configuration.scenarios.length;
        const start = 1000 + launchIndex * 20000000 + rotatedPosition * 1000000 + cellIndex * 100000 + order.indexOf(engine) * 900;
        const duration = engine === 'playwright' ? 600 : winningIds.includes(scenario.id) ? 200 : 500;
        const ownedProcesses = Array.from({ length: cell.workers }, (_, index) => ({ identity: `fixture/${index + 1}/${start}`,
          namespace: 'fixture', processId: index + 1, startIdentity: String(start), components: ['workers'] }));
        for (const [index, component] of scenario.requiredResourceComponents.filter(component => component !== 'workers').entries())
          ownedProcesses.push({ identity: `fixture/${index + 100}/${start}`, namespace: 'fixture', processId: index + 100,
            startIdentity: String(start), components: [component] });
        const samples = [{ timestampMilliseconds: start - 1, processes: [] }, { timestampMilliseconds: start + 5,
          processes: ownedProcesses.map(process => ({ identity: process.identity, residentBytes: 1000, cpuSeconds: 0.1 })) },
        { timestampMilliseconds: start + duration + 1, processes: [] }];
        const observedCpu = samples[1].processes.reduce((total, process) => total + process.cpuSeconds, 0);
        const report = { engine, comparisonClass: configuration.comparisonClass, scenarioId: scenario.id, cellId: cell.id,
          identity: { configurationSha256: declaration.configurationSha256, platform: 'darwin', architecture: 'arm64', runtime: configuration.runtime,
            runtimeSha256: declaration.runtimeSha256, browserVersion: configuration.browserVersion, browserSha256: declaration.browserSha256,
            driverSha256: declaration.driverSha256, hostIdentitySha256: declaration.host.identitySha256, referenceVersion: configuration.referenceVersion,
            sourceManifest: declaration.sourceManifest, dependencyManifest: declaration.dependencyManifest, scenarioSourceManifest: scenario.sourceManifest,
            workers: cell.workers, artifacts: structuredClone(scenario.artifacts), scheduling: scenario.scheduling[cell.id], applicationPolicySha256: scenario.applicationPolicySha256 },
          ownerInterval: { startMilliseconds: start, endMilliseconds: start + duration }, completeMilliseconds: duration,
          clockBoundary: configuration.clockBoundary, fixtureInitializationInsideClock: true, allShutdownAndArtifactFlushInsideClock: true,
          unexpectedErrors: [], backgroundConfounds: [], runnerExitCode: scenario.id === 'runner-failure' ? 1 : 0,
          tests: scenario.expectedTests.map((expected, index) => ({ id: expected.id, bodySha256: expected.bodySha256,
            status: expected.outcome === 'intentional-failure' ? 'failed' : 'passed', attemptCount: 1, retry: 0,
            contextIdentity: `${start}/context/${index}`, workerIdentity: `${start}/logical-worker/${index % cell.workers}`,
            errors: expected.outcome === 'intentional-failure' ? [{ message: 'Original missing-element assertion failure' }] : [],
            interval: { startMilliseconds: start + 10 + Math.floor(index / cell.workers) * 2,
              endMilliseconds: start + 11 + Math.floor(index / cell.workers) * 2 }, observations: structuredClone(expected.observations),
            ...(expected.diagnosticIdentity ? { diagnostics: { identity: structuredClone(expected.diagnosticIdentity), originalPredicateRetained: true,
              evidence: [receipt(`${scenario.id}/${cell.id}/${launchIndex}/${engine}/failure-${index}.json`)] } } : {}) })) };
        const resources = { collectorSha256: declaration.resourceCollectorSha256, ownerExitCode: 0, timedOut: false, interrupted: false,
          remainingOwnedProcesses: [], cleanupSignals: [], missingRequiredProcessIdentities: [], ownedProcesses, samples, sampledConcurrentBytes: ownedProcesses.length * 1000,
          originalOwnerInclusiveCpuSeconds: observedCpu, captureInterval: { startMilliseconds: start - 1, endMilliseconds: start + duration + 1 },
          workerIntervals: ownedProcesses.filter(process => process.components.includes('workers')).map((process, index) => ({ identity: `${start}/logical-worker/${index}`, hostProcessIdentity: process.identity,
            startMilliseconds: start + 1, endMilliseconds: start + duration - 1 })) };
        runs[engine] = { report, resources, evidence: ['report', 'resources', 'watchdog', 'lifecycle', 'owner-tree'].map(kind => ({
          ...receipt(`${scenario.id}/${cell.id}/${launchIndex}/${engine}/${kind}.json`), kind })) };
        attachSyntheticResourceOriginals(runs[engine], declaration, scenario);
      }
      return { id: `${scenario.id}/${cell.id}/${launchIndex}`, launchIndex, order, runs };
    }) })) }));
  return { configuration, declaration, scenarioResults };
}

const candidate = state => state.scenarioResults[0].cells[0].attempts[0].runs.flashwright;
function updateResources(run) {
  run.resources.sampledConcurrentBytes = Math.max(...run.resources.samples.map(sample => sample.processes.reduce((total, process) => total + process.residentBytes, 0)));

}
function refreshConfiguration(state) {
  state.declaration.configurationSha256 = finalGoalHash(state.configuration);
  for (const scenario of state.scenarioResults) for (const cell of scenario.cells) for (const attempt of cell.attempts)
    for (const run of Object.values(attempt.runs ?? {})) run.report.identity.configurationSha256 = state.declaration.configurationSha256;
}
function nonwinner(status) {
  return { id: 'single-worker', status, reason: 'Original retained admission failure', evidence: [receipt('original-admission.json')],
    attempts: [{ failure: { code: 'UnsupportedFeatureError', message: 'Original unsupported feature failure' }, evidence: [receipt('original-attempt.json')] }] };
}

/** Retain a complete unmeasured draft inventory without inventing runtime admission. */
async function retainedDraft(directory) {
  const configuration = structuredClone(draft);
  const declaration = { status: 'draft', configurationSha256: finalGoalHash(configuration) };
  const writtenBytes = new Map();
  async function writeJson(path, value) {
    const bytes = Buffer.from(JSON.stringify(value));
    await writeFile(join(directory, path), bytes);
    writtenBytes.set(path, bytes.length);
    return { path, sha256: hash(bytes) };
  }
  const campaign = { schemaVersion: 1, configuration: await writeJson('configuration.json', configuration),
    declaration: await writeJson('declaration.json', declaration), scenarios: [] };
  const scenarios = configuration.scenarios.map(scenario => ({ id: scenario.id,
    cells: configuration.cells.map(cell => ({ id: cell.id, status: 'unmeasured', attempts: [] })) }));
  for (const scenario of scenarios) campaign.scenarios.push({ ...await writeJson(`${scenario.id}.json`, scenario), scenarioId: scenario.id });
  async function saveCampaign() { await writeJson('campaign.json', campaign); }
  async function saveScenario(index) {
    campaign.scenarios[index] = { ...await writeJson(`${scenarios[index].id}.json`, scenarios[index]), scenarioId: scenarios[index].id };
    await saveCampaign();
  }
  await saveCampaign();
  return { configuration, declaration, campaign, scenarios, writtenBytes, writeJson, saveCampaign, saveScenario };
}

test('fixed majority requires five distinct confirmed scenarios and two application suites', () => {
  const applicationIds = ['application-todomvc', 'application-svgomg'];
  assert.equal(analyzeFinalGoal(fixture(['runner-interaction', 'runner-assertion', ...applicationIds])).goalAccepted, false);
  const analysis = analyzeFinalGoal(fixture(['runner-interaction', 'runner-assertion', 'runner-navigation', ...applicationIds]));
  assert.equal(analysis.goalAccepted, true);
  assert.equal(analysis.confirmedWins, 5);
  assert.equal(analysis.declaredScenarioCount, 9);
  assert.equal(analysis.requiredMajority, 5);
  assert.equal(analyzeFinalGoal(fixture(draft.scenarios.slice(0, 6).map(scenario => scenario.id))).goalAccepted, false);
});

test('draft remains unaccepted with synthetic all-win raw observations', () => {
  const state = fixture();
  state.configuration.status = 'draft';
  refreshConfiguration(state);
  const analysis = analyzeFinalGoal(state);
  assert.equal(analysis.goalAccepted, false);
  assert.equal(analysis.sealed, false);
});

test('missing scenario or cell never shrinks the denominator', () => {
  for (const remove of [state => state.scenarioResults.pop(), state => state.scenarioResults[0].cells.pop()]) {
    const state = fixture(); remove(state);
    const analysis = analyzeFinalGoal(state);
    assert.equal(analysis.declaredScenarioCount, 9);
    assert.equal(analysis.evidenceComplete, false);
    assert.equal(analysis.goalAccepted, false);
  }
});

test('fully evidenced unsupported, failed and noncomparable cases stay explicit nonwinners', () => {
  for (const status of ['unsupported', 'failed', 'noncomparable']) {
    const state = fixture(); state.scenarioResults[0].cells[0] = nonwinner(status);
    const analysis = analyzeFinalGoal(state);
    assert.equal(analysis.declaredScenarioCount, 9);
    assert.equal(analysis.confirmedWins, 8);
    assert.equal(analysis.evidenceComplete, true);
    assert.equal(analysis.scenarios[0].cells[0].retainedAttempts.length, 1);
  }
});

test('known supported behavioral regressions separately veto otherwise sufficient wins', () => {
  const state = fixture(); state.configuration.scenarios[0].previouslySupported['single-worker'] = true;
  refreshConfiguration(state); state.scenarioResults[0].cells[0] = nonwinner('failed');
  const analysis = analyzeFinalGoal(state);
  assert.equal(analysis.confirmedWins, 8);
  assert.equal(analysis.supportedRegressions.length, 1);
  assert.equal(analysis.goalAccepted, false);
});

test('raw ratios and intervals decide wins, ignoring supplied acceptance and ratio fields', () => {
  const state = fixture([]); state.goalAccepted = true;
  candidate(state).report.medianPairedSpeedup = 1000;
  assert.equal(analyzeFinalGoal(state).confirmedWins, 0);
  for (const [index, pair] of state.scenarioResults[0].cells[0].attempts.entries()) {
    const run = pair.runs.flashwright, duration = index < 4 ? 150 : 600;
    run.report.completeMilliseconds = duration;
    run.report.ownerInterval.endMilliseconds = run.report.ownerInterval.startMilliseconds + duration;
    run.resources.ownerInterval = structuredClone(run.report.ownerInterval);
    run.resources.captureInterval.endMilliseconds = run.report.ownerInterval.endMilliseconds + 1;
    run.resources.samples.at(-1).timestampMilliseconds = run.resources.captureInterval.endMilliseconds;
    for (const worker of run.resources.workerIntervals) worker.endMilliseconds = run.report.ownerInterval.endMilliseconds - 1;
  }
  const cell = analyzeFinalGoal(state).scenarios[0].cells[0];
  assert.equal(cell.pointEstimateWin, true);
  assert.equal(cell.confirmedWin, false);
  assert.ok(cell.complete.pairedSpeedupConfidenceInterval[0] < 2);
});

test('exact ratio two is accepted only when its lower bound also reaches two', () => {
  const state = fixture();
  for (const pair of state.scenarioResults[0].cells[0].attempts) {
    const run = pair.runs.flashwright;
    run.report.completeMilliseconds = 300;
    run.report.ownerInterval.endMilliseconds = run.report.ownerInterval.startMilliseconds + 300;
    run.resources.ownerInterval = structuredClone(run.report.ownerInterval);
    run.resources.captureInterval.endMilliseconds = run.report.ownerInterval.endMilliseconds + 1;
    run.resources.samples.at(-1).timestampMilliseconds = run.resources.captureInterval.endMilliseconds;
    for (const worker of run.resources.workerIntervals) worker.endMilliseconds = run.report.ownerInterval.endMilliseconds - 1;
  }
  assert.equal(analyzeFinalGoal(state).scenarios[0].cells[0].confirmedWin, true);
});

test('a slower worker cell prevents a scenario win without adding denominator votes', () => {
  const state = fixture();
  state.scenarioResults[0].cells[1] = fixture([]).scenarioResults[0].cells[1];
  const analysis = analyzeFinalGoal(state);
  assert.equal(analysis.declaredScenarioCount, 9);
  assert.equal(analysis.scenarios[0].confirmedWin, false);
});

test('valid comparable CPU and memory regressions veto even when that row is not a win', () => {
  for (const metric of ['originalOwnerCpu', 'residentBytes']) {
    const state = fixture(draft.scenarios.slice(1).map(scenario => scenario.id));
    for (const pair of state.scenarioResults[0].cells[0].attempts) {
      const resources = pair.runs.flashwright.resources;
      if (metric === 'originalOwnerCpu') {
        resources.originalOwnerCpu.userSeconds *= 2;
        resources.originalOwnerCpu.systemSeconds *= 2;
        resources.originalOwnerCpu.cpuSeconds *= 2;
        resources.originalOwnerInclusiveCpuSeconds *= 2;
      } else for (const process of resources.samples[1].processes) process.residentBytes *= 2;
      updateResources(pair.runs.flashwright);
    }
    const analysis = analyzeFinalGoal(state);
    assert.equal(analysis.confirmedWins, 8);
    assert.equal(analysis.regressions.length, 1);
    assert.equal(analysis.goalAccepted, false);
  }
});

test('missing owned resource identity and exceeded sampled ceiling are explicit noncomparable cases', () => {
  for (const mutate of [run => run.resources.missingRequiredProcessIdentities.push('missing-original-owner'), run => { run.resources.samples[1].processes[0].residentBytes = 8 * 1024 ** 3; }]) {
    const state = fixture(); mutate(candidate(state)); updateResources(candidate(state));
    const cell = analyzeFinalGoal(state).scenarios[0].cells[0];
    assert.equal(cell.status, 'noncomparable');
    assert.equal(cell.confirmedWin, false);
    assert.equal(cell.regressionRatios, undefined);
    assert.equal(cell.retainedAttempts.length, 8);
  }
});

test('repeated resource samples do not count original PID/start CPU twice', () => {
  const state = fixture(), run = candidate(state);
  run.resources.samples.splice(2, 0, { ...structuredClone(run.resources.samples[1]), timestampMilliseconds: run.report.ownerInterval.startMilliseconds + 6 });
  assert.equal(analyzeFinalGoal(state).scenarios[0].cells[0].regressionRatios.originalOwnerInclusiveCpuMedian, 1);
});

test('known collector coverage gaps cannot be hidden behind supplied completeness booleans', () => {
  const state = fixture(); candidate(state).resources.missingRequiredProcessIdentities.push('original-short-lived-descendant');
  candidate(state).resources.coverageComplete = true;
  const cell = analyzeFinalGoal(state).scenarios[0].cells[0];
  assert.equal(cell.status, 'noncomparable');
  assert.equal(cell.confirmedWin, false);
});

test('logical thread generations may share one host without counting its CPU or RSS repeatedly', () => {
  const state = fixture();
  for (const pair of state.scenarioResults[0].cells[1].attempts) {
    const run = pair.runs.flashwright;
    const sharedHost = run.resources.ownedProcesses.find(process => process.components.includes('workers'));
    run.resources.ownedProcesses = run.resources.ownedProcesses.filter(process => !process.components.includes('workers') || process === sharedHost);
    const retainedIdentities = new Set(run.resources.ownedProcesses.map(process => process.identity));
    for (const sample of run.resources.samples) sample.processes = sample.processes.filter(process => retainedIdentities.has(process.identity));
    for (const worker of run.resources.workerIntervals) worker.hostProcessIdentity = sharedHost.identity;
    updateResources(run);
  }
  const cell = analyzeFinalGoal(state).scenarios[0].cells[1];
  assert.equal(cell.confirmedWin, true);
  assert.ok(cell.regressionRatios.sampledConcurrentMemoryMaximum < 1);
  assert.equal(cell.regressionRatios.originalOwnerInclusiveCpuMedian, 1);
});

test('test lifetimes stay inside their logical worker and never overlap on one worker', () => {
  for (const mutate of [run => { run.report.tests[0].interval.startMilliseconds = run.report.ownerInterval.startMilliseconds; },
    run => { run.report.tests[1].workerIdentity = run.report.tests[0].workerIdentity; }]) {
    const state = fixture(); mutate(state.scenarioResults[0].cells[1].attempts[0].runs.flashwright);
    assert.throws(() => analyzeFinalGoal(state), /logical worker/);
  }
});

test('eight complete raw pairs containing a genuine failure remain explicit nonwinners', () => {
  for (const suppliedStatus of ['comparable', 'failed', 'noncomparable']) {
    const state = fixture(), cell = state.scenarioResults[0].cells[0];
    state.configuration.scenarios[0].previouslySupported['single-worker'] = true;
    refreshConfiguration(state);
    cell.status = suppliedStatus;
    cell.reason = 'Original assertion failure, with all attempted pairs retained';
    const run = cell.attempts[0].runs.flashwright;
    run.report.tests[0].status = 'failed';
    run.report.tests[0].errors = [{ code: 'AssertionError', message: 'Original application predicate failed' }];
    run.report.runnerExitCode = 1;
    const analysis = analyzeFinalGoal(state), failed = analysis.scenarios[0].cells[0];
    assert.equal(failed.status, 'failed');
    assert.equal(failed.evidenceComplete, true);
    assert.equal(failed.retainedAttempts.length, 8);
    assert.equal(failed.behaviorFailures[0].originalErrors[0].message, 'Original application predicate failed');
    assert.equal(failed.regressionRatios, undefined);
    assert.equal(failed.supportedRegression, true);
    assert.equal(analysis.goalAccepted, false);
  }
});

test('genuine failed/skipped execution does not invent missing worker or context admission', () => {
  const state = fixture(), run = candidate(state);
  run.report.tests[0].status = 'failed';
  run.report.tests[0].errors = [{ message: 'Original fixture setup failed before a context existed' }];
  run.report.tests[0].contextIdentity = null;
  run.report.tests[0].workerIdentity = null;
  run.report.tests[0].interval = null;
  run.report.runnerExitCode = 1;
  const cell = analyzeFinalGoal(state).scenarios[0].cells[0];
  assert.equal(cell.status, 'failed');
  assert.equal(cell.evidenceComplete, true);
  assert.equal(cell.confirmedWin, false);
  assert.match(cell.behaviorFailures[0].originalErrors[0].message, /before a context existed/);
});

for (const [name, mutate] of [
  ['duplicate scenario', state => state.scenarioResults.push(state.scenarioResults[0])],
  ['unknown scenario', state => { state.scenarioResults[0].id = 'renamed-easy-row'; }],
  ['duplicate cell', state => state.scenarioResults[0].cells.push(state.scenarioResults[0].cells[0])],
  ['relabelled pair', state => { state.scenarioResults[0].cells[0].attempts[0].id = 'another-row/single-worker/0'; }],
  ['missing pair', state => state.scenarioResults[0].cells[0].attempts.pop()],
  ['missing counterpart', state => { delete state.scenarioResults[0].cells[0].attempts[0].runs.playwright; }],
  ['negative duration', state => { candidate(state).report.completeMilliseconds = -1; }],
  ['zero duration', state => { candidate(state).report.completeMilliseconds = 0; }],
  ['nonfinite duration', state => { candidate(state).report.completeMilliseconds = Infinity; }],
  ['unmatched browser', state => { candidate(state).report.identity.browserSha256 = hash('different-browser'); }],
  ['library-flow promotion', state => { candidate(state).report.comparisonClass = 'library-flow'; }],
  ['higher candidate workers', state => { candidate(state).report.identity.workers = 4; }],
  ['omitted artifact', state => { candidate(state).report.identity.artifacts.defaultFailureDocuments = false; }],
  ['omitted backend initialization', state => { candidate(state).report.fixtureInitializationInsideClock = false; }],
  ['omitted shutdown', state => { candidate(state).report.allShutdownAndArtifactFlushInsideClock = false; }],
  ['wrong callback', state => { candidate(state).report.tests[0].bodySha256 = hash('changed-test'); }],
  ['skipped test', state => { candidate(state).report.tests[0].status = 'skipped'; }],
  ['reused test context', state => { candidate(state).report.tests[1].contextIdentity = candidate(state).report.tests[0].contextIdentity; }],
  ['CPU summary forgery', state => { candidate(state).resources.originalOwnerInclusiveCpuSeconds *= 0.1; }],
  ['RSS summary forgery', state => { candidate(state).resources.sampledConcurrentBytes *= 0.1; }],
  ['duplicated sample PID/start', state => candidate(state).resources.samples[1].processes.push(candidate(state).resources.samples[1].processes[0])],
  ['missing raw failure', state => { state.scenarioResults[0].cells[0] = { ...nonwinner('unsupported'), attempts: [] }; }],
  ['post-hoc noncomparable label', state => { state.scenarioResults[0].cells[0].status = 'noncomparable'; state.scenarioResults[0].cells[0].reason = 'Hide unfavorable valid timing'; }],
  ['configured-only concurrency', state => { for (const interval of state.scenarioResults[0].cells[1].attempts[0].runs.flashwright.report.tests) interval.workerIdentity = 'idle-worker'; }],
]) test(`reject ${name}`, () => { const state = fixture(); mutate(state); assert.throws(() => analyzeFinalGoal(state)); });

test('original failure evidence and clean owned-process exit are mandatory', () => {
  const state = fixture(), run = state.scenarioResults[5].cells[0].attempts[0].runs.flashwright;
  run.report.tests[0].diagnostics.originalPredicateRetained = false;
  const analysis = analyzeFinalGoal(state);
  assert.equal(analysis.scenarios[5].cells[0].status, 'failed');
  assert.equal(analysis.scenarios[5].cells[0].confirmedWin, false);
  assert.match(analysis.scenarios[5].cells[0].behaviorFailures[0].reason, /later fallback/);
  const leaked = fixture(); candidate(leaked).resources.remainingOwnedProcesses.push('original-driver');
  assert.throws(() => analyzeFinalGoal(leaked));
});

test('analyzer leaves retained input immutable and public renderer omits private evidence paths', () => {
  const state = fixture(); candidate(state).evidence[0].path = '/fixture-private/raw-report.json';
  const before = structuredClone(state), analysis = analyzeFinalGoal(state);
  assert.deepEqual(state, before);
  assert.equal(analysis.competitorLeadershipEstablished, false);
  assert.ok(!renderFinalGoalReport(analysis).includes('/fixture-private/'));
  assert.match(analysis.scope, /observed maxima, not percentile tails/);
});

test('file loader binds draft bytes and rejects changed evidence, traversal and symlinks', async () => {
  const directory = await mkdtemp(join(temporaryRoot, 'flashwright-final-goal-contract-'));
  try {
    const { campaign } = await retainedDraft(directory);
    const configurationBytes = await readFile(join(directory, 'configuration.json'));
    assert.equal((await verifyFinalGoalEvidence(directory)).analysis.goalAccepted, false);
    await writeFile(join(directory, 'configuration.json'), Buffer.concat([configurationBytes, Buffer.from('\n')]));
    await assert.rejects(verifyFinalGoalEvidence(directory), /bytes changed/);
    await writeFile(join(directory, 'configuration.json'), configurationBytes);
    campaign.configuration.path = '../configuration.json';
    await writeFile(join(directory, 'campaign.json'), JSON.stringify(campaign));
    await assert.rejects(verifyFinalGoalEvidence(directory), /relative and contained/);
    campaign.configuration.path = 'configuration-link.json';
    await symlink('configuration.json', join(directory, 'configuration-link.json'));
    await writeFile(join(directory, 'campaign.json'), JSON.stringify(campaign));
    await assert.rejects(verifyFinalGoalEvidence(directory), /symbolic link/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('loader rejects incomplete or repeated scenario topology before opening referenced files', async () => {
  const directory = await mkdtemp(join(temporaryRoot, 'flashwright-final-goal-topology-'));
  try {
    const state = await retainedDraft(directory), original = structuredClone(state.campaign.scenarios);
    for (const mutate of [
      entries => entries.pop(),
      entries => { entries[1].scenarioId = entries[0].scenarioId; },
      entries => { entries[0].scenarioId = 'unapproved-scenario'; },
      entries => { entries[1].path = entries[0].path; },
    ]) {
      state.campaign.scenarios = structuredClone(original);
      for (const entry of state.campaign.scenarios) entry.path = `missing/${entry.path}`;
      mutate(state.campaign.scenarios);
      await state.saveCampaign();
      await assert.rejects(verifyFinalGoalEvidence(directory), /nine declared scenarios|paths must be distinct/);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('loader rejects invalid cells and attempt topology before visiting receipts', async () => {
  const directory = await mkdtemp(join(temporaryRoot, 'flashwright-final-goal-attempts-'));
  try {
    const state = await retainedDraft(directory), original = structuredClone(state.scenarios[0]);
    for (const [mutate, expectedError] of [
      [scenario => scenario.cells.pop(), /two declared cells/],
      [scenario => { scenario.cells[1].id = scenario.cells[0].id; }, /two declared cells/],
      [scenario => { scenario.cells[0].attempts = Array.from({ length: 9 }, () => ({})); }, /eight declared attempts/],
      [scenario => { scenario.cells[0].attempts = [{}]; }, /Unmeasured cell/],
      [scenario => { scenario.cells[0].status = 'comparable'; }, /retained original attempts/],
      [scenario => { scenario.cells[0].status = 'comparable'; scenario.cells[0].attempts = [{}]; }, /all eight declared pairs/],
      [scenario => { scenario.cells[0].status = 'failed'; scenario.cells[0].attempts = [{ runs: { unapprovedEngine: {} } }]; }, /Unknown attempted engine/],
    ]) {
      state.scenarios[0] = structuredClone(original);
      mutate(state.scenarios[0]);
      state.scenarios[0].cells[0].evidence = [{ path: 'must-not-open.json', sha256: hash('missing') }];
      await state.saveScenario(0);
      await assert.rejects(verifyFinalGoalEvidence(directory), expectedError);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('loader charges repeated JSON reads and rejects the aggregate boundary before parsing', async () => {
  const directory = await mkdtemp(join(temporaryRoot, 'flashwright-final-goal-budget-'));
  try {
    const state = await retainedDraft(directory);
    const approval = await state.writeJson('approval.json', { status: 'approved-before-measurement',
      configurationSha256: state.declaration.configurationSha256 });
    state.declaration.approvalEvidence = [approval, approval];
    state.campaign.declaration = await state.writeJson('declaration.json', state.declaration);
    await state.saveCampaign();
    const expectedBytes = [...state.writtenBytes.values()].reduce((sum, length) => sum + length, 0)
      + state.writtenBytes.get('approval.json');
    const result = await verifyFinalGoalEvidence(directory, { maximumAggregateJsonBytes: expectedBytes });
    assert.equal(result.inputBudget.aggregateJsonBytes, expectedBytes);
    assert.equal(result.inputBudget.maximumAggregateJsonBytes, expectedBytes);
    assert.equal(result.analysis.goalAccepted, false);
    await assert.rejects(verifyFinalGoalEvidence(directory, { maximumAggregateJsonBytes: expectedBytes - 1 }), /budget exceeded before parsing/);
    await writeFile(join(directory, 'campaign.json'), 'this is deliberately invalid JSON');
    await assert.rejects(verifyFinalGoalEvidence(directory, { maximumAggregateJsonBytes: 1 }), /budget exceeded before parsing/);
    await assert.rejects(verifyFinalGoalEvidence(directory, {
      maximumAggregateJsonBytes: finalGoalEvidenceLimits.maximumAggregateJsonBytes + 1,
    }), /cannot exceed the declared limit/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('loader streams opaque receipts and preserves raw JSON equality and path identities', async () => {
  const directory = await mkdtemp(join(temporaryRoot, 'flashwright-final-goal-streaming-'));
  try {
    const state = await retainedDraft(directory);
    const opaqueBytes = Buffer.alloc(finalGoalEvidenceLimits.opaqueReadChunkBytes * 2 + 17, 0x61);
    await writeFile(join(directory, 'original-artifact.bin'), opaqueBytes);
    const opaque = { path: 'original-artifact.bin', sha256: hash(opaqueBytes) };
    const report = { tests: [] }, resources = { source: 'original retained resource fixture' };
    const reportReceipt = { ...await state.writeJson('report.json', report), kind: 'report' };
    const resourceReceipt = { ...await state.writeJson('resources.json', resources), kind: 'resources' };
    const cell = state.scenarios[0].cells[0];
    cell.status = 'failed';
    cell.reason = 'Original partial admission failure retained';
    cell.evidence = [opaque];
    cell.attempts = [{ failure: { code: 'OriginalFailure', message: 'Original retained failure' }, evidence: [opaque],
      runs: { flashwright: { report, resources, evidence: [opaque, reportReceipt, resourceReceipt] } } }];
    await state.saveScenario(0);
    const result = await verifyFinalGoalEvidence(directory);
    assert.equal(result.checkedFiles[opaque.path], opaque.sha256);
    assert.equal(result.checkedFiles[reportReceipt.path], reportReceipt.sha256);
    assert.equal(result.analysis.goalAccepted, false);
    assert.match(result.inputBudget.scope, /RSS are not bounded/);

    report.tests.push({ originalError: 'Changed inline data cannot replace original bytes' });
    await state.saveScenario(0);
    await assert.rejects(verifyFinalGoalEvidence(directory), /Inline report differs/);
    report.tests.pop();
    cell.attempts[0].evidence = [{ ...opaque, sha256: hash('conflicting identity') }];
    await state.saveScenario(0);
    await assert.rejects(verifyFinalGoalEvidence(directory), /conflicting identities/);
    cell.attempts[0].evidence = [opaque];
    await state.saveScenario(0);
    await writeFile(join(directory, opaque.path), Buffer.concat([opaqueBytes, Buffer.from('changed')]));
    await assert.rejects(verifyFinalGoalEvidence(directory), /bytes changed/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('loader requires digests for every JSON receipt', async () => {
  const directory = await mkdtemp(join(temporaryRoot, 'flashwright-final-goal-receipt-'));
  try {
    const state = await retainedDraft(directory);
    delete state.campaign.configuration.sha256;
    await state.saveCampaign();
    await assert.rejects(verifyFinalGoalEvidence(directory));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('loader rejects oversized files before reserving JSON bytes or reading file content', async () => {
  const directory = await mkdtemp(join(temporaryRoot, 'flashwright-final-goal-file-limit-'));
  try {
    await writeFile(join(directory, 'campaign.json'), '');
    await truncate(join(directory, 'campaign.json'), finalGoalEvidenceLimits.maximumFileBytes + 1);
    await assert.rejects(verifyFinalGoalEvidence(directory, { maximumAggregateJsonBytes: 1 }), /Oversized evidence file/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});


for (const [description, mutate, expected] of [
  ['resource host join', run => { run.resources.provenance.hostIdentitySha256 = hash('another-host'); }, /Resource host/],
  ['resource capture identity', run => { run.resources.watchdogClock.identity = hash('another-capture').slice(0, 32); }, /Resource clock/],
  ['resource watchdog receipt hash', run => { run.resources.provenance.watchdogSha256 = hash('another-watchdog'); }, /watchdog hash/],
  ['resource lifecycle producer hash', run => { run.resources.provenance.lifecycleSourceSha256 = hash('another-producer'); }, /lifecycle producer/],
  ['resource owner interval', run => { run.resources.ownerInterval.endMilliseconds += 1; }, /Lifecycle owner interval/],
  ['missing report clock', run => { delete run.report.watchdogClock; }, /original watchdog clock/],
  ['extra report clock field', run => { run.report.watchdogClock.inferredOrigin = true; }, /exact original watchdog clock projection/],
]) test(`pure comparable admission rejects ${description}`, () => {
  const state = fixture(); mutate(candidate(state)); assert.throws(() => analyzeFinalGoal(state), expected);
});

test('sealed declaration binds the lifecycle producer in original admitted source', () => {
  for (const mutate of [state => { delete state.declaration.lifecycleProducerSha256; },
    state => { state.declaration.lifecycleProducerPath = 'unadmitted-producer.mjs'; },
    state => { state.declaration.sourceManifest['fixture-lifecycle.mjs'] = hash('different-producer'); }]) {
    const state = fixture(); mutate(state); assert.throws(() => analyzeFinalGoal(state), /lifecycle producer|Lifecycle producer/);
  }
});

for (const kind of ['watchdog-path', 'lifecycle-path', 'watchdog-sha', 'capture-identity'])
  test(`comparable campaign rejects reused original ${kind}`, () => {
    const state = fixture(), pair = state.scenarioResults[0].cells[0].attempts[0];
    const reference = pair.runs.playwright, run = pair.runs.flashwright;
    if (kind.endsWith('-path')) {
      const receiptKind = kind.split('-')[0];
      run.evidence.find(receipt => receipt.kind === receiptKind).path = reference.evidence.find(receipt => receipt.kind === receiptKind).path;
    } else if (kind === 'watchdog-sha') {
      run.evidence.find(receipt => receipt.kind === 'watchdog').sha256 = reference.resources.provenance.watchdogSha256;
      run.resources.provenance.watchdogSha256 = reference.resources.provenance.watchdogSha256;
    } else {
      run.report.watchdogClock.identity = reference.report.watchdogClock.identity;
      run.resources.watchdogClock.identity = reference.report.watchdogClock.identity;
      run.resources.provenance.clockIdentity = reference.report.watchdogClock.identity;
      run.resources.provenance.capture.clockIdentity = reference.report.watchdogClock.identity;
    }
    assert.throws(() => analyzeFinalGoal(state), /Reused original resource/);
  });

/** One measured synthetic cell keeps retained controls small; other declared cells remain unmeasured. */
function retainedResourceFixture() {
  const state = fixture();
  for (const [scenarioIndex, scenario] of state.scenarioResults.entries())
    scenario.cells = scenario.cells.map((cell, cellIndex) => scenarioIndex === 0 && cellIndex === 0 ? cell
      : { id: cell.id, status: 'unmeasured', attempts: [], reason: 'Synthetic control leaves this declared cell unmeasured' });
  return state;
}

for (const [description, mutate, expected] of [
  ['raw outcome relabelled', run => run.resources.originalAttempts[0].status = 'failed', /Original dispatched outcome differs/],
  ['raw runner exit relabelled', run => run.resources.originalRunnerExitCode = 1, /Original runner exit differs/],
  ['callback changed', run => run.resources.originalAttempts[0].bodySha256 = hash('different callback'), /Original dispatched callback differs/],
  ['worker changed', run => run.resources.originalAttempts[0].workerIdentity = 'different-worker', /Original dispatched worker differs/],
  ['interval changed', run => run.resources.originalAttempts[0].interval.endMilliseconds++, /Original dispatched interval differs/],
  ['boot changed', run => run.resources.provenance.bootIdentitySha256 = hash('other boot'), /Resource boot differs/],
  ['runtime changed', run => run.resources.provenance.executables.runtime.sha256 = hash('other runtime'), /Resource runtime executable differs/],
  ['launcher changed', run => run.resources.provenance.executables.launcher.sha256 = hash('other launcher'), /Resource launcher differs/],
  ['source changed', run => run.resources.provenance.sourceManifestSha256 = hash('other source'), /Resource source manifest differs/],
  ['dependencies changed', run => run.resources.provenance.dependencyManifestSha256 = hash('other dependencies'), /Resource dependencies differ/],
]) test(`original owner admission rejects ${description}`, () => {
  const state = fixture(); mutate(candidate(state)); assert.throws(() => analyzeFinalGoal(state), expected);
});

test('sampled CPU changes and missing short-lived RSS do not fabricate terminal CPU', () => {
  const state = fixture(), run = candidate(state);
  for (const sample of run.resources.samples) for (const process of sample.processes) process.cpuSeconds = 999999;
  run.resources.samples[1].processes.pop();
  updateResources(run);
  const cell = analyzeFinalGoal(state).scenarios[0].cells[0];
  assert.equal(cell.regressionRatios.originalOwnerInclusiveCpuMedian, 1);
  assert.equal(cell.confirmedWin, true);
});

test('collector admission cannot be borrowed from another host, boot or executable context', async () => {
  for (const key of ['hostIdentitySha256', 'bootIdentitySha256', 'configurationSha256', 'runtimeSha256',
    'browserSha256', 'driverSha256', 'resourceCollectorSha256', 'lifecycleProducerSha256']) {
    const directory = await mkdtemp(join(temporaryRoot, 'flashwright-owner-admission-context-'));
    try {
      const state = retainedResourceFixture();
      const { campaign, writeJson } = await retainSyntheticCampaign(directory, state);
      const gate = state.declaration.gates.find(gate => gate.id === 'resource-collector-admission');
      const admission = JSON.parse(await readFile(join(directory, gate.evidence[0].path), 'utf8'));
      admission.resourceContext[key] = hash(`different/${key}`);
      Object.assign(gate.evidence[0], await writeJson(gate.evidence[0].path, admission));
      campaign.declaration = await writeJson(campaign.declaration.path, state.declaration);
      await writeJson('campaign.json', campaign);
      await assert.rejects(verifyFinalGoalEvidence(directory), /Resource collector admission differs/);
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
});

test('every raw resource verifier source must be included in the admitted manifest', () => {
  for (const path of finalGoalResourceVerifierPaths) {
    const state = fixture(); delete state.declaration.sourceManifest[path];
    assert.throws(() => analyzeFinalGoal(state), /Missing resource verifier source/);
  }
});

test('synthetic summaries cannot replace original raw ownership records', async () => {
  const directory = await mkdtemp(join(temporaryRoot, 'flashwright-final-goal-resource-originals-'));
  try {
    const state = retainedResourceFixture();
    await retainSyntheticCampaign(directory, state);
    await assert.rejects(verifyFinalGoalEvidence(directory), /Owner tree borrows another watchdog path/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

for (const [description, mutate, expected] of [
  ['independent host hash', run => { run.resources.provenance.hostIdentitySha256 = hash('other-host'); }, /Resource host|Resources differ/],
  ['independent clock identity', run => { run.resources.watchdogClock.identity = hash('other-clock').slice(0, 32); }, /Resource clock|Resources differ/],
  ['independent watchdog hash', run => { run.resources.provenance.watchdogSha256 = hash('other-watchdog'); }, /watchdog hash|Resources differ/],
  ['independent lifecycle producer', run => { run.resources.provenance.lifecycleSourceSha256 = hash('other-producer'); }, /lifecycle producer|Resources differ/],

]) test(`retained verifier rejects ${description}`, async () => {
  const directory = await mkdtemp(join(temporaryRoot, 'flashwright-final-goal-resource-corruption-'));
  try {
    const state = retainedResourceFixture(); mutate(candidate(state));
    await retainSyntheticCampaign(directory, state);
    await assert.rejects(verifyFinalGoalEvidence(directory), expected);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

for (const kind of ['watchdog', 'lifecycle']) for (const duplicate of [false, true]) {
  test(`comparable originals reject ${duplicate ? 'duplicate' : 'missing'} ${kind} receipts`, async () => {
    const directory = await mkdtemp(join(temporaryRoot, 'flashwright-final-goal-resource-receipts-'));
    try {
      const state = retainedResourceFixture(), run = candidate(state);
      const receipt = run.evidence.find(item => item.kind === kind);
      if (duplicate) run.evidence.push({ ...receipt, path: `${receipt.path}.duplicate` });
      else run.evidence = run.evidence.filter(item => item.kind !== kind);
      await retainSyntheticCampaign(directory, state);
      await assert.rejects(verifyFinalGoalEvidence(directory), new RegExp(`Missing unique raw ${kind}`));
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
}


test('original failed and noncomparable attempts keep partial watchdog bytes without invented lifecycle success', async () => {
  for (const status of ['failed', 'noncomparable']) {
    const directory = await mkdtemp(join(temporaryRoot, 'flashwright-final-goal-partial-originals-'));
    try {
      const state = retainedResourceFixture();
      const cell = nonwinner(status), partialWatchdog = { schemaVersion: 2, exitCode: -9, timedOut: true,
        syntheticOnly: true, originalFailure: 'Producer terminated before clock/lifecycle admission' };
      const watchdogReceipt = { ...receipt('partial-watchdog.json'), kind: 'watchdog' };
      cell.attempts[0].runs = { flashwright: { report: { tests: [] }, resources: { originalFailure: 'No comparable resources produced' },
        syntheticOriginals: { watchdog: partialWatchdog }, evidence: [
          { ...receipt('partial-report.json'), kind: 'report' },
          { ...receipt('partial-resources.json'), kind: 'resources' }, watchdogReceipt] } };
      state.scenarioResults[0].cells[0] = cell;
      await retainSyntheticCampaign(directory, state);
      const result = await verifyFinalGoalEvidence(directory);
      assert.equal(result.analysis.goalAccepted, false);
      assert.equal(result.analysis.scenarios[0].cells[0].status, status);
      assert.equal(result.checkedFiles[watchdogReceipt.path], watchdogReceipt.sha256);
      assert.equal(result.analysis.scenarios[0].cells[0].retainedAttempts[0].failure.code, 'UnsupportedFeatureError');
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
});


/** Preserve ordinary originals from attempted runs without inventing successful clock/lifecycle custody. */
function omitSyntheticSuccessOnlyResources(cell) {
  for (const attempt of cell.attempts) for (const run of Object.values(attempt.runs)) {
    delete run.report.watchdogClock;
    delete run.resources.watchdogClock;
    delete run.resources.ownerInterval;
    delete run.resources.provenance;
    delete run.syntheticOriginals.watchdog.clock;
    delete run.syntheticOriginals.lifecycle;
    run.evidence = run.evidence.filter(receipt => receipt.kind !== 'lifecycle');
  }
}

for (const failureKind of ['behavior', 'coverage'])
  test(`declared comparable raw eight-pair ${failureKind} failure keeps original partial receipts`, async () => {
    const directory = await mkdtemp(join(temporaryRoot, 'flashwright-final-goal-classified-originals-'));
    try {
      const state = retainedResourceFixture(), cell = state.scenarioResults[0].cells[0], run = candidate(state);
      if (failureKind === 'behavior') {
        run.report.tests[0].status = 'failed';
        run.report.tests[0].errors = [{ code: 'OriginalAssertionError', message: 'Original attempted behavior failed' }];
        run.report.runnerExitCode = 1;
      } else run.resources.missingRequiredProcessIdentities.push('original-known-unsampled-process');
      omitSyntheticSuccessOnlyResources(cell);
      assert.equal(cell.status, 'comparable');
      assert.equal(cell.attempts.length, 8);
      await retainSyntheticCampaign(directory, state);
      const result = await verifyFinalGoalEvidence(directory);
      const analyzed = result.analysis.scenarios[0].cells[0];
      assert.equal(analyzed.status, failureKind === 'behavior' ? 'failed' : 'noncomparable');
      assert.equal(analyzed.confirmedWin, false);
      assert.equal(analyzed.retainedAttempts.length, 8);
      assert.equal(result.analysis.goalAccepted, false);
      for (const attempt of cell.attempts) for (const originalRun of Object.values(attempt.runs))
        for (const receipt of originalRun.evidence) assert.equal(result.checkedFiles[receipt.path], receipt.sha256);
      if (failureKind === 'behavior') assert.equal(analyzed.behaviorFailures[0].originalErrors[0].code, 'OriginalAssertionError');
      else assert.ok(analyzed.reasons.some(reason => reason.includes('missing required original process identity')));
      const partialWatchdog = candidate(state).evidence.find(receipt => receipt.kind === 'watchdog');
      await writeFile(join(directory, partialWatchdog.path), Buffer.from('changed original partial watchdog bytes'));
      await assert.rejects(verifyFinalGoalEvidence(directory), /Retained evidence bytes changed/);

    } finally { await rm(directory, { recursive: true, force: true }); }
  });

test('unsealed declared comparable original pairs remain inspectable without successful clock or lifecycle', async () => {
  const directory = await mkdtemp(join(temporaryRoot, 'flashwright-final-goal-draft-originals-'));
  try {
    const state = retainedResourceFixture(), cell = state.scenarioResults[0].cells[0];
    state.configuration.status = 'draft';
    state.declaration.status = 'draft';
    refreshConfiguration(state);
    omitSyntheticSuccessOnlyResources(cell);
    await retainSyntheticCampaign(directory, state);
    const result = await verifyFinalGoalEvidence(directory);
    assert.equal(result.analysis.sealed, false);
    assert.equal(result.analysis.goalAccepted, false);
    assert.equal(result.analysis.scenarios[0].cells[0].status, 'unsealed');
    assert.equal(cell.status, 'comparable');
    for (const attempt of cell.attempts) for (const run of Object.values(attempt.runs))
      for (const receipt of run.evidence) assert.equal(result.checkedFiles[receipt.path], receipt.sha256);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
