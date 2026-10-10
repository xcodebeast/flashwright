import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { analyzeFinalGoal, finalGoalHash, renderFinalGoalReport } from '../benchmarks/final-goal-contract.mjs';
import { verifyFinalGoalEvidence } from './verify-final-goal.mjs';

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
      ...Object.fromEntries(configuration.requiredGateIds.map(id => [`${id}.mjs`, hash(id)])) }, dependencyManifest: { 'fixture-package.json': hash('dependencies') },
    runtimeSha256: hash('bun'), browserSha256: hash('browser'), driverSha256: hash('driver'), resourceCollectorSha256: hash('collector'), resourceCollectorPath: 'fixture-collector.mjs',
    host: { logicalCpuCount: 11, physicalMemoryBytes: 36 * 1024 ** 3, identitySha256: hash('host') },
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
            contextIdentity: `${start}/context/${index}`, workerIdentity: ownedProcesses[index % cell.workers].identity,
            interval: { startMilliseconds: start + 10 + Math.floor(index / cell.workers) * 2,
              endMilliseconds: start + 11 + Math.floor(index / cell.workers) * 2 }, observations: structuredClone(expected.observations),
            ...(expected.diagnosticIdentity ? { diagnostics: { identity: structuredClone(expected.diagnosticIdentity), originalPredicateRetained: true,
              evidence: [receipt(`${scenario.id}/${cell.id}/${launchIndex}/${engine}/failure-${index}.json`)] } } : {}) })) };
        const resources = { collectorSha256: declaration.resourceCollectorSha256, ownerExitCode: 0, timedOut: false, interrupted: false,
          remainingOwnedProcesses: [], cleanupSignals: [], missingRequiredProcessIdentities: [], ownedProcesses, samples, sampledConcurrentBytes: ownedProcesses.length * 1000,
          observedProcessTreeCpuSeconds: observedCpu, captureInterval: { startMilliseconds: start - 1, endMilliseconds: start + duration + 1 },
          workerIntervals: ownedProcesses.filter(process => process.components.includes('workers')).map(process => ({ identity: process.identity,
            startMilliseconds: start + 1, endMilliseconds: start + duration - 1 })) };
        runs[engine] = { report, resources, evidence: ['report', 'resources'].map(kind => ({
          ...receipt(`${scenario.id}/${cell.id}/${launchIndex}/${engine}/${kind}.json`), kind })) };
      }
      return { id: `${scenario.id}/${cell.id}/${launchIndex}`, launchIndex, order, runs };
    }) })) }));
  return { configuration, declaration, scenarioResults };
}

const candidate = state => state.scenarioResults[0].cells[0].attempts[0].runs.flashwright;
function updateResources(run) {
  run.resources.sampledConcurrentBytes = Math.max(...run.resources.samples.map(sample => sample.processes.reduce((total, process) => total + process.residentBytes, 0)));
  const cpu = new Map();
  for (const sample of run.resources.samples) for (const process of sample.processes) cpu.set(process.identity, process.cpuSeconds);
  run.resources.observedProcessTreeCpuSeconds = [...cpu.values()].reduce((total, value) => total + value, 0);
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
  for (const metric of ['cpuSeconds', 'residentBytes']) {
    const state = fixture(draft.scenarios.slice(1).map(scenario => scenario.id));
    for (const pair of state.scenarioResults[0].cells[0].attempts) {
      for (const process of pair.runs.flashwright.resources.samples[1].processes) process[metric] *= 2;
      updateResources(pair.runs.flashwright);
    }
    const analysis = analyzeFinalGoal(state);
    assert.equal(analysis.confirmedWins, 8);
    assert.equal(analysis.regressions.length, 1);
    assert.equal(analysis.goalAccepted, false);
  }
});

test('missing owned resource identity and exceeded sampled ceiling are explicit noncomparable cases', () => {
  for (const mutate of [run => run.resources.samples[1].processes.pop(), run => { run.resources.samples[1].processes[0].residentBytes = 8 * 1024 ** 3; }]) {
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
  assert.equal(analyzeFinalGoal(state).scenarios[0].cells[0].regressionRatios.observedProcessTreeCpuMedian, 1);
});

test('known collector coverage gaps cannot be hidden behind supplied completeness booleans', () => {
  const state = fixture(); candidate(state).resources.missingRequiredProcessIdentities.push('original-short-lived-descendant');
  candidate(state).resources.coverageComplete = true;
  const cell = analyzeFinalGoal(state).scenarios[0].cells[0];
  assert.equal(cell.status, 'noncomparable');
  assert.equal(cell.confirmedWin, false);
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
  ['CPU summary forgery', state => { candidate(state).resources.observedProcessTreeCpuSeconds *= 0.1; }],
  ['RSS summary forgery', state => { candidate(state).resources.sampledConcurrentBytes *= 0.1; }],
  ['duplicated sample PID/start', state => candidate(state).resources.samples[1].processes.push(candidate(state).resources.samples[1].processes[0])],
  ['missing raw failure', state => { state.scenarioResults[0].cells[0] = { ...nonwinner('unsupported'), attempts: [] }; }],
  ['post-hoc noncomparable label', state => { state.scenarioResults[0].cells[0].status = 'noncomparable'; state.scenarioResults[0].cells[0].reason = 'Hide unfavorable valid timing'; }],
  ['configured-only concurrency', state => { for (const interval of state.scenarioResults[0].cells[1].attempts[0].runs.flashwright.report.tests) interval.workerIdentity = 'idle-worker'; }],
]) test(`reject ${name}`, () => { const state = fixture(); mutate(state); assert.throws(() => analyzeFinalGoal(state)); });

test('original failure evidence and clean owned-process exit are mandatory', () => {
  const state = fixture(), run = state.scenarioResults[5].cells[0].attempts[0].runs.flashwright;
  run.report.tests[0].diagnostics.originalPredicateRetained = false;
  assert.throws(() => analyzeFinalGoal(state), /Later fallback/);
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
  const directory = await mkdtemp(join(tmpdir(), 'flashwright-final-goal-contract-'));
  try {
    const configuration = structuredClone(draft), declaration = { status: 'draft', configurationSha256: finalGoalHash(configuration) };
    const configurationBytes = Buffer.from(JSON.stringify(configuration)), declarationBytes = Buffer.from(JSON.stringify(declaration));
    await writeFile(join(directory, 'configuration.json'), configurationBytes);
    await writeFile(join(directory, 'declaration.json'), declarationBytes);
    const campaign = { schemaVersion: 1, configuration: { path: 'configuration.json', sha256: hash(configurationBytes) },
      declaration: { path: 'declaration.json', sha256: hash(declarationBytes) }, scenarios: [] };
    await writeFile(join(directory, 'campaign.json'), JSON.stringify(campaign));
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
