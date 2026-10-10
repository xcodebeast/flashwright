import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import ts from 'typescript';

const distributionPath = 'node_modules/playwright-core/lib/coreBundle.js';
const source = await readFile(distributionPath, 'utf8');
assert.equal(JSON.parse(await readFile('node_modules/playwright-core/package.json', 'utf8')).version, '1.60.0');
const parsed = ts.createSourceFile(distributionPath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const methods = ['click', 'dblclick', 'hover', 'check', 'uncheck', 'setChecked', 'fill', 'focus', 'selectOption', 'press', 'type'];
const snippets = new Map();
function visit(node) {
  if (ts.isMethodDeclaration(node)) {
    const name = node.name.getText(parsed);
    const contents = node.getText(parsed);
    if (methods.includes(name) && contents.includes(`this._channel.${name}({ selector,`)) snippets.set(`client.${name}`, contents);
    if (name === 'setChecked' && contents.includes('this.check(selector, options2)')) snippets.set('client.setChecked', contents);
    if (name === '_parseSelector' && contents.includes('strictSelectors')) snippets.set('selector.strictness', contents);
    if (name === '_retryWithProgressIfNotConnected' && contents.includes('info.strict')) snippets.set('server.retry', contents);
    if (methods.includes(name) && contents.includes('_retryWithProgressIfNotConnected')) snippets.set(`server.${name}`, contents);
  }
  ts.forEachChild(node, visit);
}
visit(parsed);
const selected = ['selector.strictness', 'server.retry', ...methods.map(name => `client.${name}`), ...methods.filter(name => name !== 'setChecked').map(name => `server.${name}`)];
for (const name of selected) assert.ok(snippets.has(name), `Pinned selector-action contract missing ${name}`);
const extract = selected.map(name => `// ${name}\n${snippets.get(name)}`).join('\n\n') + '\n';
const hash = value => createHash('sha256').update(value).digest('hex');
const implementation = {};
for (const path of ['crates/flashwright-engine/src/locators.rs', 'crates/flashwright-engine/src/locators/traced_action.rs', 'crates/flashwright-engine/src/keyboard.rs', 'packages/flashwright-core/src/selector-actions.ts', 'packages/flashwright-core/src/frame.ts', 'packages/flashwright-core/src/index.ts', 'packages/flashwright-core/src/locator.ts', 'packages/flashwright-core/src/trace-hooks.ts', 'packages/resident-runtime/locator-runtime.js']) implementation[path] = hash(await readFile(path));
const outputs = {
  'compatibility/upstream/selector-actions.source.txt': extract,
  'compatibility/upstream/selector-actions-provenance.json': JSON.stringify({
    referenceVersion: '1.60.0', distributionPath, distributionSha256: hash(source),
    sources: ['client/frame.ts', 'server/frameSelectors.ts', 'server/frames.ts'].map(path => `https://github.com/microsoft/playwright/blob/v1.60.0/packages/playwright-core/src/${path}`),
    retainedExtract: 'compatibility/upstream/selector-actions.source.txt', extractSha256: hash(extract), implementation,
    relationship: 'Independent facade shares native action operations with Locator; per-call selector strictness is carried through every native resolution attempt. Pinned source defines first-match defaults, explicit strictness, retries and method delegation.',
    limitations: ['Context strictSelectors remains explicitly unsupported.', 'Only existing native action options are admitted: pointer steps, hover noWaitAfter and selectOption ElementHandle values remain outside this slice.', 'Same-process frame coverage only; no FrameLocator or download implementation is implied.'],
    license: 'Apache-2.0', licensePath: 'compatibility/upstream/LICENSE.playwright', noticePath: 'compatibility/upstream/NOTICE.playwright',
  }, null, 2) + '\n',
};
for (const [path, contents] of Object.entries(outputs)) {
  if (process.argv.includes('--check')) assert.equal(await readFile(path, 'utf8'), contents, `Selector-action provenance differs: ${path}`);
  else await writeFile(path, contents);
}
console.log('Verified pinned selector-action provenance.');
