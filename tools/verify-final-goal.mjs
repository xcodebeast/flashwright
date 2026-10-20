import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { isAbsolute, join, normalize, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { reconstructFinalGoalResourceEvidence } from './final-goal-owner-evidence.mjs';
import { reconstructFinalGoalLinuxCapturedOutputs } from './final-goal-linux-evidence.mjs';
import { reconstructFinalGoalLinuxApplication } from './final-goal-linux-application.mjs';
import { decodeLinuxApplicationJson } from './final-goal-linux-json.mjs';
import { createFinalGoalEvidenceBudget, finalGoalEvidenceLimits } from './final-goal-evidence-budget.mjs';
import { reconstructFinalGoalLinuxBackend } from './final-goal-linux-backend.mjs';
import { reconstructFinalGoalLinuxFamily } from './final-goal-linux-family.mjs';
import { runnerFamilies } from '../benchmarks/runner-family-contract.mjs';
import { applicationCorpusDirectory, loadApplicationCorpus } from '../benchmarks/application-corpus.mjs';
import { finalGoalAccountingClasses, finalGoalResourceMetrics } from '../benchmarks/final-goal-resource-policy.mjs';
import { analyzeFinalGoal, finalGoalHash, finalGoalResourceContext, finalGoalScenarioIds, renderFinalGoalReport,
  verifyFinalGoalConfiguration } from '../benchmarks/final-goal-contract.mjs';

export { finalGoalEvidenceLimits };

/** Hash ordinary files with a fixed buffer; only JSON reads retain bytes until parsing. */
async function retainedFile(directory, path, reserveJsonBytes, { maximumFileBytes = finalGoalEvidenceLimits.maximumFileBytes, expectedSize } = {}) {
  assert.ok(typeof path === 'string' && path && !isAbsolute(path) && !path.includes('\\') && normalize(path) === path
    && !path.split('/').some(part => ['', '.', '..'].includes(part)), 'Evidence path must be relative and contained');
  let current = directory;
  const root = await lstat(current);
  assert.ok(root.isDirectory() && !root.isSymbolicLink(), 'Evidence root must be an ordinary directory');
  for (const [index, part] of path.split('/').entries()) {
    current = join(current, part);
    const information = await lstat(current);
    assert.ok(!information.isSymbolicLink(), 'Evidence custody contains a symbolic link');
    assert.ok(index === path.split('/').length - 1 ? information.isFile() : information.isDirectory(), 'Unexpected evidence file type');
    assert.ok(index !== path.split('/').length - 1 || information.size <= maximumFileBytes, 'Oversized evidence file');
  }
  const before = await lstat(current);
  const file = await open(current, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = await file.stat();
    assert.ok(opened.isFile() && opened.dev === before.dev && opened.ino === before.ino && opened.size === before.size
      && opened.size <= maximumFileBytes, 'Evidence changed before read');
    assert.ok(expectedSize === undefined || opened.size === expectedSize, 'Raw owner evidence size differs before read');
    if (reserveJsonBytes) reserveJsonBytes(opened.size);
    const bytes = Buffer.alloc(reserveJsonBytes ? opened.size + 1
      : Math.min(opened.size + 1, finalGoalEvidenceLimits.opaqueReadChunkBytes));
    const digest = createHash('sha256');
    let length = 0;
    while (length <= opened.size) {
      const offset = reserveJsonBytes ? length : 0;
      const result = await file.read(bytes, offset, Math.min(bytes.length - offset, opened.size + 1 - length), null);
      if (!result.bytesRead) break;
      digest.update(bytes.subarray(offset, offset + result.bytesRead));
      length += result.bytesRead;
    }
    const after = await file.stat();
    assert.ok(length === opened.size && after.size === opened.size && after.mtimeMs === opened.mtimeMs
      && after.ctimeMs === opened.ctimeMs, 'Evidence changed during read');
    return { sha256: digest.digest('hex'), jsonBytes: reserveJsonBytes ? bytes.subarray(0, length) : undefined };
  } finally { await file.close(); }
}

/** Reject excess or relabelled campaign rows before opening any scenario evidence. */
function verifyCampaignTopology(campaign) {
  assert.equal(campaign.schemaVersion, 1);
  assert.ok(Array.isArray(campaign.scenarios), 'Missing nine-scenario inventory');
  assert.deepEqual(campaign.scenarios.map(entry => entry.scenarioId).sort(), [...finalGoalScenarioIds].sort(),
    'Campaign must contain the nine declared scenarios exactly once');
  assert.equal(new Set(campaign.scenarios.map(entry => entry.path)).size, finalGoalScenarioIds.length,
    'Scenario evidence paths must be distinct');
}

/** Bound the declared cell and attempt graph before visiting its evidence receipts. */
function verifyScenarioTopology(result, configuration) {
  assert.ok(Array.isArray(result.cells), 'Missing two-cell inventory');
  assert.deepEqual(result.cells.map(cell => cell.id).sort(), configuration.cells.map(cell => cell.id).sort(),
    'Scenario must contain the two declared cells exactly once');
  for (const cell of result.cells) {
    assert.ok(['comparable', 'unsupported', 'failed', 'noncomparable', 'unmeasured'].includes(cell.status), 'Unknown cell status');
    assert.ok(Array.isArray(cell.attempts) && cell.attempts.length <= configuration.independentPairs,
      'Cell exceeds the eight declared attempts');
    if (cell.status === 'unmeasured') assert.equal(cell.attempts.length, 0, 'Unmeasured cell has attempted work');
    else assert.ok(cell.attempts.length, 'Attempted cell needs retained original attempts');
    if (cell.status === 'comparable') assert.equal(cell.attempts.length, configuration.independentPairs,
      'Comparable cell needs all eight declared pairs');
    for (const [index, attempt] of cell.attempts.entries()) {
      const engineNames = Object.keys(attempt.runs ?? {}).sort();
      assert.ok(engineNames.every(engine => ['playwright', 'flashwright'].includes(engine)), 'Unknown attempted engine');
      if (cell.status === 'comparable') {
        assert.deepEqual(engineNames, ['flashwright', 'playwright'], 'Comparable pair needs both original engines');
        assert.equal(attempt.id, `${result.id}/${cell.id}/${index}`, 'Relabelled pair identity');
        assert.equal(attempt.launchIndex, index, 'Relabelled pair launch index');
      }
      for (const run of Object.values(attempt.runs ?? {})) {
        assert.ok(Array.isArray(run.evidence) && Array.isArray(run.report?.tests), 'Missing original run evidence or test inventory');
        for (const kind of ['report', 'resources']) assert.equal(run.evidence.filter(receipt => receipt.kind === kind).length, 1,
          `Missing unique raw ${kind} file`);
      }
    }
  }
}

/** Bound input bytes and bind raw files; input limits do not bound parsed heap or process RSS. */
export async function verifyFinalGoalEvidence(directory, { maximumAggregateJsonBytes = finalGoalEvidenceLimits.maximumAggregateJsonBytes } = {}) {
  directory = resolve(directory);
  const budget = createFinalGoalEvidenceBudget(maximumAggregateJsonBytes);
  const checked = new Map();
  function verifyReceiptIdentity(entry) {
    assert.match(entry.sha256 ?? '', /^[a-f0-9]{64}$/);
    if (checked.has(entry.path)) assert.equal(checked.get(entry.path), entry.sha256, 'Retained file has conflicting identities');
  }
  async function evidence(entry) {
    verifyReceiptIdentity(entry);
    if (checked.has(entry.path)) return;
    const file = await retainedFile(directory, entry.path);
    assert.equal(file.sha256, entry.sha256, 'Retained evidence bytes changed');
    checked.set(entry.path, file.sha256);
  }
  async function jsonFile(path, expectedSha256, bytesOnly = false, limits, reserveJsonBytes = budget.reserveMetadata) {
    const file = await retainedFile(directory, path, reserveJsonBytes, limits);
    if (expectedSha256 !== undefined) assert.equal(file.sha256, expectedSha256, 'Retained evidence bytes changed');
    if (checked.has(path)) assert.equal(checked.get(path), file.sha256, 'Retained evidence bytes changed');
    checked.set(path, file.sha256);
    return bytesOnly ? file.jsonBytes : JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(file.jsonBytes));
  }
  async function jsonEvidence(entry, reserveJsonBytes) {
    verifyReceiptIdentity(entry);
    return jsonFile(entry.path, entry.sha256, false, undefined, reserveJsonBytes);
  }
  async function linuxManifest(entry, reserveJsonBytes) {
    verifyReceiptIdentity(entry);
    return decodeLinuxApplicationJson(await jsonFile(entry.path, entry.sha256, true, { maximumFileBytes: 4 * 1024 ** 2 }, reserveJsonBytes));
  }
  const campaign = await jsonFile('campaign.json');
  verifyCampaignTopology(campaign);
  const configuration = await jsonEvidence(campaign.configuration);
  verifyFinalGoalConfiguration(configuration);
  const declaration = await jsonEvidence(campaign.declaration);
  const scenarioResults = [];
  const linuxResourceObservations = [];
  const linuxCapturedOutputs = [];
  const linuxApplicationOutcomes = [];
  const linuxControlledFamilyOutcomes = [];
  const linuxBackendOutcomes = [];
  const scenarios = new Map(configuration.scenarios.map(scenario => [scenario.id, scenario]));
  for (const entry of campaign.scenarios) {
    const result = await jsonEvidence(entry);
    assert.equal(result.id, entry.scenarioId, 'Retained scenario was relabelled');
    verifyScenarioTopology(result, configuration);
    scenarioResults.push(result);
    for (const cell of result.cells) {
      for (const receipt of cell.evidence ?? []) await evidence(receipt);
      for (const [attemptIndex, attempt] of cell.attempts.entries()) {
        for (const receipt of attempt.evidence ?? []) await evidence(receipt);
        for (const [engine, run] of Object.entries(attempt.runs ?? {})) {
          const reserveRunBytes = budget.forRun(run);
          for (const receipt of run.evidence) await evidence(receipt);
          for (const kind of ['report', 'resources']) {
            const files = run.evidence.filter(receipt => receipt.kind === kind);
            assert.equal(files.length, 1, `Missing unique raw ${kind} file`);
            assert.deepEqual(await jsonEvidence(files[0], reserveRunBytes), run[kind], `Inline ${kind} differs from original raw file`);
          }
          for (const test of run.report.tests) for (const receipt of test.diagnostics?.evidence ?? []) await evidence(receipt);
          const linuxOriginals = run.evidence.filter(receipt => receipt.kind === 'linux-cgroup-originals');
          const outputManifests = run.evidence.filter(receipt => receipt.kind === 'linux-captured-outputs');
          const applicationManifests = run.evidence.filter(receipt => receipt.kind === 'linux-application-workload');
          const familyManifests = run.evidence.filter(receipt => receipt.kind === 'linux-controlled-family');
          const backendManifests = run.evidence.filter(receipt => receipt.kind === 'linux-backend-workload');
          if (backendManifests.length || linuxOriginals.length || outputManifests.length || applicationManifests.length || familyManifests.length || run.resources.accountingClass === finalGoalAccountingClasses.linux
            && run.resources.status === 'verified-local-observations') {
            assert.equal(configuration.accountingClass, finalGoalAccountingClasses.linux, 'Linux originals require the Linux campaign class');
            assert.equal(linuxOriginals.length, 1, 'Missing unique raw Linux cgroup originals');
            // One immutable byte snapshot per Linux run avoids rereading large boundary
            // inventories for each independent resource/output/workload derivation.
            const linuxBytes = new Map(); let linuxCachedBytes = 0;
            const linuxReadBytes = async (receipt, limits) => {
              verifyReceiptIdentity(receipt);
              let bytes = linuxBytes.get(receipt.path);
              if (bytes) {
                assert.equal(bytes.length, limits.expectedSize, 'Cached Linux evidence size differs');
                assert(bytes.length <= limits.maximumFileBytes, 'Cached Linux evidence exceeds member limit');
              } else {
                assert(Number.isSafeInteger(limits.expectedSize) && limits.expectedSize >= 0
                  && limits.expectedSize <= finalGoalEvidenceLimits.maximumLinuxRunCachedBytes - linuxCachedBytes,
                'Linux run retained-byte cache limit exceeded before reading');
                bytes = await jsonFile(receipt.path, receipt.sha256, true, limits, reserveRunBytes);
                linuxBytes.set(receipt.path, bytes); linuxCachedBytes += bytes.length;
              }
              return bytes;
            };
            const manifest = await linuxManifest(linuxOriginals[0], reserveRunBytes);
            assert.equal(manifest.accountingClass, finalGoalAccountingClasses.linux);
            const derived = await reconstructFinalGoalResourceEvidence(manifest, {},
              linuxReadBytes);
            assert.deepEqual(derived, run.resources, 'Linux observations differ from retained original reconstruction');
            linuxResourceObservations.push({ scenarioId: result.id, cellId: cell.id, attemptIndex, engine,
              originals: linuxOriginals[0], captureIdentity: derived.captureIdentity,
              metrics: finalGoalResourceMetrics(configuration, derived), commandInterval: derived.commandInterval,
              wrapperExitCode: derived.wrapperExitCode, observedDrainedMembership: derived.observedDrainedMembership,
              drainRejectionReasons: derived.drainRejectionReasons,
              nativeCleanObservedTeardown: derived.nativeCleanObservedTeardown, adoptedChildren: derived.adoptedChildren,
              resourceAdmission: false, performanceAccepted: false });
            if (outputManifests.length) {
              assert.equal(outputManifests.length, 1, 'Missing unique retained Linux output manifest');
              const outputs = await reconstructFinalGoalLinuxCapturedOutputs(manifest, await linuxManifest(outputManifests[0], reserveRunBytes),
                linuxReadBytes);
              assert.equal(outputs.captureIdentity, derived.captureIdentity, 'Output capture identity differs from resources');
              linuxCapturedOutputs.push({ scenarioId: result.id, cellId: cell.id, attemptIndex, engine, ...outputs });
            }
            assert([applicationManifests, familyManifests, backendManifests].filter(rows => rows.length).length <= 1, 'Cannot mix Linux workload manifests');
            if (backendManifests.length) {
              assert.equal(backendManifests.length, 1, 'Missing unique Linux backend manifest');
              assert.equal(outputManifests.length, 1, 'Backend outcomes require captured outputs');
              assert.equal(result.id, 'application-backend-corpus', 'Unsupported Linux backend scenario');
              const workload = await reconstructFinalGoalLinuxBackend({ resourceManifest: manifest,
                outputManifest: await linuxManifest(outputManifests[0], reserveRunBytes), manifest: await linuxManifest(backendManifests[0], reserveRunBytes),
                readBytes: linuxReadBytes, engine,
                workers: configuration.cells.find(declared => declared.id === cell.id).workers });
              assert.equal(workload.captureIdentity, derived.captureIdentity);
              assert.equal(workload.tests.length, scenarios.get(result.id).expectedTestCount);
              linuxBackendOutcomes.push({ scenarioId: result.id, cellId: cell.id, attemptIndex, engine, ...workload });
            }
            if (familyManifests.length) {
              assert.equal(familyManifests.length, 1, 'Missing unique Linux controlled-family manifest');
              assert.equal(outputManifests.length, 1, 'Family outcomes require captured outputs');
              assert(runnerFamilies.some(family => result.id === `runner-${family}`), 'Unsupported Linux controlled-family scenario');
              const workload = await reconstructFinalGoalLinuxFamily({ resourceManifest: manifest,
                outputManifest: await linuxManifest(outputManifests[0], reserveRunBytes), manifest: await linuxManifest(familyManifests[0], reserveRunBytes),
                readBytes: linuxReadBytes,
                family: result.id.slice('runner-'.length), engine,
                workers: configuration.cells.find(declared => declared.id === cell.id).workers });
              assert.equal(workload.captureIdentity, derived.captureIdentity);
              assert.equal(workload.tests.length, scenarios.get(result.id).expectedTestCount);
              linuxControlledFamilyOutcomes.push({ scenarioId: result.id, cellId: cell.id, attemptIndex, engine, ...workload });
            }
            if (applicationManifests.length) {
              assert.equal(applicationManifests.length, 1, 'Missing unique Linux application manifest');
              assert.equal(outputManifests.length, 1, 'Application outcomes require captured outputs');
              assert(['application-todomvc', 'application-svgomg'].includes(result.id), 'Unsupported Linux application scenario');
              const application = result.id.slice('application-'.length);
              const workload = await reconstructFinalGoalLinuxApplication({ resourceManifest: manifest,
                outputManifest: await linuxManifest(outputManifests[0], reserveRunBytes), manifest: await jsonEvidence(applicationManifests[0], reserveRunBytes),
                readBytes: linuxReadBytes,
                corpus: await loadApplicationCorpus(applicationCorpusDirectory(application)), application, engine,
                workers: configuration.cells.find(declared => declared.id === cell.id).workers });
              assert.equal(workload.captureIdentity, derived.captureIdentity);
              assert.equal(workload.tests.length, scenarios.get(result.id).expectedTestCount);
              linuxApplicationOutcomes.push({ scenarioId: result.id, cellId: cell.id, attemptIndex, engine, ...workload });
            }
          }
        }
      }
    }
  }
  for (const receipt of declaration.approvalEvidence ?? []) {
    const approval = await jsonEvidence(receipt);
    assert.equal(approval.status, 'approved-before-measurement');
    assert.equal(approval.configurationSha256, declaration.configurationSha256);
    assert.equal(approval.resourceCollectorSha256, declaration.resourceCollectorSha256);
  }
  for (const gate of declaration.gates ?? []) for (const receipt of gate.evidence) {
    const admission = await jsonEvidence(receipt);
    assert.equal(admission.status, 'passed');
    assert.equal(admission.gateId, gate.id);
    assert.equal(admission.verifierSha256, gate.verifierSha256);
    assert.equal(admission.sourceManifestSha256, finalGoalHash(declaration.sourceManifest), 'Gate does not bind admitted campaign source');
    if (gate.id === 'resource-collector-admission') assert.deepEqual(admission.resourceContext,
      finalGoalResourceContext(declaration), 'Resource collector admission differs from declared capture context');
  }
  const analysis = analyzeFinalGoal({ configuration, declaration, scenarioResults });
  const analyzedScenarios = new Map(analysis.scenarios.map(scenario => [scenario.id, scenario]));
  for (const result of scenarioResults) {
    const analyzedCells = new Map(analyzedScenarios.get(result.id).cells.map(cell => [cell.id, cell]));
    for (const cell of result.cells) {
      const actualStatus = analyzedCells.get(cell.id).status;
      if (!['confirmed-win', 'uncertain', 'nonwinner'].includes(actualStatus)) continue;
      for (const attempt of cell.attempts) for (const run of Object.values(attempt.runs)) {
        const reserveRunBytes = budget.forRun(run);
        const watchdogReceipt = run.evidence.find(receipt => receipt.kind === 'watchdog');
        const lifecycleReceipt = run.evidence.find(receipt => receipt.kind === 'lifecycle');
        const treeReceipt = run.evidence.find(receipt => receipt.kind === 'owner-tree');
        const manifest = await jsonEvidence(treeReceipt, reserveRunBytes);
        assert.equal(manifest.files?.watchdogReportBytes?.path, watchdogReceipt.path, 'Owner tree borrows another watchdog path');
        assert.equal(manifest.files?.watchdogReportBytes?.sha256, watchdogReceipt.sha256, 'Owner tree borrows another watchdog capture');
        const lifecycle = await jsonEvidence(lifecycleReceipt, reserveRunBytes);
        const derivedResources = await reconstructFinalGoalResourceEvidence(manifest, { lifecycle,
          collectorSha256: declaration.resourceCollectorSha256,
          requiredResourceComponents: scenarios.get(result.id).requiredResourceComponents },
        (receipt, limits) => jsonFile(receipt.path, receipt.sha256, true, limits, reserveRunBytes));
        assert.deepEqual(derivedResources, run.resources, 'Resources differ from original raw owner-tree reconstruction');
        assert.deepEqual(derivedResources.ownerInterval, run.report.ownerInterval, 'Original owner interval differs from report');
        assert.deepEqual(derivedResources.watchdogClock, run.report.watchdogClock, 'Raw watchdog clock differs from original report');
      }
    }
  }

  return { analysis, checkedFiles: Object.fromEntries(checked), linuxResourceObservations, linuxCapturedOutputs, linuxApplicationOutcomes, linuxControlledFamilyOutcomes, linuxBackendOutcomes,
    inputBudget: { ...budget.summary(),
      scope: 'Campaign metadata and each original run have separate cumulative input budgets, within the fixed 288-run topology and aggregate ceiling. Each Linux run reuses one bounded byte snapshot for repeated derivations. Other repeated JSON reads, including later owner reconstruction, are charged again to the same scope; opaque hashing uses a fixed buffer. Parsed object overhead and process RSS are not bounded by these byte limits.' },
    scope: 'Retained file integrity and pure final-goal policy validation. Original behavior, source and collector algorithm admission remain separately required; a draft never proves final acceptance.' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  assert.equal(process.argv.length, 3, 'Usage: verify-final-goal.mjs RETAINED_CAMPAIGN_DIRECTORY');
  const result = await verifyFinalGoalEvidence(process.argv[2]);
  console.log(renderFinalGoalReport(result.analysis));
  process.exitCode = result.analysis.goalAccepted ? 0 : 1;
}
