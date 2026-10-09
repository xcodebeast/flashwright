import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import typescript from 'typescript';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
assert.equal(JSON.parse(await readFile('node_modules/playwright/package.json', 'utf8')).version, '1.60.0');
const wrappers = ['toHaveClass', 'toContainClass', 'toHaveCSS', 'toHaveId', 'toHaveValues', 'toHaveRole', 'toHaveAccessibleName', 'toHaveAccessibleDescription', 'toHaveAccessibleErrorMessage'];
const sources = [
  { path: 'node_modules/playwright/lib/matchers/expect.js', sha256: '10b9442388bd9cfaae64e3f76c74081548687ab89e7d1f1ea20c93de6bd02358', names: wrappers, kind: 'function' },
  { path: 'packages/resident-runtime/playwright-injected.js', sha256: '7000b1119dc91aabdb4a19b0ebf9d3e1f02cdb59153cff8c3cdc690e503e944a', names: ['_expectCore', 'expectSingleElement', 'expectArray', 'matchesClassList'], kind: 'method' },
];
const snippets = {};
for (const source of sources) {
  const text = await readFile(source.path, 'utf8');
  assert.equal(hash(text), source.sha256, `Pinned source changed: ${source.path}`);
  const syntax = typescript.createSourceFile(source.path, text, typescript.ScriptTarget.Latest, true, typescript.ScriptKind.JS);
  assert.deepEqual(syntax.parseDiagnostics, []);
  function visit(node) {
    const accepted = source.kind === 'function' ? typescript.isFunctionDeclaration(node) : typescript.isMethodDeclaration(node);
    const name = accepted ? node.name?.getText(syntax) : undefined;
    if (source.names.includes(name)) {
      assert(!Object.hasOwn(snippets, name), `Duplicate source contract: ${name}`);
      const retained = node.getText(syntax);
      snippets[name] = { path: source.path, firstLine: syntax.getLineAndCharacterOfPosition(node.getStart()).line + 1, lastLine: syntax.getLineAndCharacterOfPosition(node.getEnd()).line + 1, sha256: hash(retained), text: retained };
    }
    typescript.forEachChild(node, visit);
  }
  visit(syntax);
  for (const name of source.names) assert(Object.hasOwn(snippets, name), `Missing source contract: ${name}`);
}
const extract = Object.entries(snippets).map(([name, snippet]) => `// ${name}: ${snippet.path}:${snippet.firstLine}-${snippet.lastLine}\n${snippet.text}`).join('\n\n') + '\n';
const implementationPaths = ['packages/flashwright-runner/src/matchers.ts', 'packages/flashwright-runner/src/index.ts', 'packages/flashwright-core/src/assertions.ts', 'crates/flashwright-engine/src/assertions.rs', 'packages/resident-runtime/locator-runtime.js', 'packages/resident-runtime/condition-registry.js', 'tools/test-common-matchers.mjs', 'tools/run-common-matcher-tests.mjs', 'tools/test-packed-common-matchers.mjs', 'compatibility/m2/common-matchers-fixture.mjs', 'compatibility/m2/common-matchers-types.ts'];
const implementation = Object.fromEntries(await Promise.all(implementationPaths.map(async path => [path, hash(await readFile(path))])));
const licensePath = 'compatibility/upstream/LICENSE.playwright';
const noticePath = 'compatibility/upstream/NOTICE.playwright';
const provenance = {
  referenceVersion: '1.60.0', sources: sources.map(({ path, sha256 }) => ({ path, sha256 })),
  upstream: ['https://github.com/microsoft/playwright/blob/v1.60.0/packages/playwright/src/matchers/matchers.ts', 'https://github.com/microsoft/playwright/blob/v1.60.0/packages/injected/src/injectedScript.ts'],
  retainedExtract: 'compatibility/upstream/common-matchers.source.txt', extractSha256: hash(extract),
  snippets: Object.fromEntries(Object.entries(snippets).map(([name, { text: _text, ...metadata }]) => [name, metadata])), implementation,
  relationship: 'Flashwright adapts the pinned host matcher request shapes and executes the already retained injected DOM predicates through its independent native assertion lifecycle. The broader retained predicate methods contain branches that are not admitted by this slice.',
  contracts: [
    'Class arrays have exact element cardinality and ordered matching; scalar exact class matching preserves the attribute string. Partial classes require string tokens and reject regular expressions.',
    'Computed CSS accepts before/after pseudo-elements; selected values retarget labels and require a multiple select, preserving DOM option order.',
    'Accessibility name/description/error text uses pinned whitespace normalization and explicit ignoreCase precedence. Role matching requires a literal string and does not infer role hierarchy.',
    'Existing assertion transport, full predicates, retry/negation/missing-target handling and bounded diagnostics remain shared with established matchers.',
    'Shared-selector cache eligibility is unchanged. New predicates retain complete ordinary resident checks and frame/timer fallback for CSSOM, selected-property and related accessible-node changes.',
    'JSProperty remains unsupported: the pinned implementation selects main world, requiring a separate ownership and value-serialization design.',
    'This source record is not a verification result. Host tests compare exact pinned wrapper dispatch; browser and native evidence must independently establish behavior.',
  ],
  license: 'Apache-2.0', licensePath, noticePath,
  licenseSha256: hash(await readFile(licensePath)), noticeSha256: hash(await readFile(noticePath)),
};
const files = { 'common-matchers.source.txt': extract, 'common-matchers-provenance.json': JSON.stringify(provenance, null, 2) + '\n' };
if (!process.argv.includes('--check')) await mkdir('compatibility/upstream', { recursive: true });
for (const [name, contents] of Object.entries(files)) {
  const path = `compatibility/upstream/${name}`;
  if (process.argv.includes('--check')) assert.equal(await readFile(path, 'utf8'), contents, `Common matcher provenance differs: ${path}`);
  else await writeFile(path, contents);
}
console.log(`Verified common matcher provenance: ${Object.keys(snippets).length} contracts, ${implementationPaths.length} implementation files.`);
