import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import typescript from 'typescript';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
assert.equal(JSON.parse(await readFile('node_modules/playwright/package.json', 'utf8')).version, '1.60.0');
const distributions = {}, snippets = {};
for (const path of ['node_modules/playwright-core/lib/coreBundle.js', 'packages/resident-runtime/playwright-injected.js']) {
  const source = await readFile(path, 'utf8'); distributions[path] = hash(source);
  const syntax = typescript.createSourceFile(path, source, typescript.ScriptTarget.Latest, true, typescript.ScriptKind.JS);
  assert.deepEqual(syntax.parseDiagnostics, []);
  function visit(node) {
    const name = (typescript.isMethodDeclaration(node) || typescript.isFunctionDeclaration(node)) ? node.name?.getText(syntax) : undefined;
    let contract;
    if (name === 'ariaSnapshotForFrame') contract = name;
    if (path.includes('playwright-injected') && name === 'ariaSnapshot' && node.getText(syntax).includes('incrementalAriaSnapshot')) contract = 'InjectedScript.ariaSnapshot';
    if (name === 'ariaSnapshot' && node.getText(syntax).includes('_retryWithProgressIfNotConnected')) contract = 'Frame.ariaSnapshot';
    if (contract) {
      assert(!snippets[contract]);
      snippets[contract] = { path, firstLine: syntax.getLineAndCharacterOfPosition(node.getStart()).line + 1, text: node.getText(syntax) };
    }
    typescript.forEachChild(node, visit);
  }
  visit(syntax);
}
for (const name of ['ariaSnapshotForFrame', 'InjectedScript.ariaSnapshot', 'Frame.ariaSnapshot']) assert(snippets[name], name);
const extract = Object.entries(snippets).map(([name, item]) => `// ${name}: ${item.path}:${item.firstLine}\n${item.text}`).join('\n\n') + '\n';
const implementationPaths = ['crates/flashwright-engine/src/aria_snapshots.rs', 'crates/flashwright-engine/src/lib.rs', 'crates/flashwright-engine/src/locators.rs', 'packages/flashwright-core/src/aria-snapshot.ts', 'packages/flashwright-core/src/index.ts', 'packages/flashwright-core/src/locator.ts', 'packages/flashwright-core/src/frame.ts', 'packages/flashwright-core/src/trace-hooks.ts', 'packages/flashwright-core/src/tracing.ts', 'packages/resident-runtime/aria-snapshot.js', 'packages/resident-runtime/locator-runtime.js', 'packages/resident-runtime/sources.txt', 'tools/test-public-aria-snapshot.mjs', 'tools/test-public-aria-packaged-validation.mjs', 'tools/run-public-aria-snapshot-tests.mjs', 'compatibility/m2/public-aria-snapshots.mjs'];
const implementation = Object.fromEntries(await Promise.all(implementationPaths.map(async path => [path, hash(await readFile(path))])));
const provenance = {
  referenceVersion: '1.60.0', distributions, implementation,
  upstream: ['https://github.com/microsoft/playwright/blob/v1.60.0/packages/playwright-core/src/server/frames.ts', 'https://github.com/microsoft/playwright/blob/v1.60.0/packages/injected/src/injectedScript.ts'],
  retainedExtract: 'compatibility/upstream/public-aria.source.txt', extractSha256: hash(extract),
  relationship: 'Independent native operation invokes the already attributed pinned default renderer. It preserves strict selection, pending-navigation prechecks, missing-target retries and original document ownership. No new upstream browser-command backend is used.',
  contracts: ['Public Page and Locator default mode only; same-process frame locators retain original root and selected document checks. Public AI mode and remote-frame ARIA snapshots reject explicitly.', 'Normalize options before trace owner lookup; application getters are read once. Getter traces retain action/result/source and filmstrip activity without DOM snapshot references.', 'Requests and output each permit100000 UTF-16 units; excessive output rejects atomically. The output limit does not bound browser DOM/tree allocations or synchronous renderer CPU.', 'One original operation owns inherited/explicit-zero deadlines, navigation prechecks, frame resolution and retry. Pinned default snapshot-map side effects are preserved.', 'The private failure-context fallback is a separate operation and does not expand public AI support. This record is provenance, not a merged verification claim.'],
  license: 'Apache-2.0', licensePath: 'compatibility/upstream/LICENSE.playwright', noticePath: 'compatibility/upstream/NOTICE.playwright',
};
for (const [path, contents] of Object.entries({ 'compatibility/upstream/public-aria.source.txt': extract, 'compatibility/upstream/public-aria-provenance.json': JSON.stringify(provenance, null, 2) + '\n' })) {
  if (process.argv.includes('--check')) assert.equal(await readFile(path, 'utf8'), contents, `Public ARIA provenance differs: ${path}`);
  else await writeFile(path, contents);
}
console.log('Verified public default ARIA provenance.');
