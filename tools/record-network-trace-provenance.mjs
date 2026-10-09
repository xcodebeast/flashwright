import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import typescript from 'typescript';

const distributionPath = 'node_modules/playwright-core/lib/coreBundle.js';
const source = await readFile(distributionPath, 'utf8');
const hash = value => createHash('sha256').update(value).digest('hex');
assert.equal(JSON.parse(await readFile('node_modules/playwright-core/package.json', 'utf8')).version, '1.60.0');
assert.equal(hash(source), 'f74353fcb8e406756a70a6af0dfc4a5069acd577e35ec9d923ccf36ac009c2f5');
const selectedClasses = new Map([
  ['HarTracer', ['_onRequest', '_recordRequestHeadersAndCookies', '_onRequestFinished', '_onRequestFailed', '_storeResponseContent', '_onResponse', '_recordResponseHeaders', '_computeHarEntryTotalTime', '_postDataForBuffer']],
  ['Request', ['_requestHeadersSize']],
  ['Helper', ['secondsToRoundishMillis', 'millisToRoundishMillis']],
  ['Response2', ['_requestFinished', '_httpVersion', 'responseHeadersSize', '_sizes']],
  ['CRNetworkManager', ['_createResponse', '_handleRequestRedirect', '_onLoadingFinished', '_onLoadingFailed']],
  ['ResponseExtraInfoTracker', ['_patchHeaders']],
]);
const selectedFunctions = new Set(['createHarEntry', 'parseCookie', 'safeDateToISOString', 'headersObjectToArray']);
const syntax = typescript.createSourceFile(distributionPath, source, typescript.ScriptTarget.Latest, true, typescript.ScriptKind.JS);
assert.deepEqual(syntax.parseDiagnostics, []);
const snippets = new Map();
function retain(name, node) {
  assert.ok(!snippets.has(name), `Duplicate reference: ${name}`);
  const text = node.getText(syntax);
  snippets.set(name, { text, firstLine: syntax.getLineAndCharacterOfPosition(node.getStart(syntax)).line + 1, lastLine: syntax.getLineAndCharacterOfPosition(node.getEnd()).line + 1, sha256: hash(text) });
}
function visit(node) {
  if (typescript.isFunctionDeclaration(node) && selectedFunctions.has(node.name?.text)) retain(node.name.text, node);
  if (typescript.isBinaryExpression(node) && typescript.isIdentifier(node.left) && typescript.isClassExpression(node.right)) {
    for (const member of node.right.members) if (selectedClasses.get(node.left.text)?.includes(member.name?.getText(syntax))) retain(`${node.left.text}.${member.name.getText(syntax)}`, member);
  }
  typescript.forEachChild(node, visit);
}
visit(syntax);
for (const name of selectedFunctions) assert.ok(snippets.has(name), `Missing reference: ${name}`);
for (const [owner, methods] of selectedClasses) for (const method of methods) assert.ok(snippets.has(`${owner}.${method}`), `Missing reference: ${owner}.${method}`);
const extract = [...snippets].map(([name, snippet]) => `// ${name}: ${distributionPath}:${snippet.firstLine}-${snippet.lastLine}\n${snippet.text}`).join('\n\n') + '\n';
const implementationPaths = [
  'packages/flashwright-core/src/trace-network-entry.ts', 'packages/flashwright-core/src/trace-network.ts',
  'packages/flashwright-core/src/trace-recording.ts', 'packages/flashwright-core/src/trace-writer.ts', 'packages/flashwright-core/src/tracing.ts',
  'crates/flashwright-engine/src/recording.rs', 'crates/flashwright-engine/src/recording/network.rs',
  'crates/flashwright-engine/src/recording/network/journal.rs', 'crates/flashwright-engine/src/recording/network/observer.rs',
  'crates/flashwright-engine/src/recording/network/ownership.rs', 'crates/flashwright-engine/src/recording/network/resources.rs',
  'crates/flashwright-engine/src/recording/network/worker.rs', 'crates/flashwright-engine/src/diagnostic_sessions.rs',
  'tools/test-trace-network-entry.mjs', 'tools/test-trace-network.mjs', 'tools/run-native-network-trace-tests.mjs', 'tools/run-snapshot-resource-tests.mjs',
];
const implementation = Object.fromEntries(await Promise.all(implementationPaths.map(async path => [path, hash(await readFile(path))])));
const licensePath = 'compatibility/upstream/LICENSE.playwright';
const noticePath = 'compatibility/upstream/NOTICE.playwright';
const provenance = {
  referenceVersion: '1.60.0', distributionPath, distributionSha256: hash(source),
  sources: ['packages/playwright-core/src/server/har/harTracer.ts', 'packages/playwright-core/src/server/network.ts', 'packages/playwright-core/src/server/chromium/crNetworkManager.ts', 'packages/playwright-core/src/server/helper.ts'].map(path => `https://github.com/microsoft/playwright/blob/v1.60.0/${path}`),
  retainedExtract: 'compatibility/upstream/network-trace.source.txt', extractSha256: hash(extract),
  snippets: Object.fromEntries([...snippets].map(([name, { text: _text, ...metadata }]) => [name, metadata])), implementation,
  relationship: 'The private HAR converter adapts the pinned trace entry format, cookie parsing and timing/size arithmetic. The native recording journal supplies original occurrences, bounded resources and exact-session body ownership; the host writes sealed prefixes and immutable resources. Controlled converter tests execute extracted pinned HAR methods; native and offline-viewer fixtures separately exercise live collection. This source provenance does not itself establish conformance or public activation.',
  changes: [
    'Convert one bounded immutable native journal version; do not collect traffic, fetch bodies, mutate recording state or issue browser commands.',
    'Use explicit mapped page/clock identities and retained cookie parse wall time. Preserve original request URL, method and body while effective request values affect the header-size estimate.',
    'Resolve body tokens only through already-owned immutable aliases with exact byte-length agreement. Accept SHA-1 and SHA-256 aliases; preserve pending, unavailable and captured empty outcomes.',
    'Retain reference UTF-16 header estimates, double timing truncation, plain-HTTP ssl timing quirk, canonical response status and raw-extra header-size presence semantics.',
    'Reject malformed/non-finite metadata, accessors, cycles, resource alias mismatches and configured metadata/output/collection/string bounds rather than producing partially fabricated entries.',
    'Do not reproduce the reference Network.loadNetworkResource refetch fallback. Missing original response bytes remain explicitly unavailable.',
    'Public snapshots remain gated independently of these private implementation files. Verification checkpoints separately record native collector, asynchronous ownership, original-server-off viewer and runtime coverage.',
  ],
  license: 'Apache-2.0', licensePath, noticePath,
  licenseSha256: hash(await readFile(licensePath)), noticeSha256: hash(await readFile(noticePath)),
};
const directoryIndex = process.argv.indexOf('--output-directory');
const outputDirectory = directoryIndex < 0 ? 'compatibility/upstream' : process.argv[directoryIndex + 1];
assert.ok(outputDirectory && !outputDirectory.startsWith('--'));
if (!process.argv.includes('--check')) await mkdir(outputDirectory, { recursive: true });
for (const [name, contents] of Object.entries({ 'network-trace.source.txt': extract, 'network-trace-provenance.json': JSON.stringify(provenance, null, 2) + '\n' })) {
  const path = join(outputDirectory, name);
  if (process.argv.includes('--check')) assert.equal(await readFile(path, 'utf8'), contents, `Network trace provenance differs: ${path}`);
  else await writeFile(path, contents);
}
console.log(`Verified network trace provenance: ${snippets.size} contracts, ${implementationPaths.length} implementation files.`);
