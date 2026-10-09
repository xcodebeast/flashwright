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
    if (name === 'pressSequentially' && contents.includes('this.type')) snippets.set('locator.pressSequentially', contents);
    if (name === 'type' && contents.includes('this._frame.type(this._selector')) snippets.set('locator.type', contents);
    if (name === '_type' && contents.includes('this._page.keyboard.type')) snippets.set('element._type', contents);
    if (name === 'type' && contents.includes('usKeyboardLayout.has')) snippets.set('keyboard.type', contents);
    if (name === 'press' && contents.includes('function split(keyString)')) snippets.set('keyboard.press', contents);
  }
  ts.forEachChild(node, visit);
}
visit(parsed);
const names = ['locator.pressSequentially', 'locator.type', 'element._type', 'keyboard.type', 'keyboard.press'];
for (const name of names) assert.ok(snippets.has(name), `Pinned sequential typing is missing ${name}`);
const extract = names.map(name => `// ${name}\n${snippets.get(name)}`).join('\n\n') + '\n';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const implementation = {};
for (const path of ['crates/flashwright-engine/src/keyboard.rs', 'crates/flashwright-engine/src/locators.rs',
  'packages/flashwright-core/src/keyboard.ts', 'packages/flashwright-core/src/locator.ts', 'packages/flashwright-core/src/index.ts']) implementation[path] = hash(await readFile(path));
const outputs = {
  'compatibility/upstream/sequential-typing.source.txt': extract,
  'compatibility/upstream/sequential-typing-provenance.json': JSON.stringify({
    referenceVersion: '1.60.0', distributionPath, distributionSha256: hash(source),
    sources: ['https://github.com/microsoft/playwright/blob/v1.60.0/packages/playwright-core/src/client/locator.ts',
      'https://github.com/microsoft/playwright/blob/v1.60.0/packages/playwright-core/src/server/dom.ts',
      'https://github.com/microsoft/playwright/blob/v1.60.0/packages/playwright-core/src/server/input.ts'],
    retainedExtract: 'compatibility/upstream/sequential-typing.source.txt', extractSha256: hash(extract), implementation,
    relationship: 'Native code-point loop follows the pinned layout-key versus insertText behavior and method-specific focus, delay and completion contract.',
    changes: ['Validate complete bounded text before focus; unpaired UTF-16 native input remains explicitly unsupported.',
      'Serialize the entire sequence through existing per-page native input ownership, release held keys on cancellation and never replay input.',
      'Locator typing focuses once; page keyboard typing retains current focus and an unbounded public timeout. Neither adds a press-style navigation barrier.'],
    license: 'Apache-2.0', licensePath: 'compatibility/upstream/LICENSE.playwright', noticePath: 'compatibility/upstream/NOTICE.playwright',
  }, null, 2) + '\n',
};
for (const [path, contents] of Object.entries(outputs)) {
  if (process.argv.includes('--check')) assert.equal(await readFile(path, 'utf8'), contents, `Sequential typing provenance differs: ${path}`);
  else await writeFile(path, contents);
}
console.log('Verified pinned sequential-typing provenance.');
