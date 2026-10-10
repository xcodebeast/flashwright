import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile, rm, rename, realpath, lstat } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { applicationEvidenceFiles, applicationEvidenceHashes, numericApplicationObservations } from './application-snapshot.mjs';
import { hash } from './competitor-inputs.mjs';

const privatePath = /(?<![a-zA-Z0-9_.-])\/(?:Users|home)\/|(?<![a-zA-Z0-9_.-])\/(?:private\/)?(?:var|tmp)\//;
const decode = bytes => {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  assert.ok(!text.includes('\0'), 'Binary evidence is unsupported');
  return text;
};
const parse = (files, path) => JSON.parse(decode(files[path]));
const serialize = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const nested = (parent, child) => relative(parent, child) === '' || (!relative(parent, child).startsWith('..') && !isAbsolute(relative(parent, child)));
const coreVerificationLog = path => /^verification\/[^/]+\.(?:txt|log)$/.test(path);

/** Inspect URL escapes without requiring opaque stdout to contain valid UTF-8. */
function decodedPathInspection(text, opaqueBytes) {
  if (opaqueBytes) return text.replace(/%([a-f0-9]{2})/gi, (_, hexadecimal) => String.fromCharCode(Number.parseInt(hexadecimal, 16)));
  return decodeURIComponent(text.replace(/%(?![a-f0-9]{2})/gi, '%25'));
}

/** Explicit roots only; mappings are private inputs and are never published. */
export function normalizeBroadEvidence(files, mappings) {
  const originals = new Set();
  const replacements = mappings.flatMap(({ original, replacement }) => {
    assert.ok(typeof original === 'string' && isAbsolute(original) && resolve(original) === original && original.split('/').filter(Boolean).length >= 2, 'Mapping requires a specific absolute path');
    assert.ok(!/^\/(?:Users|home)\/[^/]+$/.test(original), 'Home mapping root is too broad');
    assert.ok(!/^\/(?:private\/)?var\/folders\/[^/]+(?:\/[^/]+(?:\/T)?)?$/.test(original), 'Temporary mapping root is too broad');
    assert.ok(!['/Users', '/home', '/var', '/private/var', '/var/folders', '/tmp'].includes(original), 'Mapping root is too broad');
    assert.match(replacement, /^\/(?:workspace|retained\/broad-matrix|runtime\/executable|browser\/executable|environment\/[a-z][a-z0-9-]*)(?:\/|$)/);
    assert.ok(!privatePath.test(replacement) && !replacement.includes('..'));
    assert.ok(!originals.has(original), 'Duplicate mapping root');
    originals.add(original);
    return [[original, replacement], [pathToFileURL(original).href, pathToFileURL(replacement).href]];
  }).sort((left, right) => right[0].length - left[0].length);
  const output = {};
  for (const [path, bytes] of Object.entries(files)) {
    assert.ok(['.json', '.jsonl', '.txt', '.log', '.md', '.js', '.cjs', '.mjs'].includes(extname(path)), `Unsupported evidence type: ${path}`);
    assert.ok(!privatePath.test(path), 'Private path in evidence filename');
    const opaqueBytes = coreVerificationLog(path);
    // Latin1 is an internal one-byte representation, not a conversion of log encoding.
    const encoding = opaqueBytes ? 'latin1' : 'utf8';
    let text = opaqueBytes ? bytes.toString(encoding) : decode(bytes);
    if (path.endsWith('/runner-result.json')) {
      const environment = JSON.parse(text).config?.env ?? {};
      assert.ok(Object.keys(environment).every(key => ['CACHE_FOLDER', 'RUN_BINARY'].includes(key)), 'Unreviewed Cypress environment field');
    }
    for (const [originalPath, replacementPath] of replacements) {
      const original = opaqueBytes ? Buffer.from(originalPath).toString(encoding) : originalPath;
      const replacement = opaqueBytes ? Buffer.from(replacementPath).toString(encoding) : replacementPath;
      // Do not turn a known directory prefix into permission to rewrite siblings.
      text = text.replaceAll(original, (match, offset, whole) => {
        const next = whole[offset + match.length];
        return next === undefined || /[\/\s"'<>),\]:\\]/.test(next) ? replacement : match;
      });
    }
    assert.ok(!privatePath.test(text) && !privatePath.test(decodedPathInspection(text, opaqueBytes)), `Unmapped private path in ${path}`);
    output[path] = Buffer.from(text, encoding);
  }
  return output;
}

function cypressSampleMarker(files, root) {
  const sample = files[`${root}/sample.json`];
  const stdout = files[`${root}/stdout.txt`];
  assert.ok(sample && stdout, 'Cypress evidence must retain its sample and stdout hash marker');
  const marker = `flashwright-cypress-report ${hash(sample)}`;
  assert.deepEqual(decode(stdout).split(/\r?\n/).filter(line => line.startsWith('flashwright-cypress-report ')), [marker], `Cypress stdout sample marker mismatch: ${root}`);
  return marker;
}

/** Artifact custody checks complement, rather than replace, the recorded-source verifier. */
export function assertBroadArtifactLinks(files) {
  for (const path of Object.keys(files).filter(path => /(?:^|\/)admission\.json$/.test(path))) {
    const root = dirname(path);
    const prefix = `${root}/`;
    const actual = Object.fromEntries(Object.entries(files)
      .filter(([file]) => file.startsWith(prefix) && file !== path)
      .map(([file, bytes]) => [file.slice(prefix.length), hash(bytes)]));
    assert.deepEqual(parse(files, path).files, actual, `Competitor receipt inventory or bytes mismatch: ${root}`);
    if (root.endsWith('-cypress')) cypressSampleMarker(files, root);
  }
}

/** Recompute only the established artifact hash edges, never recorded source identities. */
export function rebuildBroadEvidence(files, originalFiles) {
  const verification = parse(files, 'verification/report.json');
  for (const check of verification.checks) {
    const path = `verification/${check.log}`;
    assert.ok(files[path], 'Missing core verification log');
    check.logSha256 = hash(files[path]);
  }
  files['verification/report.json'] = serialize(verification);
  const metadata = parse(files, 'metadata.json');
  metadata.verificationSha256 = hash(files['verification/report.json']);
  files['metadata.json'] = serialize(metadata);
  for (const path of Object.keys(files).filter(path => /(?:^|\/)admission\.json$/.test(path))) {
    const root = dirname(path);
    if (root.endsWith('-cypress')) {
      const stdout = `${root}/stdout.txt`;
      const sample = `${root}/sample.json`;
      cypressSampleMarker(originalFiles, root);
      files[stdout] = Buffer.from(decode(files[stdout]).replace(/^flashwright-cypress-report [^\r\n]*(?=\r?$)/m, `flashwright-cypress-report ${hash(files[sample])}`));
    }
    const receipt = parse(files, path);
    for (const name of Object.keys(receipt.files)) {
      assert.ok(files[`${root}/${name}`], 'Missing competitor receipt artifact');
      receipt.files[name] = hash(files[`${root}/${name}`]);
    }
    files[path] = serialize(receipt);
  }
  const summary = parse(files, 'summary.json');
  summary.retainedFileHashes = applicationEvidenceHashes(Object.fromEntries(Object.entries(files).filter(([path]) => !['summary.json', 'table.md'].includes(path))));
  files['summary.json'] = serialize(summary);
  for (const [path, original] of Object.entries(originalFiles)) {
    if (path.endsWith('.json')) {
      const before = JSON.parse(decode(original));
      const after = parse(files, path);
      assert.deepEqual(numericApplicationObservations(after), numericApplicationObservations(before), `Numeric observation changed: ${path}`);
      for (const key of ['sources', 'inputs', 'installedDependencies', 'competitorDependencies', 'bundle', 'cypressBundleFiles']) {
        if (before[key] !== undefined) assert.deepEqual(after[key], before[key], `Recorded identity changed: ${path}/${key}`);
      }
    } else if (path.endsWith('.jsonl')) {
      const observations = bytes => decode(bytes).split('\n').filter(line => line.trim()).map(line => numericApplicationObservations(JSON.parse(line)));
      assert.deepEqual(observations(files[path]), observations(original), `Numeric observation changed: ${path}`);
    }
  }
  assert.deepEqual(files['table.md'], originalFiles['table.md'], 'Comparison table must remain byte-for-byte unchanged');
  return files;
}

function verifyRecorded(workspace, directory) {
  return execFileSync(process.execPath, [join(workspace, 'tools/verify-broad-matrix.mjs'), directory], { cwd: workspace, encoding: 'utf8', stdio: 'pipe', maxBuffer: 4 * 1024 * 1024 });
}

export async function exportBroadMatrix({ sourceDirectory, destination, recordedWorkspace, mappings = [] }) {
  const source = await realpath(sourceDirectory);
  const workspace = await realpath(recordedWorkspace);
  const target = resolve(destination);
  assert.ok(!nested(source, target) && !nested(target, source), 'Export destination must be separate from raw evidence');
  await mkdir(dirname(target), { recursive: true });
  assert.equal(await lstat(target).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; }), false, 'Destination already exists');
  const originalFiles = await applicationEvidenceFiles(source);
  const originalHashes = applicationEvidenceHashes(originalFiles);
  verifyRecorded(workspace, source);
  assertBroadArtifactLinks(originalFiles);
  const metadata = parse(originalFiles, 'metadata.json');
  const automatic = [
    { original: source, replacement: '/retained/broad-matrix' },
    ...(resolve(sourceDirectory) === source ? [] : [{ original: resolve(sourceDirectory), replacement: '/retained/broad-matrix' }]),
    { original: workspace, replacement: '/workspace' },
    { original: metadata.measuredRuntime.executable, replacement: '/runtime/executable' },
    { original: metadata.browser.executablePath, replacement: '/browser/executable' },
  ];
  const files = rebuildBroadEvidence(normalizeBroadEvidence(originalFiles, [...automatic.filter(mapping => isAbsolute(mapping.original)), ...mappings]), originalFiles);
  assertBroadArtifactLinks(files);
  const staging = `${target}.export-${process.pid}`;
  await mkdir(staging);
  try {
    for (const [path, bytes] of Object.entries(files)) {
      await mkdir(dirname(join(staging, 'evidence', path)), { recursive: true });
      await writeFile(join(staging, 'evidence', path), bytes);
    }
    verifyRecorded(workspace, join(staging, 'evidence'));
    assert.deepEqual(applicationEvidenceHashes(await applicationEvidenceFiles(source)), originalHashes, 'Raw evidence changed during export');
    const manifest = { schemaVersion: 1, kind: 'portable-broad-matrix', originalVerification: 'recorded-source-checkout', portableVerification: 'same-recorded-source-checkout',
      liveExecutableBytesVerified: false, installedDependencyBytesVerified: false, sourceIdentitiesPreserved: true, numericObservationsPreserved: true,
      originalFiles: originalHashes, exportedFiles: applicationEvidenceHashes(files), recordedSources: metadata.sources };
    await writeFile(join(staging, 'manifest.json'), serialize(manifest));
    await rename(staging, target);
    return manifest;
  } catch (error) { await rm(staging, { recursive: true, force: true }); throw error; }
}

export async function verifyBroadSnapshot(directory, recordedWorkspace) {
  const files = await applicationEvidenceFiles(directory);
  const manifest = parse(files, 'manifest.json');
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.kind, 'portable-broad-matrix');
  assert.equal(manifest.originalVerification, 'recorded-source-checkout');
  assert.equal(manifest.portableVerification, 'same-recorded-source-checkout');
  for (const key of ['liveExecutableBytesVerified', 'installedDependencyBytesVerified']) assert.equal(manifest[key], false);
  for (const key of ['sourceIdentitiesPreserved', 'numericObservationsPreserved']) assert.equal(manifest[key], true);
  const evidence = Object.fromEntries(Object.entries(files).filter(([path]) => path.startsWith('evidence/')).map(([path, bytes]) => [path.slice(9), bytes]));
  assert.equal(Object.keys(files).length, Object.keys(evidence).length + 1, 'Unexpected snapshot artifact');
  assert.deepEqual(applicationEvidenceHashes(evidence), manifest.exportedFiles, 'Export inventory or bytes changed');
  assert.deepEqual(Object.keys(manifest.originalFiles).sort(), Object.keys(manifest.exportedFiles).sort(), 'Export omitted original evidence');
  assert.deepEqual(parse(evidence, 'metadata.json').sources, manifest.recordedSources);
  normalizeBroadEvidence(evidence, []); // Independent privacy/type validation, without mutation.
  assertBroadArtifactLinks(evidence);
  verifyRecorded(await realpath(recordedWorkspace), join(resolve(directory), 'evidence'));
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [command, sourceDirectory, destination, recordedWorkspace, mappingFile] = process.argv.slice(2);
  if (command === 'export') {
    const { readFile } = await import('node:fs/promises');
    assert.ok(sourceDirectory && destination && recordedWorkspace, 'Usage: broad-matrix-snapshot.mjs export RAW DESTINATION RECORDED_WORKSPACE [PRIVATE_MAPPING_JSON]');
    await exportBroadMatrix({ sourceDirectory, destination, recordedWorkspace, mappings: mappingFile ? JSON.parse(await readFile(mappingFile, 'utf8')) : [] });
    console.log('Exported and verified portable broad-matrix evidence');
  } else {
    assert.ok(command === 'verify' && sourceDirectory && destination, 'Usage: broad-matrix-snapshot.mjs verify SNAPSHOT RECORDED_WORKSPACE');
    await verifyBroadSnapshot(sourceDirectory, destination);
    console.log('Verified portable broad-matrix evidence');
  }
}
