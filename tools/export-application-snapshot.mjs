import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { applicationEvidenceFiles, applicationEvidenceHashes, normalizeApplicationEvidence, numericApplicationObservations } from './application-snapshot.mjs';
import { hash } from './competitor-inputs.mjs';
import { verifyApplicationSuite } from './verify-application-suite.mjs';

assert.equal(process.argv.length, 4, 'Usage: export-application-snapshot.mjs VERIFIED_RAW_DIRECTORY NEW_SNAPSHOT_DIRECTORY');
const source = resolve(process.argv[2]);
const destination = resolve(process.argv[3]);
assert.ok(destination !== source && !destination.startsWith(source + '/'), 'Snapshot must be outside raw evidence');
await verifyApplicationSuite(source);
const original = await applicationEvidenceFiles(source);
assert.equal(original['snapshot.json'], undefined, 'Export original evidence only');
const originalReceipt = JSON.parse(original['admission.json']);
const originalInputs = JSON.parse(original['inputs.json']);
const originalHashes = applicationEvidenceHashes(original);
assert.deepEqual(Object.fromEntries(Object.entries(originalHashes).filter(([path]) => path !== 'admission.json')), originalReceipt.files);
const exported = normalizeApplicationEvidence(original, originalInputs);
const receipt = JSON.parse(exported['admission.json']);
for (const [engine, run] of Object.entries(receipt.runs)) {
  run.generatedHashes = Object.fromEntries(Object.keys(run.generatedHashes).map(path => [path, hash(exported[join(engine, path)])]));
  for (const record of run.generatedSources) record.generatedSha256 = run.generatedHashes[record.path];
}
receipt.files = applicationEvidenceHashes(Object.fromEntries(Object.entries(exported).filter(([path]) => path !== 'admission.json')));
exported['admission.json'] = Buffer.from(JSON.stringify(receipt, null, 2) + '\n');
for (const path of Object.keys(exported).filter(path => path.endsWith('.json'))) {
  assert.deepEqual(numericApplicationObservations(JSON.parse(exported[path])), numericApplicationObservations(JSON.parse(original[path])), `Numeric evidence changed: ${path}`);
}
const manifest = {
  schemaVersion: 1,
  kind: 'portable-application-evidence',
  applicationName: originalInputs.applicationName,
  scope: 'Path-normalized historical functional evidence. Verify from the recorded source checkout. Executable and installed dependency hashes are retained identities, not freshly verified bytes. No performance acceptance.',
  originalFileSha256: originalHashes,
  exportedFileSha256: applicationEvidenceHashes(exported),
  numericObservationsUnchanged: true,
};
await mkdir(destination);
for (const [path, contents] of Object.entries(exported)) {
  await mkdir(dirname(join(destination, path)), { recursive: true });
  await writeFile(join(destination, path), contents, { flag: 'wx' });
}
await verifyApplicationSuite(destination, { portable: true });
await writeFile(join(destination, 'snapshot.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ destination, applicationName: manifest.applicationName, applicationAdmissionPassed: receipt.applicationAdmissionPassed, performanceAccepted: false }, null, 2));
