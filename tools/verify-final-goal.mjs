import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { isAbsolute, join, normalize, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { analyzeFinalGoal, finalGoalHash, renderFinalGoalReport } from '../benchmarks/final-goal-contract.mjs';

const maximumEvidenceBytes = 32 * 1024 * 1024;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

/** Read bounded ordinary evidence files without following links or escaping the retained root. */
async function retainedFile(directory, path) {
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
    assert.ok(index !== path.split('/').length - 1 || information.size <= maximumEvidenceBytes, 'Oversized evidence file');
  }
  const before = await lstat(current);
  const file = await open(current, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = await file.stat();
    assert.ok(opened.isFile() && opened.dev === before.dev && opened.ino === before.ino && opened.size === before.size
      && opened.size <= maximumEvidenceBytes, 'Evidence changed before read');
    const bytes = Buffer.alloc(opened.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const result = await file.read(bytes, length, bytes.length - length, null);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    const after = await file.stat();
    assert.ok(length === opened.size && after.size === opened.size && after.mtimeMs === opened.mtimeMs, 'Evidence changed during read');
    return bytes.subarray(0, length);
  } finally { await file.close(); }
}

/** Bind raw file bytes and recompute acceptance; this does not replace live browser or collector admission. */
export async function verifyFinalGoalEvidence(directory) {
  directory = resolve(directory);
  const campaign = JSON.parse((await retainedFile(directory, 'campaign.json')).toString('utf8'));
  assert.equal(campaign.schemaVersion, 1);
  const checked = new Map();
  async function evidence(entry) {
    assert.match(entry.sha256 ?? '', /^[a-f0-9]{64}$/);
    if (checked.has(entry.path)) {
      assert.equal(checked.get(entry.path).sha256, entry.sha256, 'Retained file has conflicting identities');
      return checked.get(entry.path).bytes;
    }
    const bytes = await retainedFile(directory, entry.path);
    assert.equal(hash(bytes), entry.sha256, 'Retained evidence bytes changed');
    checked.set(entry.path, { sha256: entry.sha256, bytes });
    return bytes;
  }
  const configuration = JSON.parse((await evidence(campaign.configuration)).toString('utf8'));
  const declaration = JSON.parse((await evidence(campaign.declaration)).toString('utf8'));
  assert.ok(Array.isArray(campaign.scenarios));
  const scenarioResults = [];
  for (const entry of campaign.scenarios) {
    const result = JSON.parse((await evidence(entry)).toString('utf8'));
    assert.equal(result.id, entry.scenarioId, 'Retained scenario was relabelled');
    scenarioResults.push(result);
    for (const cell of result.cells) {
      for (const receipt of cell.evidence ?? []) await evidence(receipt);
      for (const attempt of cell.attempts) {
        for (const receipt of attempt.evidence ?? []) await evidence(receipt);
        for (const run of Object.values(attempt.runs ?? {})) {
          for (const receipt of run.evidence) await evidence(receipt);
          for (const kind of ['report', 'resources']) {
            const files = run.evidence.filter(receipt => receipt.kind === kind);
            assert.equal(files.length, 1, `Missing unique raw ${kind} file`);
            assert.deepEqual(JSON.parse((await evidence(files[0])).toString('utf8')), run[kind], `Inline ${kind} differs from original raw file`);
          }
          for (const test of run.report.tests) for (const receipt of test.diagnostics?.evidence ?? []) await evidence(receipt);
        }
      }
    }
  }
  for (const receipt of declaration.approvalEvidence ?? []) {
    const approval = JSON.parse((await evidence(receipt)).toString('utf8'));
    assert.equal(approval.status, 'approved-before-measurement');
    assert.equal(approval.configurationSha256, declaration.configurationSha256);
    assert.equal(approval.resourceCollectorSha256, declaration.resourceCollectorSha256);
  }
  for (const gate of declaration.gates ?? []) for (const receipt of gate.evidence) {
    const admission = JSON.parse((await evidence(receipt)).toString('utf8'));
    assert.equal(admission.status, 'passed');
    assert.equal(admission.gateId, gate.id);
    assert.equal(admission.verifierSha256, gate.verifierSha256);
    assert.equal(admission.sourceManifestSha256, finalGoalHash(declaration.sourceManifest), 'Gate does not bind admitted campaign source');
  }
  const analysis = analyzeFinalGoal({ configuration, declaration, scenarioResults });
  return { analysis, checkedFiles: Object.fromEntries([...checked].map(([path, value]) => [path, value.sha256])),
    scope: 'Retained file integrity and pure final-goal policy validation. Original behavior, source and collector algorithm admission remain separately required; a draft never proves final acceptance.' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  assert.equal(process.argv.length, 3, 'Usage: verify-final-goal.mjs RETAINED_CAMPAIGN_DIRECTORY');
  const result = await verifyFinalGoalEvidence(process.argv[2]);
  console.log(renderFinalGoalReport(result.analysis));
  process.exitCode = result.analysis.goalAccepted ? 0 : 1;
}
