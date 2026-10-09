import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import ts from 'typescript';

const hash = value => createHash('sha256').update(value).digest('hex');
assert.equal(JSON.parse(await readFile('node_modules/playwright/package.json', 'utf8')).version, '1.60.0');
const distributions = {};
const snippets = new Map();
for (const path of ['node_modules/playwright/lib/index.js', 'node_modules/playwright/lib/worker/workerProcessEntry.js', 'node_modules/playwright-core/lib/coreBundle.js']) {
  const source = await readFile(path, 'utf8');
  distributions[path] = hash(source);
  const parsed = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  function visit(node) {
    const name = node.name?.getText(parsed);
    if (ts.isPropertyAssignment(node) && ['onApiCallBegin', 'onApiCallEnd'].includes(name) && path.endsWith('/index.js')) snippets.set(name, node.getText(parsed));
    if (ts.isFunctionDeclaration(node) && ['renderTitle', 'mergeActionsAndUpdateTimingSameTrace', 'monotonicTimeDeltaBetweenLibraryAndRunner', 'serializeAttachments', 'generatePreview'].includes(name)) snippets.set(name, node.getText(parsed));
    if (ts.isFunctionDeclaration(node) && name === 'filteredStackTrace' && path.endsWith('/workerProcessEntry.js')) snippets.set('filteredStackTrace', node.getText(parsed));
    if (ts.isMethodDeclaration(node)) {
      const text = node.getText(parsed);
      if (name === '_attach' && text.includes('this._callbacks.onAttach')) snippets.set('TestInfo._attach', text);
      if (name === '_runWithTimeout' && text.includes('this._timeoutManager.withRunnable')) snippets.set('TestInfo._runWithTimeout', text);
      if (name === 'setTimeout' && text.includes('this._running ? this._running.slot : this._defaultSlot')) snippets.set('TimeoutManager.setTimeout', text);
      if (name === '_addStep' && text.includes('appendBeforeActionForStep')) snippets.set('TestInfo._addStep', text);
      if (name === '_expect' && text.includes('serializeArgument(options2.expectedValue)')) snippets.set('Frame._expect', text);
      if (name === 'expect' && text.includes('fixupMetadataError')) snippets.set('Frame.expect', text);
      if (name === '_startTraceChunkOnContextCreation') snippets.set('ArtifactsRecorder.startContext', text);
      if (name === 'stopIfNeeded' && text.includes('this._contextCreatedEvent.testTimeout')) snippets.set('TestTracing.stopIfNeeded', text);
      if (['appendBeforeActionForStep', 'appendAfterActionForStep', 'appendStdioToTrace', '_formatError'].includes(name)) snippets.set(`TestTracing.${name}`, text);
    }
    ts.forEachChild(node, visit);
  }
  visit(parsed);
}
const names = ['TestInfo._attach', 'TestInfo._runWithTimeout', 'TimeoutManager.setTimeout', 'onApiCallBegin', 'onApiCallEnd', 'renderTitle', 'TestInfo._addStep', 'Frame._expect', 'Frame.expect', 'ArtifactsRecorder.startContext', 'mergeActionsAndUpdateTimingSameTrace', 'monotonicTimeDeltaBetweenLibraryAndRunner', 'TestTracing.stopIfNeeded', 'TestTracing.appendBeforeActionForStep', 'TestTracing.appendAfterActionForStep', 'TestTracing.appendStdioToTrace', 'TestTracing._formatError', 'serializeAttachments', 'generatePreview', 'filteredStackTrace'];
for (const name of names) assert(snippets.has(name), `Missing pinned trace boundary ${name}`);
const extract = names.map(name => `// ${name}\n${snippets.get(name)}`).join('\n\n') + '\n';
const implementation = {};
for (const path of ['tools/build-runner-runtime.mjs', 'packages/flashwright-runner/runner-hooks.cjs', 'packages/flashwright-runner/src/upstream-runtime.ts', 'tools/test-owned-runner-runtime.mjs', 'tools/run-runner-trace-start-tests.mjs', 'compatibility/m2/runner-trace-start/start.spec.cjs', 'compatibility/m2/runner-trace-start/playwright.config.cjs']) implementation[path] = hash(await readFile(path));
for (const path of ['packages/flashwright-core/src/trace-storage-budget.ts', 'tools/test-trace-storage-budget.mjs']) implementation[path] = hash(await readFile(path));
for (const path of ['packages/flashwright-runner/src/runner-trace-finalizer.ts', 'packages/flashwright-runner/src/artifact-errors.ts', 'tools/test-runner-trace-finalizer.mjs', 'tools/run-runner-trace-finalizer-tests.mjs', 'compatibility/m2/runner-trace-finalizer/finalizer.spec.cjs', 'compatibility/m2/runner-trace-finalizer/playwright.config.cjs']) implementation[path] = hash(await readFile(path));
for (const path of ['packages/flashwright-core/src/runner-trace-archives.ts', 'packages/flashwright-core/src/trace-archive-assembly.ts', 'packages/flashwright-core/src/trace-archive.ts', 'tools/test-trace-archive-assembly.mjs', 'tools/test-runner-trace-archives.mjs', 'tools/run-runner-trace-archive-tests.mjs']) implementation[path] = hash(await readFile(path));
for (const path of ['packages/flashwright-core/src/runner-trace-journal.ts', 'packages/flashwright-core/src/runner-trace-record.ts', 'packages/flashwright-core/src/trace-resources.ts', 'tools/test-runner-trace-journal.mjs', 'tools/run-runner-trace-journal-reference.mjs', 'compatibility/m2/runner-trace-journal/journal.spec.cjs', 'compatibility/m2/runner-trace-journal/playwright.config.cjs']) implementation[path] = hash(await readFile(path));
for (const path of ['packages/flashwright-runner/src/runner-trace-journal.ts', 'packages/flashwright-runner/src/runner-trace-off.ts', 'tools/test-runner-trace-adoption.mjs', 'tools/run-runner-trace-adoption-tests.mjs', 'compatibility/m2/runner-trace-adoption/adoption.spec.cjs', 'compatibility/m2/runner-trace-adoption/fixtures.cjs', 'compatibility/m2/runner-trace-adoption/early-failure.spec.cjs', 'compatibility/m2/runner-trace-adoption/playwright.config.cjs']) implementation[path] = hash(await readFile(path));
for (const path of ['packages/flashwright-core/src/runner-actions.ts', 'packages/flashwright-core/src/runner-lifecycle.ts', 'packages/flashwright-core/src/runner-integration.ts', 'packages/flashwright-core/src/tracing.ts', 'packages/flashwright-core/src/trace-hooks.ts', 'packages/flashwright-core/src/index.ts', 'packages/flashwright-core/src/locator.ts', 'packages/flashwright-core/src/frame.ts', 'packages/flashwright-runner/src/trace-steps.ts', 'tools/test-runner-artifact-lifecycle.mjs', 'tools/test-runner-trace-steps.mjs']) implementation[path] = hash(await readFile(path));
const outputs = {
  'compatibility/upstream/runner-trace-boundaries.source.txt': extract,
  'compatibility/upstream/runner-trace-boundaries-provenance.json': JSON.stringify({
    referenceVersion: '1.60.0', distributions, implementation,
    sources: [
      'https://github.com/microsoft/playwright/blob/v1.60.0/packages/playwright/src/index.ts',
      'https://github.com/microsoft/playwright/blob/v1.60.0/packages/playwright/src/worker/testInfo.ts',
      'https://github.com/microsoft/playwright/blob/v1.60.0/packages/playwright/src/worker/testTracing.ts',
      'https://github.com/microsoft/playwright/blob/v1.60.0/packages/playwright-core/src/client/frame.ts',
      'https://github.com/microsoft/playwright/blob/v1.60.0/packages/playwright-core/src/server/frames.ts',
      'https://github.com/microsoft/playwright/blob/v1.60.0/packages/isomorphic/trace/traceModel.ts',
    ],
    retainedExtract: 'compatibility/upstream/runner-trace-boundaries.source.txt', extractSha256: hash(extract),
    relationship: 'Independent asynchronous host-context enrollment preserves invocation scope, publication, closure and cleanup ownership. A private version-2 action hook associates admitted library trace calls with the pinned runner step IDs. The pinned title/selector/group helpers are reused; expect-zone association follows the pinned listener and keeps matcher completion outside the core. The small title composition follows the retained renderTitle contract.',
    scope: ['Controlled asynchronous enrollment and recursive lifecycle rejection; synchronous screenshots and the observer-free path remain available.', 'Version-3 exact-chunk handles transfer sealed archive custody after collector retirement. Stale handles cannot affect manual replacements; cancellation and unsettled cleanup retain late manifest disposal.', 'Step identity, original completion ownership, safe parameter previews, mapped locations, internal delegation suppression and user callback reentry.', 'Assertion records flatten safe predicate options and retain the pinned Expect failure when matches equals isNot, including standalone manual traces.', 'Controlled actual pinned trace-loader/model alignment verifies merged step parents and clocks.'],
    assembly: 'Version-4 bounded final archive assembly consumes immutable input readers, prefixes library streams by admission ordinal and applies the pinned latest source-alias precedence. Canonical bounded descriptors, total retained input counts/text/bytes and final ZIP limits precede custody transfer. Rejection preserves caller custody; disposal releases all readers before four concurrent cleanup workers settle every archive.',
    recordingControls: 'Version-7 private startup returns the original recording identity. Exact-recording handles open another chunk or retire only that same idle recording; active manual chunks and replacement recordings reject before native commands. Exact-chunk discard reads no final sources. Private discard and retirement wait for original cleanup beyond the public foreground grace. Shared finalization preserves an earlier capture failure when native retirement also fails, including private handoff and manual export. Closure before host publication cannot revive a recording or chunk. These controls do not enable automatic policies or establish aggregate capture admission.',
    unclaimedCreation: 'Version-9 artifact lifecycle distinguishes creation begun without an observer. Publication preserves its original outcome and sends a synchronous availability notification, never a retroactive attempt claim. Disposal suppresses new unclaimed admission; callback errors and invalid promises retain bookkeeping custody without rejecting creation. Normal claimed generation, enrollment and retirement rules remain unchanged. Screenshot observation now awaits readiness and disposal through this contract.',
    creationOwnership: 'Version-8 owned lifecycle claims the original attempt synchronously before validation, storage preparation or native creation. Enrollment uses that claim after a delayed reply even if the worker advances. Completion follows publication or failed-context cleanup exactly once. Observer retirement waits for native creation claims and callbacks before admitting a replacement. Completion bookkeeping errors surface at disposal without changing creation outcomes; original enrollment failures retain precedence. Existing contexts claim at registration; earlier observer contracts and the claim-free off path remain unchanged.',
    journal: 'Version-5 normalized-record journal snapshots admitted body attachments, streams bounded records, and resolves file attachments, UTF-8 sources and final timeout at finalization. Original clocks and records match a same-attempt pinned runner observer corpus, with original buffers mutated after attachment. Caller metadata and binary stdio cannot invoke accessors, proxy traps or custom serialization methods. Queue and file custody survives cancellation, reader transfer and cleanup failure.',
    adoption: 'Version-6 synchronous journal admission starts before asynchronous filesystem initialization. The private earliest-instance adapter replaces all five allocation-producing pinned append callers and validates the small framework prefix; only a skipped test may first adopt the afterAll cleanup prefix. Ordinary parameter previews and bounded error formatting preserve the pinned contract, while unsafe/oversized previews use explicit markers. Actual pinned-runner comparisons exercise all eight policy spellings, retry and failed-worker cleanup, early worker failure, skipped final-hook ownership and successor isolation through the private production journal finalizer.',
    ownedStartup: 'The owned pinned worker adds a synchronous original-attempt disposition after capture-policy normalization and before live allocation. Private early journal admission validates the sole original context record, covers callback modifiers and skipped no-fixture final stops, and rejects live before SerializedFS dispatch. Object option truthiness follows the pinned spread defaults, including explicit undefined. Disabled attempts discard their allocation-producing callers at this same boundary. Owned runtime provenance records complete source hashes, preserved relative resolution and the exact worker adaptation.',
    finalization: 'The original instance final-stop owner preserves the default test timeout while disabling only its separate pinned export slot. One30-second preparation deadline and monotonic precommit check precede atomic rename; dispatched rename retains definitive completion ownership. Two-second foreground cleanup grace retains late journal/archive custody. Bounded complete diagnostics publish once after foreground cleanup, because pinned onAttach serializes immediately. Artifact failures preserve original test outcomes. Actual runner and packed consumers cover capture failure, cleanup failure, original expected failure, healthy successors and final preparation beyond the project export slot.',
    exclusions: ['Automatic runner trace policies remain rejected. The private finalizer currently owns only the runner journal. Library/standalone API enrollment, final retained-manifest integration and aggregate native/test capture budgets remain unfinished. The earlier same-attempt reference observer proves record/resource fidelity while retaining original arrays/conversions; the separate earliest-adapter corpus replaces them and compares non-clock fields plus original clock-domain/order invariants.', 'Private callbacks cannot create/close contexts or dispose their own observer recursively. The fixture/creator owns those lifecycle controls.', 'No performance or native Linux result.'],
    license: 'Apache-2.0', licensePath: 'compatibility/upstream/LICENSE.playwright', noticePath: 'compatibility/upstream/NOTICE.playwright',
  }, null, 2) + '\n',
};
for (const [path, contents] of Object.entries(outputs)) {
  if (process.argv.includes('--check')) assert.equal(await readFile(path, 'utf8'), contents, `Trace boundary provenance differs: ${path}`);
  else await writeFile(path, contents);
}
console.log('Verified pinned runner trace boundary provenance.');
