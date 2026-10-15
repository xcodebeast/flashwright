import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { finalGoalHash, finalGoalResourceContext } from '../benchmarks/final-goal-contract.mjs';
import { adaptSampledResourceDiagnostics } from './final-goal-resource-adapter.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');

/** Invent coherent raw receipts for policy controls; these are never actual collector admission. */
export function attachSyntheticResourceOriginals(run, declaration, scenario) {
  const { report, resources } = run;
  const originMilliseconds = resources.captureInterval.startMilliseconds;
  const clock = { schemaVersion: 1, type: 'monotonic', implementation: 'synthetic-monotonic-clock',
    identity: hash(run.evidence.find(receipt => receipt.kind === 'watchdog').path).slice(0, 32),
    originNanoseconds: String(BigInt(originMilliseconds) * 1000000n), resolutionSeconds: 1e-9 };
  const owned = new Map(resources.ownedProcesses.map(process => [process.identity, process]));
  const aggregate = new Map();
  const samples = resources.samples.map(sample => {
    const processes = sample.processes.map(observation => {
      const process = owned.get(observation.identity);
      const raw = { process: process.processId, started: process.startIdentity, rssBytes: observation.residentBytes,
        cpuSeconds: observation.cpuSeconds, state: 'S', parent: 1, group: 1 };
      const previous = aggregate.get(process.identity);
      aggregate.set(process.identity, { ...raw, cpuSeconds: Math.max(raw.cpuSeconds, previous?.cpuSeconds ?? 0) });
      return raw;
    });
    return { elapsedSeconds: (sample.timestampMilliseconds - originMilliseconds) / 1000,
      processes, liveOwnedProcesses: processes.length,
      concurrentRssBytes: processes.reduce((total, process) => total + process.rssBytes, 0) };
  });
  const watchdog = { schemaVersion: 2, clock, cpuAccounting: 'maximum-per-observed-process-identity',
    command: ['explicitly-invented-final-goal-policy-fixture'], exitCode: 0, timedOut: false, interrupted: false,
    elapsedSeconds: (resources.captureInterval.endMilliseconds - originMilliseconds) / 1000,
    samplingIntervalSeconds: 0.001, samples, processes: [...aggregate.values()], observedProcessCount: aggregate.size,
    observedCpuSeconds: [...aggregate.values()].reduce((total, process) => total + process.cpuSeconds, 0),
    maximumSampledConcurrentRssBytes: Math.max(...samples.map(sample => sample.concurrentRssBytes)),
    remainingObservedProcesses: [], cleanupSignals: [],
    coverage: 'Invented host-only observations; no actual watchdog, lifecycle producer or browser was executed.' };
  const events = resources.ownedProcesses.map(process => ({ type: 'process-owned', timestampMilliseconds: originMilliseconds,
    process: { processId: process.processId, startIdentity: process.startIdentity }, components: [...process.components] }));
  for (const worker of resources.workerIntervals) {
    const process = owned.get(worker.hostProcessIdentity);
    const identity = { processId: process.processId, startIdentity: process.startIdentity };
    events.push({ type: 'worker-started', timestampMilliseconds: worker.startMilliseconds,
      process: identity, workerIdentity: worker.identity },
    { type: 'worker-ended', timestampMilliseconds: worker.endMilliseconds, process: identity, workerIdentity: worker.identity });
  }
  events.sort((left, right) => left.timestampMilliseconds - right.timestampMilliseconds);
  const watchdogBytes = Buffer.from(JSON.stringify(watchdog));
  const lifecycle = { schemaVersion: 1,
    provenance: { sourceSha256: declaration.lifecycleProducerSha256, watchdogSha256: hash(watchdogBytes) },
    host: { namespace: resources.ownedProcesses[0].namespace, identitySha256: declaration.host.identitySha256 },
    clock: { type: 'monotonic', identity: clock.identity, watchdogOriginNanoseconds: clock.originNanoseconds,
      watchdogOriginMilliseconds: originMilliseconds, ownerInterval: structuredClone(report.ownerInterval) }, events };
  report.watchdogClock = structuredClone(clock);
  run.resources = adaptSampledResourceDiagnostics({ watchdogReportBytes: watchdogBytes, lifecycle,
    collectorSha256: declaration.resourceCollectorSha256, requiredResourceComponents: scenario.requiredResourceComponents });
  const originalOwnerCpu = { status: 'observed', method: 'atomic-wait4-original-owner',
    process: resources.ownedProcesses.find(process => process.components.includes('runner')).processId,
    exitCode: 0, waitStatus: 0, userSeconds: 0.75, systemSeconds: 0.25, cpuSeconds: 1 };
  run.resources.ownedProcesses.find(process => process.processId === originalOwnerCpu.process).role = 'owner';
  Object.assign(run.resources, { schemaVersion: 2, cpuAccounting: 'atomic-wait4-original-owner',
    originalOwnerCpu, originalOwnerInclusiveCpuSeconds: 1, originalRunnerExitCode: report.runnerExitCode,
    originalAttempts: report.tests.map(test => ({ testId: test.id, bodySha256: test.bodySha256,
      workerIdentity: test.workerIdentity, retry: test.retry, status: test.status, interval: structuredClone(test.interval) })) });
  Object.assign(run.resources.provenance, { bootIdentitySha256: declaration.host.bootIdentitySha256,
    sourceManifestSha256: finalGoalHash(declaration.sourceManifest), dependencyManifestSha256: finalGoalHash(declaration.dependencyManifest),
    executables: Object.fromEntries(['runtime', 'browser', 'driver', 'launcher'].map(name => [name,
      { path: `/synthetic/${name}`, sha256: name === 'launcher' ? declaration.launcherSha256[report.engine] : declaration[`${name}Sha256`] }])),
    capture: { engine: report.engine, family: report.scenarioId.replace(/^runner-/, ''), workers: report.identity.workers,
      session: hash(`synthetic-session/${clock.identity}`).slice(0, 32), ownerProcess: originalOwnerCpu.process,
      clockIdentity: clock.identity, inventorySha256: hash(`synthetic-inventory/${clock.identity}`) } });
  run.syntheticOriginals = { watchdog, lifecycle, 'owner-tree': { syntheticOnly: true, noOriginalOwnerRecords: true } };
  run.evidence.find(receipt => receipt.kind === 'watchdog').sha256 = hash(watchdogBytes);
  run.evidence.find(receipt => receipt.kind === 'lifecycle').sha256 = hash(Buffer.from(JSON.stringify(lifecycle)));
}

/** Write invented retained-file controls; all source/approval/admission records remain synthetic. */
export async function retainSyntheticCampaign(directory, state) {
  async function writeJson(path, value) {
    await mkdir(dirname(join(directory, path)), { recursive: true });
    const bytes = Buffer.from(JSON.stringify(value));
    await writeFile(join(directory, path), bytes);
    return { path, sha256: hash(bytes) };
  }
  for (const evidence of state.declaration.approvalEvidence) Object.assign(evidence, await writeJson(evidence.path,
    { status: 'approved-before-measurement', configurationSha256: state.declaration.configurationSha256,
      resourceCollectorSha256: state.declaration.resourceCollectorSha256, syntheticOnly: true }));
  for (const gate of state.declaration.gates) for (const evidence of gate.evidence)
    Object.assign(evidence, await writeJson(evidence.path, { status: 'passed', gateId: gate.id,
      verifierSha256: gate.verifierSha256, sourceManifestSha256: finalGoalHash(state.declaration.sourceManifest),
      ...(gate.id === 'resource-collector-admission' ? { resourceContext: finalGoalResourceContext(state.declaration) } : {}), syntheticOnly: true }));
  const campaign = { schemaVersion: 1, configuration: await writeJson('configuration.json', state.configuration),
    declaration: await writeJson('declaration.json', state.declaration), scenarios: [] };
  for (const scenario of state.scenarioResults) {
    for (const cell of scenario.cells) {
      for (const evidence of cell.evidence ?? []) Object.assign(evidence, await writeJson(evidence.path, { syntheticOnly: true }));
      for (const attempt of cell.attempts) {
        for (const evidence of attempt.evidence ?? []) Object.assign(evidence, await writeJson(evidence.path,
          { syntheticOnly: true, originalFailure: attempt.failure ?? null }));
        for (const run of Object.values(attempt.runs ?? {})) {
          for (const test of run.report.tests) for (const evidence of test.diagnostics?.evidence ?? [])
            Object.assign(evidence, await writeJson(evidence.path, { syntheticOnly: true, originalIdentity: test.diagnostics.identity }));
          for (const evidence of run.evidence) {
            const value = ['report', 'resources'].includes(evidence.kind) ? run[evidence.kind] : run.syntheticOriginals?.[evidence.kind];
            if (value !== undefined) Object.assign(evidence, await writeJson(evidence.path, value));
          }
        }
      }
    }
    campaign.scenarios.push({ ...await writeJson(`${scenario.id}.json`, scenario), scenarioId: scenario.id });
  }
  await writeJson('campaign.json', campaign);
  return { campaign, writeJson };
}
