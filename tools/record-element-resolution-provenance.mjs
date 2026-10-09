import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import ts from 'typescript';

const distributionPath = 'node_modules/playwright-core/lib/coreBundle.js';
const source = await readFile(distributionPath, 'utf8');
assert.equal(JSON.parse(await readFile('node_modules/playwright-core/package.json', 'utf8')).version, '1.60.0');
const parsed = ts.createSourceFile(distributionPath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const snippets = new Map();
function visit(node) {
  if (ts.isMethodDeclaration(node)) {
    const name = node.name.getText(parsed);
    const contents = node.getText(parsed);
    if (name === '_withElement' && contents.includes('waitForSelector')) snippets.set('locator._withElement', contents);
    if (['evaluate', 'evaluateHandle'].includes(name) && contents.includes('this._withElement')) snippets.set(`locator.${name}`, contents);
    if (name === 'elementHandle' && contents.includes('this._frame.waitForSelector')) snippets.set('locator.elementHandle', contents);
    if (name === 'waitForSelector' && contents.includes('this.selectors.resolveInjectedForSelector')) snippets.set('frame.waitForSelector', contents);
    if (name === '_adoptElementHandle' && contents.includes('DOM.describeNode')) snippets.set('chromium.adoptElementHandle', contents);
    if (name === '_adoptBackendNodeId' && contents.includes('DOM.resolveNode')) snippets.set('chromium.adoptBackendNodeId', contents);
  }
  ts.forEachChild(node, visit);
}
visit(parsed);
const names = ['locator._withElement', 'locator.evaluate', 'locator.evaluateHandle', 'locator.elementHandle', 'frame.waitForSelector', 'chromium.adoptElementHandle', 'chromium.adoptBackendNodeId'];
for (const name of names) assert.ok(snippets.has(name), `Pinned element resolution is missing ${name}`);
const extract = names.map(name => `// ${name}\n${snippets.get(name)}`).join('\n\n') + '\n';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const implementation = {};
for (const path of ['crates/flashwright-engine/src/element_resolution.rs', 'crates/flashwright-engine/src/evaluation.rs',
  'crates/flashwright-engine/src/handles.rs', 'crates/flashwright-engine/src/handle_allocation.rs', 'crates/flashwright-engine/src/publication.rs', 'crates/flashwright-engine/src/locators.rs',
  'packages/resident-runtime/locator-runtime.js', 'packages/flashwright-core/src/element-resolution.ts', 'packages/flashwright-core/src/index.ts',
  'packages/flashwright-core/src/frame.ts', 'packages/flashwright-core/src/locator.ts', 'packages/flashwright-core/src/client.ts']) implementation[path] = hash(await readFile(path));
const outputs = {
  'compatibility/upstream/element-resolution.source.txt': extract,
  'compatibility/upstream/element-resolution-provenance.json': JSON.stringify({
    referenceVersion: '1.60.0', distributionPath, distributionSha256: hash(source),
    sources: ['https://github.com/microsoft/playwright/blob/v1.60.0/packages/playwright-core/src/client/locator.ts',
      'https://github.com/microsoft/playwright/blob/v1.60.0/packages/playwright-core/src/server/frames.ts',
      'https://github.com/microsoft/playwright/blob/v1.60.0/packages/playwright-core/src/server/chromium/crPage.ts'],
    retainedExtract: 'compatibility/upstream/element-resolution.source.txt', extractSha256: hash(extract), implementation,
    relationship: 'Independent native resolver uses the existing pinned selector runtime, adopts same-document nodes into their main execution context and follows the pinned temporary-handle locator evaluation contract.',
    changes: ['Use bounded UTF-16 selector and value envelopes.', 'Own each observation/adoption object group until successful transactional publication or cleanup.',
      'Pin document loader and unique main-world context identity around adoption; retry resolution without replaying user callbacks.',
      'Public cross-context handle adoption and out-of-process frames remain unsupported.'],
    license: 'Apache-2.0', licensePath: 'compatibility/upstream/LICENSE.playwright', noticePath: 'compatibility/upstream/NOTICE.playwright',
  }, null, 2) + '\n',
};
for (const [path, contents] of Object.entries(outputs)) {
  if (process.argv.includes('--check')) assert.equal(await readFile(path, 'utf8'), contents, `Element resolution provenance differs: ${path}`);
  else await writeFile(path, contents);
}
console.log('Verified pinned element-resolution provenance.');
