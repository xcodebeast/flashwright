import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hash } from './competitor-inputs.mjs';
import { assertBroadArtifactLinks, normalizeBroadEvidence } from './broad-matrix-snapshot.mjs';
import { applicationEvidenceFiles } from './application-snapshot.mjs';
const evidence = text => ({ 'report.json': Buffer.from(JSON.stringify({ text, elapsed: 12.345 })) });
const mappings = [{ original: '/Users/example/project', replacement: '/workspace' }];
test('known root and encoded file URL normalize while numeric bytes remain unchanged', () => {
  const output = normalizeBroadEvidence(evidence('/Users/example/project/a file file:///Users/example/project/a%20file'), mappings);
  assert.deepEqual(JSON.parse(output['report.json']), { text: '/workspace/a file file:///workspace/a%20file', elapsed: 12.345 });
});
for (const path of ['/Users/example/project-sibling/test', '/home/someone/report', '/tmp/unreviewed/report', '/private/var/tmp/report', 'file:///%55sers/unknown/report']) {
  test(`rejects unknown private path ${path}`, () => assert.throws(() => normalizeBroadEvidence(evidence(path), mappings), /Unmapped private path/));
}
for (const original of ['/Users/example', '/home/example', '/tmp', '/var/folders/ab/random/T']) {
  test(`rejects broad normalization root ${original}`, () => assert.throws(() => normalizeBroadEvidence(evidence('safe'), [{ original, replacement: '/workspace' }])));
}
test('rejects binary, malformed UTF-8 and unsupported artifacts', () => {
  for (const files of [{ 'report.json': Buffer.from([0]) }, { 'report.json': Buffer.from([255]) }, { 'capture.png': Buffer.from('text') }]) assert.throws(() => normalizeBroadEvidence(files, []));
});
for (const extension of ['txt', 'log']) test(`flat core verification ${extension} logs preserve every byte outside explicit path substitutions`, () => {
  const path = `verification/core.${extension}`;
  const opaque = Buffer.from(Array.from({ length: 256 }, (_, value) => value));
  const files = { [path]: Buffer.concat([opaque, Buffer.from('\n/Users/example/project/core\n'), opaque]) };
  assert.deepEqual(normalizeBroadEvidence(files, mappings)[path], Buffer.concat([opaque, Buffer.from('\n/workspace/core\n'), opaque]));
  assert.deepEqual(normalizeBroadEvidence({ [path]: opaque }, [])[path], opaque);
});
test('opaque core log replacements preserve Unicode bytes and encoded file URLs', () => {
  const original = '/Users/example/projéct/测试';
  const replacement = '/environment/logs/保留';
  const prefix = Buffer.from([0xff, 0, 0xfe]);
  const suffix = Buffer.from(' café %ff\n');
  const path = 'verification/51-node.txt';
  const files = { [path]: Buffer.concat([prefix, Buffer.from(`${original}/file file:///Users/example/proj%C3%A9ct/%E6%B5%8B%E8%AF%95/file`), suffix]) };
  const expected = Buffer.concat([prefix, Buffer.from(`${replacement}/file file:///environment/logs/%E4%BF%9D%E7%95%99/file`), suffix]);
  assert.deepEqual(normalizeBroadEvidence(files, [{ original, replacement }])[path], expected);
});
for (const unknownPath of ['/Users/example/project-sibling/test', '/tmp/unreviewed/report', 'file:///%55sers/unknown/report', '%2fhome%2fsomeone/report']) {
  test(`opaque core logs still reject unknown private path ${unknownPath}`, () => {
    const files = { 'verification/core.txt': Buffer.concat([Buffer.from([0xff, 0]), Buffer.from(` ${unknownPath}`)]) };
    assert.throws(() => normalizeBroadEvidence(files, mappings), /Unmapped private path/);
  });
}
for (const path of ['verification/report.json', 'verification/report.jsonl', 'verification/report.md', 'verification/nested/core.txt', 'stdout.txt', 'launch-0-cypress/stdout.txt']) {
  test(`opaque byte policy does not extend to ${path}`, () => {
    for (const invalidBytes of [Buffer.from([0xff]), Buffer.from('text\0')]) {
      assert.throws(() => normalizeBroadEvidence({ [path]: invalidBytes }, []));
    }
  });
}
test('rejects unreviewed Cypress environment entries instead of omitting them', () => {
  assert.throws(() => normalizeBroadEvidence({ 'launch-0-cypress/runner-result.json': Buffer.from(JSON.stringify({ config: { env: { TOKEN: 'synthetic-secret' } } })) }, []), /Unreviewed Cypress environment/);
});
test('rejects symlink evidence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'flashwright-snapshot-link-'));
  try {
    await writeFile(join(directory, 'real.json'), '{}');
    await symlink('real.json', join(directory, 'alias.json'));
    await assert.rejects(applicationEvidenceFiles(directory), /symbolic links/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('relative dependency names are not absolute private directories', () => {
  const files = evidence('node_modules/@types/tmp/LICENSE node_modules/tmp/package.json');
  assert.deepEqual(normalizeBroadEvidence(files, []), files);
});

function cypressArtifacts() {
  const root = 'launch-0-cypress';
  const sample = Buffer.from('{"elapsed":42}\n');
  return receiptFor({ [`${root}/sample.json`]: sample,
    [`${root}/stdout.txt`]: Buffer.from(`runner output\nflashwright-cypress-report ${hash(sample)}\n`),
    [`${root}/runner-result.json`]: Buffer.from('{"totalDuration":42}\n') });
}
function receiptFor(files) {
  const root = 'launch-0-cypress';
  const receipt = Object.fromEntries(Object.entries(files).filter(([path]) => path !== `${root}/admission.json`).map(([path, bytes]) => [path.slice(root.length + 1), hash(bytes)]));
  return { ...files, [`${root}/admission.json`]: Buffer.from(JSON.stringify({ files: receipt })) };
}
test('complete Cypress artifact inventory and sample marker validate', () => assertBroadArtifactLinks(cypressArtifacts()));
for (const [name, change] of [
  ['wrong marker', files => { files['launch-0-cypress/stdout.txt'] = Buffer.from(`flashwright-cypress-report ${'0'.repeat(64)}\n`); }],
  ['additional different marker', files => { files['launch-0-cypress/stdout.txt'] = Buffer.concat([files['launch-0-cypress/stdout.txt'], Buffer.from(`flashwright-cypress-report ${'0'.repeat(64)}\n`)]); }],
  ['duplicate marker', files => { files['launch-0-cypress/stdout.txt'] = Buffer.concat([files['launch-0-cypress/stdout.txt'], files['launch-0-cypress/stdout.txt']]); }],
  ['marker embedded in non-marker line', files => { files['launch-0-cypress/stdout.txt'] = Buffer.from(`prefix flashwright-cypress-report ${hash(files['launch-0-cypress/sample.json'])}\n`); }],
  ['sample changed with old marker', files => { files['launch-0-cypress/sample.json'] = Buffer.from('{"elapsed":21}\n'); }],
]) test(`rejects ${name} even after receipt hashes are recomputed`, () => {
  const files = cypressArtifacts(); change(files);
  assert.throws(() => assertBroadArtifactLinks(receiptFor(files)), /Cypress stdout sample marker mismatch/);
});
test('receipt cannot omit an artifact that outer inventory still retains', () => {
  const files = cypressArtifacts();
  const receipt = JSON.parse(files['launch-0-cypress/admission.json']);
  delete receipt.files['runner-result.json'];
  files['launch-0-cypress/admission.json'] = Buffer.from(JSON.stringify(receipt));
  assert.throws(() => assertBroadArtifactLinks(files), /Competitor receipt inventory/);
});
