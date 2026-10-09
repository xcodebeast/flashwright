import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import ts from 'typescript';

const distributionPath = 'node_modules/playwright-core/lib/coreBundle.js';
const distribution = await readFile(distributionPath, 'utf8');
const hash = value => createHash('sha256').update(value).digest('hex');
assert.equal(JSON.parse(await readFile('node_modules/playwright-core/package.json', 'utf8')).version, '1.60.0');
assert.equal(hash(distribution), 'f74353fcb8e406756a70a6af0dfc4a5069acd577e35ec9d923ccf36ac009c2f5', 'Pinned snapshot reference distribution changed');
const selectedClasses = new Map([
  ['SnapshotRenderer', ['render', 'resourceByUrl']],
  ['SnapshotStorage', ['addFrameSnapshot', 'finalize']],
  ['ElementHandle', ['_performPointerAction', '_beforeNonPointerAction']],
  ['Snapshotter', ['start', 'reset', 'stop', '_initialize', '_captureFrameSnapshot', 'captureSnapshot', '_annotateFrameHierarchy']],
  ['Tracing', ['_captureSnapshot', '_shouldCaptureSnapshot', 'onBeforeCall', 'onBeforeInputAction', 'onAfterCall', 'onFrameSnapshot']],
]);
const selectedFunctions = new Set(['frameSnapshotStreamer', 'snapshotScript', 'snapshotNodes', 'isSubtreeReferenceSnapshot', 'isNodeNameAttributesChildNodesSnapshot']);
const parsed = ts.createSourceFile(distributionPath, distribution, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
assert.deepEqual(parsed.parseDiagnostics, []);
const snippets = new Map();

function retain(name, node) {
  assert.ok(!snippets.has(name), `Duplicate pinned snapshot contract: ${name}`);
  const source = node.getText(parsed);
  const firstLine = parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line + 1;
  const lastLine = parsed.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
  snippets.set(name, { source, firstLine, lastLine, sha256: hash(source) });
}
function captureClass(owner, declaration) {
  for (const member of declaration.members) {
    const method = member.name?.getText(parsed);
    if (selectedClasses.get(owner)?.includes(method)) retain(`${owner}.${method}`, member);
  }
}
function visit(node) {
  if (ts.isFunctionDeclaration(node) && selectedFunctions.has(node.name?.text)) retain(node.name.text, node);
  if (ts.isBinaryExpression(node) && ts.isIdentifier(node.left) && ts.isClassExpression(node.right)) captureClass(node.left.text, node.right);
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isClassExpression(node.initializer)) captureClass(node.name.text, node.initializer);
  ts.forEachChild(node, visit);
}
visit(parsed);
for (const name of selectedFunctions) assert.ok(snippets.has(name), `Missing pinned snapshot contract: ${name}`);
for (const [owner, methods] of selectedClasses) for (const method of methods) assert.ok(snippets.has(`${owner}.${method}`), `Missing pinned snapshot contract: ${owner}.${method}`);
const extract = [...snippets].map(([name, snippet]) => `// ${name}: ${distributionPath}:${snippet.firstLine}-${snippet.lastLine}\n${snippet.source}`).join('\n\n') + '\n';
const implementationPaths = [
  'packages/resident-runtime/snapshot-runtime.js', 'packages/resident-runtime/sources.txt',
  'packages/flashwright-core/src/trace-snapshot-record.ts', 'packages/flashwright-core/src/trace-snapshots.ts',
  'packages/flashwright-core/src/trace-recording.ts', 'packages/flashwright-core/src/trace-hooks.ts',
  'packages/flashwright-core/src/trace-transfers.ts', 'packages/flashwright-core/src/trace-writer.ts',
  'packages/flashwright-core/src/tracing.ts', 'crates/flashwright-browser/src/snapshot_reply.rs',
  'crates/flashwright-engine/src/recording.rs', 'crates/flashwright-engine/src/recording/documents.rs',
  'crates/flashwright-engine/src/recording/phases.rs', 'crates/flashwright-engine/src/snapshots/archive.rs',
  'crates/flashwright-engine/src/snapshots/budget.rs', 'crates/flashwright-engine/src/snapshots/document.rs',
  'crates/flashwright-engine/src/snapshots/mod.rs', 'crates/flashwright-engine/src/snapshots/outcome.rs',
  'crates/flashwright-engine/src/diagnostic_sessions.rs',
];
const implementation = Object.fromEntries(await Promise.all(implementationPaths.map(async path => [path, hash(await readFile(path))])));
const licensePath = 'compatibility/upstream/LICENSE.playwright';
const noticePath = 'compatibility/upstream/NOTICE.playwright';
const provenance = {
  referenceVersion: '1.60.0', distributionPath, distributionSha256: hash(distribution),
  sources: [
    'packages/playwright-core/src/server/trace/recorder/snapshotterInjected.ts',
    'packages/playwright-core/src/server/trace/recorder/snapshotter.ts',
    'packages/playwright-core/src/server/trace/recorder/tracing.ts',
    'packages/playwright-core/src/server/dom.ts',
    'packages/isomorphic/trace/snapshotRenderer.ts',
    'packages/isomorphic/trace/snapshotStorage.ts',
  ].map(path => `https://github.com/microsoft/playwright/blob/v1.60.0/${path}`),
  retainedExtract: 'compatibility/upstream/snapshot.source.txt', extractSha256: hash(extract),
  snippets: Object.fromEntries([...snippets].map(([name, { source: _source, ...metadata }]) => [name, metadata])),
  implementation,
  relationship: 'Snapshot serialization conventions and the viewer wire format are adapted from the pinned Playwright reference. The resident collector, bounded cache, native worker, transport decoder and streamed host archive owner are independent implementations. Playwright is used by conformance tools as the reference browser driver and viewer, never as the candidate browser-command backend.',
  changes: [
    'Preserve the node/reference grammar, reconstruction attributes for forms, scroll, shadow DOM and frames, target markers, and snapshot phase names used by the pinned viewer.',
    'Replace upstream DOM-node expandos, prototype instrumentation and retained mutation state with two bounded WeakMap cache generations and explicit capture/commit/discard/reset/retire ownership.',
    'Read admitted CSSOM rules during capture, including inline and adopted stylesheets; bound work, DATA, cache and override representations. Conflicting contents for one external stylesheet URL fail explicitly.',
    'Native workers retain original document, session, call, phase and allocation identities across cancellation and late replies. An archive owns immutable DATA before browser-cache commit; transfer credits survive until host ingestion acknowledgement.',
    'Stream frozen snapshot JSON through bounded UTF-8 encoding buffers; use SHA-256 resource aliases accepted by the viewer instead of the reference SHA-1 digest implementation.',
    'Sample a separate signed native recording clock and map timestamps with retained uncertainty. The common recording/chunk owner seals snapshot admission independently of unfinished public calls.',
    'Public manual snapshots use this bounded foundation and the separately recorded native network collector. Out-of-process frames and unsupported custom-element states fail export explicitly. Runtime, packed-consumer and offline-viewer acceptance remain separate from source provenance.',
  ],
  license: 'Apache-2.0', licensePath, noticePath,
  licenseSha256: hash(await readFile(licensePath)), noticeSha256: hash(await readFile(noticePath)),
};
const directoryIndex = process.argv.indexOf('--output-directory');
const outputDirectory = directoryIndex < 0 ? 'compatibility/upstream' : process.argv[directoryIndex + 1];
assert.ok(outputDirectory && !outputDirectory.startsWith('--'), 'Expected --output-directory path');
const outputs = { 'snapshot.source.txt': extract, 'snapshot-provenance.json': JSON.stringify(provenance, null, 2) + '\n' };
if (!process.argv.includes('--check')) await mkdir(outputDirectory, { recursive: true });
for (const [name, contents] of Object.entries(outputs)) {
  const path = join(outputDirectory, name);
  if (process.argv.includes('--check')) assert.equal(await readFile(path, 'utf8'), contents, `Snapshot provenance differs: ${path}`);
  else await writeFile(path, contents);
}
console.log(`Verified pinned snapshot provenance: ${snippets.size} contracts, ${implementationPaths.length} implementation files.`);
