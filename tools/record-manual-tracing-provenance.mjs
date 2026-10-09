import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import ts from 'typescript';

const distributionPath = 'node_modules/playwright-core/lib/coreBundle.js';
const distribution = await readFile(distributionPath, 'utf8');
const sourceMappingDistribution = 'node_modules/playwright-core/lib/utilsBundle.js';
assert.equal(JSON.parse(await readFile('node_modules/playwright-core/package.json', 'utf8')).version, '1.60.0');
const parsed = ts.createSourceFile(distributionPath, distribution, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const selected = new Map([
  ['Tracing', ['constructor', 'start', 'startChunk', 'stopChunk', '_onConsoleMessage', '_onPageError', 'onBeforeCall', 'onAfterCall']],
  ['Tracing2', ['start', 'startChunk', 'stopChunk', 'stop', '_doStopChunk']],
  ['TraceLoader', ['load']],
]);
const snippets = new Map();
const functions = ['parseSerializedValue', 'innerParseSerializedValue', 'createBeforeActionTraceEvent', 'createAfterActionTraceEvent', 'zip'];
function visit(node) {
  if (ts.isBinaryExpression(node) && ts.isIdentifier(node.left) && ts.isClassExpression(node.right)) {
    const className = node.left.text;
    const methods = selected.get(className);
    if (methods) {
      for (const member of node.right.members) {
        const name = ts.isConstructorDeclaration(member) ? 'constructor' : member.name?.getText(parsed);
        if (methods.includes(name)) snippets.set(`${className}.${name}`, member.getText(parsed));
      }
    }
  }
  if (ts.isFunctionDeclaration(node) && functions.includes(node.name?.text)) snippets.set(node.name.text, node.getText(parsed));
  ts.forEachChild(node, visit);
}
visit(parsed);
const names = [...selected].flatMap(([className, methods]) => methods.map(method => `${className}.${method}`));
names.push(...functions);
for (const name of names) assert.ok(snippets.has(name), `Missing pinned tracing contract ${name}`);
const extract = names.map(name => `// ${name}\n${snippets.get(name)}`).join('\n\n') + '\n';
const hash = value => createHash('sha256').update(value).digest('hex');
const implementation = {};
for (const path of [
  'crates/flashwright-engine/src/trace_diagnostics.rs', 'crates/flashwright-engine/src/context_state.rs',
  'crates/flashwright-engine/src/console.rs', 'crates/flashwright-engine/src/events.rs',
  'crates/flashwright-engine/src/publication.rs', 'crates/flashwright-engine/src/lib.rs',
  'packages/flashwright-core/src/tracing.ts', 'packages/flashwright-core/src/trace-preview.ts',
  'packages/flashwright-core/src/trace-resources.ts', 'packages/flashwright-core/src/trace-writer.ts', 'packages/flashwright-core/src/trace-diagnostics.ts',
  'packages/flashwright-core/src/trace-hooks.ts', 'packages/flashwright-core/src/index.ts',
  'packages/flashwright-core/src/call-sites.ts', 'packages/flashwright-core/src/client.ts',
  'packages/flashwright-core/src/frame.ts', 'packages/flashwright-core/src/locator.ts',
  'packages/flashwright-core/src/keyboard.ts', 'packages/flashwright-core/src/handles.ts',
  'packages/flashwright-core/src/network.ts', 'packages/flashwright-core/src/console.ts',
  'packages/flashwright-core/src/subscribed-events.ts', 'packages/flashwright-core/src/file-chooser.ts',
  'packages/flashwright-core/src/init-scripts.ts', 'packages/flashwright-core/src/waits.ts',
  'packages/flashwright-core/src/navigation-waiter.ts', 'packages/flashwright-core/src/engine-contract.ts',
  'packages/flashwright-core/src/runner-integration.ts', 'packages/flashwright-runner/src/screenshot-recorder.ts', 'packages/flashwright-runner/src/index.ts',
]) implementation[path] = hash(await readFile(path));
const outputs = {
  'compatibility/upstream/manual-tracing.source.txt': extract,
  'compatibility/upstream/manual-tracing-provenance.json': JSON.stringify({
    referenceVersion: '1.60.0', distributionPath, distributionSha256: hash(distribution),
    sources: [
      'https://github.com/microsoft/playwright/blob/v1.60.0/packages/playwright-core/src/client/tracing.ts',
      'https://github.com/microsoft/playwright/blob/v1.60.0/packages/playwright-core/src/server/localUtils.ts',
      'https://github.com/microsoft/playwright/blob/v1.60.0/packages/playwright-core/src/server/trace/recorder/tracing.ts',
      'https://github.com/microsoft/playwright/blob/v1.60.0/packages/playwright-core/src/protocol/serializers.ts',
      'https://github.com/microsoft/playwright/blob/v1.60.0/packages/isomorphic/trace/traceLoader.ts',
    ],
    retainedExtract: 'compatibility/upstream/manual-tracing.source.txt', extractSha256: hash(extract), implementation,
    relationship: 'Independent native diagnostic ownership, public API instrumentation and streaming ZIP writer implement the pinned manual trace lifecycle and version-8 action/event schema. No upstream browser backend, tracing recorder, snapshotter or HAR tracer executes browser commands. The pinned loader and actual viewer are conformance consumers only.',
    sourceMapping: { distributionPath: sourceMappingDistribution, sha256: hash(await readFile(sourceMappingDistribution)), relationship: 'The runner installs the source-map-support mapSourcePosition function from its existing pinned dependency through a private versioned boundary. Core command and trace diagnostics use structured node:util.getCallSites metadata and apply runner transforms once, without modifying or invoking global Error.prepareStackTrace.' },
    defaults: { screenshots: false, snapshots: false, sources: false },
    scope: ['Manual context.tracing.start/startChunk/stopChunk/stop.', 'Public API actions with caller locations, bounded parameter/result previews, original error details, concurrent and unfinished calls.', 'Console diagnostics, page errors and public page lifecycle independent of user console subscriptions and argument handles.', 'Version-8 ZIP with inline caller stacks and serialized evaluation argument/result envelopes.', 'Manual sources:true embeds referenced mapped caller files read at export; path-SHA1 archive aliases refer to immutable content-SHA256 recording resources.'],
    limits: ['100000 events, 64 MiB encoded content, 4 MiB queued writes and 256 KiB per event per chunk.', '1024 unfinished calls per context; native diagnostics allow 1024 events, 4 MiB or half the negotiated control frame, and 64 KiB raw content per event.', '4096 source paths and 1 MiB path metadata per chunk; source files at most 8 MiB, generic resources at most 16 MiB; two concurrent 64 KiB streamed ingests. Recording storage is bounded at 8192 blobs and 256 MiB including in-flight reservations; archives permit 8192 aliases, 512 MiB encoded bytes and 4 MiB central-directory data.', '30-second preparation deadline, with definitive ownership of an already dispatched atomic rename; two-second foreground cleanup grace followed by retained ownership and recording quarantine.'],
    differences: ['Trace previews are bounded summaries, with explicit truncation markers and no application accessors, proxy traps or custom serialization.', 'Capture failure preserves the original browser operation result and fails export explicitly.', 'BigInt console values preserve the documented S4.l behavior.', 'Concurrent tracing controls reject; normal owner closure discards an unfinished recording.', 'Missing or non-file source paths omit content; source read errors, detected mutation and resource limits fail export rather than silently truncating sources. Nonblocking source opens preserve symlink-to-regular-file behavior without blocking on FIFO replacement.'],
    exclusions: ['Manual snapshots:true and screenshots:true follow their separate snapshot/network and filmstrip provenance and fidelity gates.', 'Automatic runner tracing policies and tracing groups remain unsupported; DOM/network recording has separate provenance and acceptance.', 'Manual trace support alone does not establish original-config public-corpus completion or full diagnostic parity.'],
    verification: ['tools/test-manual-tracing.mjs', 'tools/test-caller-locations.mjs', 'tools/run-manual-trace-tests.mjs', 'tools/test-manual-trace-viewer.mjs', 'tools/run-manual-trace-runner-tests.mjs', 'tools/test-trace-resources.mjs', 'tools/run-trace-source-tests.mjs', 'tools/test-trace-source-viewer.mjs'],
    license: 'Apache-2.0', licensePath: 'compatibility/upstream/LICENSE.playwright', noticePath: 'compatibility/upstream/NOTICE.playwright',
  }, null, 2) + '\n',
};
for (const [path, contents] of Object.entries(outputs)) {
  if (process.argv.includes('--check')) assert.equal(await readFile(path, 'utf8'), contents, `Manual tracing provenance differs: ${path}`);
  else await writeFile(path, contents);
}
console.log('Verified pinned manual tracing provenance.');
