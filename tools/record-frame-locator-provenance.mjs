import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import ts from 'typescript';

const distributionPath = 'node_modules/playwright-core/lib/coreBundle.js';
const distribution = await readFile(distributionPath, 'utf8');
assert.equal(JSON.parse(await readFile('node_modules/playwright-core/package.json', 'utf8')).version, '1.60.0');
const source = ts.createSourceFile(distributionPath, distribution, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const snippets = new Map();
function visit(node) {
  if (ts.isFunctionDeclaration(node) && ['parseSelector', 'splitSelectorByFrame', 'stringifySelector', 'visitAllSelectorParts'].includes(node.name?.text)) snippets.set(node.name.text, node.getText(source));
  if (ts.isClassExpression(node) && node.name?.text === '_FrameLocator') snippets.set('client.FrameLocator', node.getText(source));
  if (ts.isMethodDeclaration(node)) {
    const name = node.name.getText(source);
    const contents = node.getText(source);
    if (name === 'resolveFrameForSelector' || name === 'queryCount' && contents.includes('resolveInjectedForSelector') || name === '_expectInternal' && contents.includes('resolveFrameForSelector')) snippets.set(`server.${name}`, contents);
    if (name === '_getContentFrame' && contents.includes('DOM.describeNode')) snippets.set('chromium.contentFrame', contents);
    if (name === '_parseSelector' && contents.includes('strictSelectors')) snippets.set('server.strictness', contents);
    if (name === 'contentFrame' && contents.includes('new FrameLocator')) snippets.set('client.Locator.contentFrame', contents);
  }
  ts.forEachChild(node, visit);
}
visit(source);
const names = ['client.FrameLocator', 'client.Locator.contentFrame', 'parseSelector', 'splitSelectorByFrame', 'stringifySelector', 'visitAllSelectorParts', 'server.resolveFrameForSelector', 'server.strictness', 'server.queryCount', 'server._expectInternal', 'chromium.contentFrame'];
for (const name of names) assert.ok(snippets.has(name), `Missing pinned frame-locator contract: ${name}`);
const extract = names.map(name => `// ${name}\n${snippets.get(name)}`).join('\n\n') + '\n';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const implementation = {};
for (const path of [
  'packages/flashwright-core/src/locator.ts', 'packages/flashwright-core/src/index.ts',
  'packages/resident-runtime/locator-runtime.js', 'crates/flashwright-engine/src/locators/frame_selector.rs',
  'crates/flashwright-engine/src/locators.rs', 'crates/flashwright-engine/src/assertions.rs',
  'crates/flashwright-engine/src/element_resolution.rs', 'crates/flashwright-engine/src/element_actions.rs',
  'crates/flashwright-engine/src/file_inputs.rs', 'crates/flashwright-engine/src/keyboard.rs', 'crates/flashwright-engine/src/pointer.rs',
  'crates/flashwright-engine/src/recording/phases.rs',
  'crates/flashwright-engine/src/recording.rs',
  'crates/flashwright-engine/src/evaluation.rs', 'crates/flashwright-engine/src/page_state.rs',
  'crates/flashwright-engine/src/renderer_sessions.rs', 'crates/flashwright-engine/src/renderer_setup.rs',
  'crates/flashwright-engine/src/events.rs',
]) implementation[path] = hash(await readFile(path));
const outputs = {
  'compatibility/upstream/frame-locators.source.txt': extract,
  'compatibility/upstream/frame-locators-provenance.json': JSON.stringify({
    referenceVersion: '1.60.0', distributionPath, distributionSha256: hash(distribution),
    sources: ['packages/playwright-core/src/client/locator.ts', 'packages/playwright-core/src/server/frameSelectors.ts', 'packages/playwright-core/src/server/frames.ts', 'packages/playwright-core/src/server/chromium/crPage.ts', 'packages/isomorphic/selectorParser.ts'].map(path => `https://github.com/microsoft/playwright/blob/v1.60.0/${path}`),
    retainedExtract: 'compatibility/upstream/frame-locators.source.txt', extractSha256: hash(extract), implementation,
    adaptations: [
      'Lazy TypeScript frame paths preserve public descriptor composition and original root Frame ownership.',
      'The resident splitter uses the pinned injected parser, validates nested frame controls and reconstructs transformed nested bodies after same-frame prefix removal.',
      'Rust resolves temporary frame-owner nodes through bounded private allocation groups and DOM.describeNode; final operations share existing native targeting and deadlines.',
      'Frame-path assertions use ordinary host retries to re-resolve changing ancestor selectors; known-frame assertions retain existing document residency.',
      'Selector-to-handle resolution captures the before phase, and uploads capture their original selected node before assignment while retaining document and cancellation guards.',
      'Completed input phases may be captured again on a later native attempt; pending capture ownership and single before/after boundaries remain deduplicated.',
      'Remote selector-to-handle and captured evaluation use ready original renderer sessions; retired sessions retain bounded initialization and cleanup ownership without borrowing successors.',
    ],
    limitations: ['Remote frame coverage is limited to selector-to-handle resolution and evaluation; remote locator input, reads, assertions, networking and artifacts remain outside this slice.', 'This provenance record is not conformance, performance or release acceptance.'],
    license: 'Apache-2.0', licensePath: 'compatibility/upstream/LICENSE.playwright', noticePath: 'compatibility/upstream/NOTICE.playwright',
  }, null, 2) + '\n',
};
for (const [path, contents] of Object.entries(outputs)) {
  if (process.argv.includes('--check')) assert.equal(await readFile(path, 'utf8'), contents, `Frame-locator provenance differs: ${path}`);
  else await writeFile(path, contents);
}
console.log('Verified pinned frame-locator provenance.');
