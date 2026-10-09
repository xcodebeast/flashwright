import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import ts from 'typescript';
const distributionPath = 'node_modules/playwright-core/lib/coreBundle.js';
const distribution = await readFile(distributionPath, 'utf8');
assert.equal(JSON.parse(await readFile('node_modules/playwright-core/package.json')).version, '1.60.0');
const parsed = ts.createSourceFile(distributionPath, distribution, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const selected = new Map([
  ['Screencast', ['_startScreencast', '_stopScreencast', 'onScreencastFrame']],
  ['ScreencastTracingRecorder', ['constructor', 'dispose', 'temporarilyDisableThrottling', '_clearPendingAck']],
  ['Tracing', ['_startScreencast', '_stopScreencast', '_startScreencastInPage', '_temporarilyDisableThrottling', 'onBeforeCall', 'onBeforeInputAction', 'onAfterCall']],
  ['CRPage', ['startScreencast', 'stopScreencast']],
  ['FrameSession', ['_onScreencastFrame']],
]);
const snippets = new Map();
function visit(node) {
  if (ts.isBinaryExpression(node) && ts.isIdentifier(node.left) && ts.isClassExpression(node.right)) {
    const methods = selected.get(node.left.text);
    if (methods) for (const member of node.right.members) {
      const name = ts.isConstructorDeclaration(member) ? 'constructor' : member.name?.getText(parsed);
      if (methods.includes(name)) snippets.set(`${node.left.text}.${name}`, member.getText(parsed));
    }
  }
  if (ts.isBinaryExpression(node) && ts.isIdentifier(node.left) && ['throttledRate', 'unthrottleDuration'].includes(node.left.text)) snippets.set(node.left.text, node.getText(parsed));
  ts.forEachChild(node, visit);
}
visit(parsed);
const names = ['throttledRate', 'unthrottleDuration', ...[...selected].flatMap(([owner, methods]) => methods.map(method => `${owner}.${method}`))];
for (const name of names) assert.ok(snippets.has(name), `Missing pinned filmstrip contract ${name}`);
const extract = names.map(name => `// ${name}\n${snippets.get(name)}`).join('\n\n') + '\n';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const implementation = {};
for (const path of [
  'crates/flashwright-engine/src/filmstrip.rs', 'crates/flashwright-engine/src/filmstrip/frame_store.rs', 'crates/flashwright-engine/src/filmstrip/page_capture.rs',
  'crates/flashwright-engine/src/operation.rs', 'crates/flashwright-engine/src/input.rs', 'crates/flashwright-engine/src/keyboard.rs', 'crates/flashwright-engine/src/locators.rs', 'crates/flashwright-engine/src/pointer.rs', 'crates/flashwright-engine/src/handle_allocation.rs', 'crates/flashwright-engine/src/element_actions.rs',
  'crates/flashwright-engine/src/file_inputs.rs',
  'crates/flashwright-engine/src/context_state.rs', 'crates/flashwright-engine/src/page_state.rs', 'crates/flashwright-engine/src/events.rs', 'crates/flashwright-engine/src/publication.rs', 'crates/flashwright-engine/src/lib.rs',
  'crates/flashwright-browser/src/connection.rs', 'crates/flashwright-protocol/src/messages.rs', 'crates/flashwright-driver/src/main.rs',
  'packages/flashwright-core/src/trace-filmstrip.ts', 'packages/flashwright-core/src/tracing.ts', 'packages/flashwright-core/src/trace-hooks.ts', 'packages/flashwright-core/src/trace-resources.ts', 'packages/flashwright-core/src/client.ts', 'packages/flashwright-core/src/engine-contract.ts',
]) implementation[path] = hash(await readFile(path));
const outputs = {
  'compatibility/upstream/filmstrip.source.txt': extract,
  'compatibility/upstream/filmstrip-provenance.json': JSON.stringify({
    referenceVersion: '1.60.0', distributionPath, distributionSha256: hash(distribution),
    sources: ['https://github.com/microsoft/playwright/blob/v1.60.0/packages/playwright-core/src/server/screencast.ts', 'https://github.com/microsoft/playwright/blob/v1.60.0/packages/playwright-core/src/server/trace/recorder/tracing.ts', 'https://github.com/microsoft/playwright/blob/v1.60.0/packages/playwright-core/src/server/chromium/crPage.ts'],
    retainedExtract: 'compatibility/upstream/filmstrip.source.txt', extractSha256: hash(extract), implementation,
    relationship: 'Independent native capture owners and bounded frame transfer implement the pinned screencast geometry, JPEG quality, activity and ACK behavior. The pinned browser backend and recorder do not execute Flashwright commands; its loader/viewer are conformance consumers.',
    scope: ['Manual screenshots:true only, independently composable with sources:true and existing action/console tracing.', 'Existing and newly published public pages, multiple pages, closed pages and independent chunks.', 'Quality90 JPEG, longest-side800/even requested dimensions, 200ms pending-ACK throttle and500ms before/input/after activity.'],
    ownership: ['Original context/generation provenance survives native delayed dispatch and cannot activate a newer chunk.', 'Frame tokens are opaque and single-consumption; metadata claims retain native queue bytes until an attachment slot is reserved.', 'Start/ACK/stop have one owner; uncertain stop retains a quarantined owner through a late reply or page closure.', 'Per-request expected image length is checked before host attachment allocation; transfer slots remain owned through resource ingestion.'],
    limits: ['4MiB per decoded JPEG;128 frames/16MiB encoded per native context;32MiB encoded across an engine;128 page capture owners.', 'At most min(2,negotiated) native binary transfers and two host transfer-through-ingest owners per engine, one host owner per context.', 'Existing trace/source resource, archive, deadline and atomic publication bounds apply; overload fails export while preserving ordinary browser outcomes.'],
    differences: ['Native monotonic arrival timestamps are mapped into the host action clock with a recorded per-chunk request/response interval and uncertainty; compositor wall time remains independent.', 'Images use content-SHA256 JPEG archive aliases instead of timestamp-based aliases.', 'CDP device dimensions and JPEG dimensions are retained separately, including full Chrome surface changes around page creation/closure. Exact frame counts or sampled transient sizes are not equated across independent runs.', 'Private screencast frames bypass unrelated broadcast subscribers, including storage interception.'],
    exclusions: ['DOM/network snapshots have separate provenance and acceptance; video and automatic runner tracing policies remain unsupported.', 'Manual trace and local development evidence do not establish full diagnostic parity, all-platform support or a performance claim.'],
    verification: ['tools/test-trace-filmstrip.mjs', 'tools/test-attachments.mjs', 'tools/test-native-filmstrip.mjs', 'compatibility/m1/test_filmstrip.py', 'tools/run-trace-filmstrip-tests.mjs', 'tools/test-trace-filmstrip-viewer.mjs', 'tools/test-packed-filmstrip.mjs', 'cargo test --workspace --locked'],
    license: 'Apache-2.0', licensePath: 'compatibility/upstream/LICENSE.playwright', noticePath: 'compatibility/upstream/NOTICE.playwright',
  }, null, 2) + '\n',
};
for (const [path, content] of Object.entries(outputs)) {
  if (process.argv.includes('--check')) assert.equal(await readFile(path, 'utf8'), content, `Filmstrip provenance differs: ${path}`);
  else await writeFile(path, content);
}
console.log('Verified pinned filmstrip provenance.');
