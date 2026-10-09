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
    if (['selectText', 'scrollIntoViewIfNeeded'].includes(name) && contents.includes('this._withElement')) snippets.set(`locator.${name}`, contents);
    if (name === 'selectText' && contents.includes('this._retryAction')) snippets.set('element.selectText', contents);
    if (name === '_waitAndScrollIntoViewIfNeeded' && contents.includes('checkElementStates')) snippets.set('element.waitAndScrollIntoViewIfNeeded', contents);
    if (name === '_retryAction' && contents.includes('performActionPreChecks')) snippets.set('element.retryAction', contents);
    if (name === '_scrollRectIntoViewIfNeeded' && contents.includes('DOM.scrollIntoViewIfNeeded')) snippets.set('chromium.scrollRectIntoViewIfNeeded', contents);
  }
  ts.forEachChild(node, visit);
}
visit(parsed);
const names = ['locator._withElement', 'locator.selectText', 'locator.scrollIntoViewIfNeeded', 'element.selectText',
  'element.waitAndScrollIntoViewIfNeeded', 'element.retryAction', 'chromium.scrollRectIntoViewIfNeeded'];
for (const name of names) assert.ok(snippets.has(name), `Pinned captured-element action is missing ${name}`);
const extract = names.map(name => `// ${name}\n${snippets.get(name)}`).join('\n\n') + '\n';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const implementation = {};
for (const path of ['crates/flashwright-engine/src/element_actions.rs', 'crates/flashwright-engine/src/element_resolution.rs',
  'crates/flashwright-engine/src/handle_values.rs', 'crates/flashwright-engine/src/handles.rs', 'crates/flashwright-engine/src/handle_allocation.rs', 'crates/flashwright-engine/src/locators.rs',
  'packages/resident-runtime/locator-runtime.js', 'packages/flashwright-core/src/locator.ts',
  'packages/flashwright-core/src/handles.ts', 'packages/flashwright-core/src/index.ts']) implementation[path] = hash(await readFile(path));
const outputs = {
  'compatibility/upstream/element-actions.source.txt': extract,
  'compatibility/upstream/element-actions-provenance.json': JSON.stringify({
    referenceVersion: '1.60.0', distributionPath, distributionSha256: hash(source),
    sources: ['https://github.com/microsoft/playwright/blob/v1.60.0/packages/playwright-core/src/client/locator.ts',
      'https://github.com/microsoft/playwright/blob/v1.60.0/packages/playwright-core/src/server/dom.ts',
      'https://github.com/microsoft/playwright/blob/v1.60.0/packages/playwright-core/src/server/chromium/crPage.ts'],
    retainedExtract: 'compatibility/upstream/element-actions.source.txt', extractSha256: hash(extract), implementation,
    relationship: 'Independent native captured-node operation follows the pinned locator capture, selection, fresh stability and Chromium scroll contract. Selection and element states use the already pinned injected runtime with selector-provenance.json attribution.',
    changes: ['Fuse locator capture and action into one native deadline and private object group without consuming a public handle slot.',
      'Borrowed ElementHandle operations adopt a same-document utility alias and retain the original handle.',
      'Keep the captured node across read-only retries, release input ownership between retries and never replay uncertain selection or scroll effects.',
      'Use explicit cancellation for fresh animation-frame stability, bounded reply recovery and owned group cleanup.',
      'Only same-process frames are supported; public cross-context handle adoption remains unsupported.'],
    verification: ['compatibility/m1/test_element_actions.py', 'compatibility/m2/element-actions.mjs',
      'compatibility/m2/runner/element-action-types.ts', 'tools/test-packed-package.mjs', 'tools/run-manual-trace-tests.mjs'],
    license: 'Apache-2.0', licensePath: 'compatibility/upstream/LICENSE.playwright', noticePath: 'compatibility/upstream/NOTICE.playwright',
  }, null, 2) + '\n',
};
for (const [path, contents] of Object.entries(outputs)) {
  if (process.argv.includes('--check')) assert.equal(await readFile(path, 'utf8'), contents, `Element action provenance differs: ${path}`);
  else await writeFile(path, contents);
}
console.log('Verified pinned captured-element action provenance.');
