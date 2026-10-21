import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import typescript from 'typescript';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
assert.equal(JSON.parse(await readFile('node_modules/playwright/package.json', 'utf8')).version, '1.60.0');
const distributions = {}, snippets = {};
const selected = [
  ['node_modules/playwright/lib/errorContext.js', ['buildErrorContext', 'buildCodeFrame', 'fixTestInstructions']],
  ['node_modules/playwright/lib/index.js', ['ArtifactsRecorder._takePageSnapshot', 'ArtifactsRecorder.willCloseBrowserContext', 'ArtifactsRecorder.didFinishTest']],
  ['node_modules/playwright/lib/worker/workerProcessEntry.js', ['WorkerMain._runTest']],
  ['node_modules/playwright-core/lib/coreBundle.js', ['parseStackFrame', 'parseErrorStack', 'belongsToNodeModules', 'fileURLToPath', 'stripAnsiEscapes', 'init_stringUtils', 'init_stackTrace']],
  ['packages/resident-runtime/playwright-injected.js', ['InjectedScript.incrementalAriaSnapshot']],
];
for (const [path, names] of selected) {
  const source = await readFile(path, 'utf8'); distributions[path] = hash(source);
  const syntax = typescript.createSourceFile(path, source, typescript.ScriptTarget.Latest, true, typescript.ScriptKind.JS);
  assert.deepEqual(syntax.parseDiagnostics, []);
  function visit(node) {
    let name;
    if (typescript.isFunctionDeclaration(node) || typescript.isVariableDeclaration(node)) name = node.name?.getText(syntax);
    if (typescript.isMethodDeclaration(node)) {
      const owner = node.parent;
      name = `${(owner.name ?? owner.parent.name)?.getText(syntax)}.${node.name.getText(syntax)}`;
    }
    if (names.includes(name)) {
      assert(!snippets[name], `Duplicate pinned contract ${name}`);
      snippets[name] = { path, firstLine: syntax.getLineAndCharacterOfPosition(node.getStart()).line + 1, text: node.getText(syntax) };
    }
    typescript.forEachChild(node, visit);
  }
  visit(syntax);
  for (const name of names) assert(snippets[name], `Missing pinned contract ${name}`);
}
const extract = Object.entries(snippets).map(([name, item]) => `// ${name}: ${item.path}:${item.firstLine}\n${item.text}`).join('\n\n') + '\n';
const implementationPaths = [
  'crates/flashwright-engine/src/failure_context.rs', 'crates/flashwright-engine/src/operation.rs',
  'crates/flashwright-engine/src/locators.rs', 'crates/flashwright-engine/src/lib.rs',
  'packages/resident-runtime/failure-context-snapshot.js', 'packages/resident-runtime/locator-runtime.js',
  'packages/resident-runtime/sources.txt', 'packages/flashwright-core/src/failure-context-snapshot.ts',
  'packages/flashwright-core/src/index.ts', 'packages/flashwright-core/src/runner-integration.ts',
  'packages/flashwright-runner/src/failure-context-format.ts', 'packages/flashwright-runner/src/failure-context-recorder.ts',
  'packages/flashwright-runner/src/independent/output.ts', 'packages/flashwright-runner/src/independent/suite-collector.ts',
  'packages/flashwright-runner/src/runner-artifact-coordinator.ts', 'packages/flashwright-runner/src/runner-trace-finalizer.ts',
  'packages/flashwright-runner/src/screenshot-recorder.ts', 'packages/flashwright-runner/src/artifact-errors.ts',
  'tools/test-failure-context-format.mjs', 'tools/test-failure-context-recorder.mjs',
  'tools/test-independent-output.mjs', 'tools/test-independent-failure-context.mjs',
  'tools/test-failure-context-snapshot.mjs', 'tools/test-failure-context-operation.mjs',
  'tools/test-screenshot-ownership.mjs', 'tools/test-runner-artifact-coordinator.mjs',
  'tools/test-runner-trace-finalizer.mjs', 'tools/run-failure-context-tests.mjs',
  'compatibility/m2/failure-context/playwright.config.cjs', 'compatibility/m2/failure-context/artifacts.spec.cjs',
];
const implementation = Object.fromEntries(await Promise.all(implementationPaths.map(async path => [path, hash(await readFile(path))])));
const licensePath = 'compatibility/upstream/LICENSE.playwright', noticePath = 'compatibility/upstream/NOTICE.playwright';
const provenance = {
  referenceVersion: '1.60.0', distributions,
  upstream: [
    'https://github.com/microsoft/playwright/blob/v1.60.0/packages/playwright/src/errorContext.ts',
    'https://github.com/microsoft/playwright/blob/v1.60.0/packages/playwright/src/index.ts',
    'https://github.com/microsoft/playwright/blob/v1.60.0/packages/playwright/src/worker/workerMain.ts',
    'https://github.com/microsoft/playwright/blob/v1.60.0/packages/isomorphic/stackTrace.ts',
    'https://github.com/microsoft/playwright/blob/v1.60.0/packages/isomorphic/stringUtils.ts',
    'https://github.com/microsoft/playwright/blob/v1.60.0/packages/injected/src/injectedScript.ts',
  ],
  retainedExtract: 'compatibility/upstream/failure-context.source.txt', extractSha256: hash(extract), implementation,
  relationship: 'The formatter adapts the pinned Markdown instructions, sections, source-frame layout, stack-location parsing and ANSI stripping with independently bounded streaming source reads, without importing the upstream runtime. Default and independent original-attempt recorders own their publication and lifecycle. Independent collection captures mapped declaration locations through structured runtime call sites, and independent output retains bounded original error data and matcher YAML before atomic failure-document publication. Private native fallback invokes the already attributed pinned injected AI renderer in the existing isolated locator realm; it is not a public AI snapshot implementation.',
  contracts: [
    'Default documents are independent of trace and screenshot policies. Matcher observation diagnostics take precedence over fallback. PLAYWRIGHT_NO_COPY_PROMPT suppresses fallback only.',
    'Creation claims and late cleanup retain their original TestInfo; explicit successor adoption takes precedence. Once-only worker final stop follows all hooks, seals original action/creation admission, and releases failure ownership even when optional preflight diagnostics fail.',
    'Pre-context-close work seals traces, captures requested screenshots, then captures fallback. Ordinary page closure and direct browser closure do not add fallback. Only the first owned leftover context is considered at final stop.',
    'Native fallback validates the original main frame, shares one caller deadline with its five-second ceiling, retries body/document transitions, and settles on cancellation or owner closure. An attempt shares a five-second fallback window and128 pending close slots.',
    'Pre-fallback trace sealing and final trace export share the same original30-second monotonic preparation deadline. Late admitted work retains original cleanup custody and cannot publish on a successor.',
    'Atomic publication preserves original test status/errors and records optional failures in a bounded error-context-error attachment. Final reporter bytes and trace resources contain the same completed document.',
  ],
  differences: [
    'Failure documents are at most256KiB; fields/stacks32768 UTF-16 units,16 errors,1024 stack lines. Source input is at most8MiB with a64KiB retained window. Omissions are explicit.',
    'Fallback retains at most16384 UTF-16 units including a truncation marker. This is an output limit, not a DOM traversal or browser CPU bound.',
    'Rendered child-frame composition is unsupported for this private fallback; omission is diagnostic and does not replace the test failure. Public ARIA modes remain independently gated.',
    'Pinned hook teardown can attach the same document path twice; Flashwright publishes once after all hooks.',
    'This provenance record establishes source relationships, not functional or performance admission.',
  ],
  license: 'Apache-2.0', licensePath, noticePath,
  licenseSha256: hash(await readFile(licensePath)), noticeSha256: hash(await readFile(noticePath)),
};
for (const [path, contents] of Object.entries({
  'compatibility/upstream/failure-context.source.txt': extract,
  'compatibility/upstream/failure-context-provenance.json': JSON.stringify(provenance, null, 2) + '\n',
})) {
  if (process.argv.includes('--check')) assert.equal(await readFile(path, 'utf8'), contents, `Failure-context provenance differs: ${path}`);
  else await writeFile(path, contents);
}
console.log(`Verified failure-context provenance: ${Object.keys(snippets).length} pinned contracts.`);
