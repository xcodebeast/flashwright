import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import typescript from 'typescript';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
assert.equal(JSON.parse(await readFile('node_modules/playwright/package.json', 'utf8')).version, '1.60.0');
const sources = [
  { path: 'node_modules/playwright/lib/matchers/expect.js', sha256: '10b9442388bd9cfaae64e3f76c74081548687ab89e7d1f1ea20c93de6bd02358', names: ['toMatchAriaSnapshot', 'unshift', 'indent2'] },
  { path: 'node_modules/playwright-core/lib/coreBundle.js', sha256: 'f74353fcb8e406756a70a6af0dfc4a5069acd577e35ec9d923ccf36ac009c2f5', names: ['parseAriaSnapshotUnsafe', 'parseAriaSnapshot'] },
  { path: 'packages/resident-runtime/playwright-injected.js', sha256: '7000b1119dc91aabdb4a19b0ebf9d3e1f02cdb59153cff8c3cdc690e503e944a', names: ['matchesExpectAriaTemplate', 'generateAriaTree', 'renderAriaTree'] },
];
const snippets = {};
for (const source of sources) {
  const text = await readFile(source.path, 'utf8');
  assert.equal(hash(text), source.sha256, `Pinned source changed: ${source.path}`);
  const syntax = typescript.createSourceFile(source.path, text, typescript.ScriptTarget.Latest, true, typescript.ScriptKind.JS);
  assert.deepEqual(syntax.parseDiagnostics, []);
  function visit(node) {
    const name = typescript.isFunctionDeclaration(node) ? node.name?.getText(syntax) : undefined;
    if (source.names.includes(name)) {
      assert.ok(!Object.hasOwn(snippets, name), `Duplicate pinned contract: ${name}`);
      const contents = node.getText(syntax);
      snippets[name] = { path: source.path, firstLine: syntax.getLineAndCharacterOfPosition(node.getStart()).line + 1,
        lastLine: syntax.getLineAndCharacterOfPosition(node.getEnd()).line + 1, sha256: hash(contents), contents };
    }
    typescript.forEachChild(node, visit);
  }
  visit(syntax);
  for (const name of source.names) assert.ok(Object.hasOwn(snippets, name), `Missing pinned contract: ${name}`);
}
const extract = Object.entries(snippets).map(([name, snippet]) => `// ${name}: ${snippet.path}:${snippet.firstLine}-${snippet.lastLine}\n${snippet.contents}`).join('\n\n') + '\n';
const implementationPaths = [
  'packages/flashwright-runner/src/aria-matcher.ts', 'packages/flashwright-runner/src/index.ts',
  'packages/flashwright-core/src/assertions.ts', 'packages/flashwright-core/src/index.ts',
  'packages/resident-runtime/locator-runtime.js', 'packages/resident-runtime/condition-registry.js',
  'crates/flashwright-engine/src/assertions.rs', 'tools/test-aria-template-limits.mjs', 'tools/run-aria-assertion-tests.mjs',
  'compatibility/m2/aria-assertions/assertions.spec.cjs', 'compatibility/m2/aria-assertions/baseline.spec.cjs',
  'compatibility/m2/aria-assertions/playwright.config.cjs', 'compatibility/m2/aria-assertions/children.spec.cjs',
];
const implementation = Object.fromEntries(await Promise.all(implementationPaths.map(async path => [path, hash(await readFile(path))])));
const licensePath = 'compatibility/upstream/LICENSE.playwright';
const noticePath = 'compatibility/upstream/NOTICE.playwright';
const provenance = {
  referenceVersion: '1.60.0', sources: sources.map(({ path, sha256 }) => ({ path, sha256 })),
  upstream: ['packages/playwright/src/matchers/toMatchAriaSnapshot.ts', 'packages/isomorphic/ariaSnapshot.ts', 'packages/injected/src/ariaSnapshot.ts'].map(path => `https://github.com/microsoft/playwright/blob/v1.60.0/${path}`),
  retainedExtract: 'compatibility/upstream/aria-matcher.source.txt', extractSha256: hash(extract),
  snippets: Object.fromEntries(Object.entries(snippets).map(([name, { contents, ...metadata }]) => [name, metadata])), implementation,
  relationship: 'Host baseline policy is adapted from the pinned matcher and uses the owned runner snapshot paths and completion metadata. The pinned YAML parser produces the template consumed by the retained injected accessibility predicate through the independent native assertion lifecycle.',
  adaptations: [
    'Keep inline/file baseline selection, legacy naming, child matching configuration, ignore/update policies, negation and missing-baseline non-retriability.',
    'Parse before native dispatch and retain the original assertion deadline. Same-process frame paths reuse existing frame ownership; this predicate does not enable shared selector caching.',
    'Bound ordinary raw/regex diagnostics separately. Baseline generation retains complete strings from the same observation or returns a typed resource failure instead of writing truncated content.',
    'Validate raw template size before normalization, bound baseline UTF-8 reads and preserve existing baselines on resource failure.',
    'Bun inline generation/update policies reject before browser dispatch because the pinned runner cannot resolve their rebaseline property column. Ordinary inline matching and named file baselines remain available; Node supports inline proposals.',
    'Public ariaSnapshot methods, default failure-context artifacts and out-of-process frame support are separate capabilities.',
    'Source provenance and controlled host validation alone do not establish browser conformance or release acceptance.',
  ],
  license: 'Apache-2.0', licensePath, noticePath,
  licenseSha256: hash(await readFile(licensePath)), noticeSha256: hash(await readFile(noticePath)),
};
for (const [path, contents] of Object.entries({
  'compatibility/upstream/aria-matcher.source.txt': extract,
  'compatibility/upstream/aria-matcher-provenance.json': JSON.stringify(provenance, null, 2) + '\n',
})) {
  if (process.argv.includes('--check')) assert.equal(await readFile(path, 'utf8'), contents, `ARIA matcher provenance differs: ${path}`);
  else await writeFile(path, contents);
}
console.log(`Verified ARIA matcher provenance: ${Object.keys(snippets).length} contracts, ${implementationPaths.length} implementation files.`);
