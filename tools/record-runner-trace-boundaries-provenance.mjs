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
    if (ts.isFunctionDeclaration(node) && ['renderTitle', 'mergeActionsAndUpdateTimingSameTrace', 'monotonicTimeDeltaBetweenLibraryAndRunner'].includes(name)) snippets.set(name, node.getText(parsed));
    if (ts.isMethodDeclaration(node)) {
      const text = node.getText(parsed);
      if (name === '_addStep' && text.includes('appendBeforeActionForStep')) snippets.set('TestInfo._addStep', text);
      if (name === '_expect' && text.includes('serializeArgument(options2.expectedValue)')) snippets.set('Frame._expect', text);
      if (name === 'expect' && text.includes('fixupMetadataError')) snippets.set('Frame.expect', text);
      if (name === '_startTraceChunkOnContextCreation') snippets.set('ArtifactsRecorder.startContext', text);
    }
    ts.forEachChild(node, visit);
  }
  visit(parsed);
}
const names = ['onApiCallBegin', 'onApiCallEnd', 'renderTitle', 'TestInfo._addStep', 'Frame._expect', 'Frame.expect', 'ArtifactsRecorder.startContext', 'mergeActionsAndUpdateTimingSameTrace', 'monotonicTimeDeltaBetweenLibraryAndRunner'];
for (const name of names) assert(snippets.has(name), `Missing pinned trace boundary ${name}`);
const extract = names.map(name => `// ${name}\n${snippets.get(name)}`).join('\n\n') + '\n';
const implementation = {};
for (const path of ['packages/flashwright-core/src/runner-trace-archives.ts', 'packages/flashwright-core/src/trace-archive-assembly.ts', 'packages/flashwright-core/src/trace-archive.ts', 'tools/test-trace-archive-assembly.mjs', 'tools/test-runner-trace-archives.mjs', 'tools/run-runner-trace-archive-tests.mjs']) implementation[path] = hash(await readFile(path));
for (const path of ['packages/flashwright-core/src/runner-actions.ts', 'packages/flashwright-core/src/runner-lifecycle.ts', 'packages/flashwright-core/src/runner-integration.ts', 'packages/flashwright-core/src/tracing.ts', 'packages/flashwright-core/src/trace-hooks.ts', 'packages/flashwright-core/src/index.ts', 'packages/flashwright-core/src/locator.ts', 'packages/flashwright-core/src/frame.ts', 'packages/flashwright-runner/src/trace-steps.ts', 'tools/test-runner-artifact-lifecycle.mjs', 'tools/test-runner-trace-steps.mjs']) implementation[path] = hash(await readFile(path));
const outputs = {
  'compatibility/upstream/runner-trace-boundaries.source.txt': extract,
  'compatibility/upstream/runner-trace-boundaries-provenance.json': JSON.stringify({
    referenceVersion: '1.60.0', distributions, implementation,
    sources: [
      'https://github.com/microsoft/playwright/blob/v1.60.0/packages/playwright/src/index.ts',
      'https://github.com/microsoft/playwright/blob/v1.60.0/packages/playwright/src/worker/testInfo.ts',
      'https://github.com/microsoft/playwright/blob/v1.60.0/packages/playwright-core/src/client/frame.ts',
      'https://github.com/microsoft/playwright/blob/v1.60.0/packages/playwright-core/src/server/frames.ts',
      'https://github.com/microsoft/playwright/blob/v1.60.0/packages/isomorphic/trace/traceModel.ts',
    ],
    retainedExtract: 'compatibility/upstream/runner-trace-boundaries.source.txt', extractSha256: hash(extract),
    relationship: 'Independent asynchronous host-context enrollment preserves invocation scope, publication, closure and cleanup ownership. A private version-2 action hook associates admitted library trace calls with the pinned runner step IDs. The pinned title/selector/group helpers are reused; expect-zone association follows the pinned listener and keeps matcher completion outside the core. The small title composition follows the retained renderTitle contract.',
    scope: ['Controlled asynchronous enrollment and recursive lifecycle rejection; synchronous screenshots and the observer-free path remain available.', 'Version-3 exact-chunk handles transfer sealed archive custody after collector retirement. Stale handles cannot affect manual replacements; cancellation and unsettled cleanup retain late manifest disposal.', 'Step identity, original completion ownership, safe parameter previews, mapped locations, internal delegation suppression and user callback reentry.', 'Assertion records flatten safe predicate options and retain the pinned Expect failure when matches equals isNot, including standalone manual traces.', 'Controlled actual pinned trace-loader/model alignment verifies merged step parents and clocks.'],
    assembly: 'Version-4 bounded final archive assembly consumes immutable input readers, prefixes library streams by admission ordinal and applies the pinned latest source-alias precedence. Canonical bounded descriptors, total retained input counts/text/bytes and final ZIP limits precede custody transfer. Rejection preserves caller custody; disposal releases all readers before four concurrent cleanup workers settle every archive.',
    exclusions: ['Automatic runner trace policies remain rejected. Sealed archive composition does not implement the runner journal, retention policies, aggregate capture budgets or new live-viewer behavior.', 'Private callbacks cannot create/close contexts or dispose their own observer recursively. The fixture/creator owns those lifecycle controls.', 'No performance or native Linux result.'],
    license: 'Apache-2.0', licensePath: 'compatibility/upstream/LICENSE.playwright', noticePath: 'compatibility/upstream/NOTICE.playwright',
  }, null, 2) + '\n',
};
for (const [path, contents] of Object.entries(outputs)) {
  if (process.argv.includes('--check')) assert.equal(await readFile(path, 'utf8'), contents, `Trace boundary provenance differs: ${path}`);
  else await writeFile(path, contents);
}
console.log('Verified pinned runner trace boundary provenance.');
