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
    if (name === 'insertText' && contents.includes('this._page._channel.keyboardInsertText')) snippets.set('client.insertText', contents);
    if (name === 'keyboardInsertText' && contents.includes('this._page.keyboard.apiInsertText')) snippets.set('dispatcher.keyboardInsertText', contents);
    if (name === 'apiInsertText' && contents.includes('onBeforeInputAction')) snippets.set('keyboard.apiInsertText', contents);
    if (name === 'insertText' && contents.includes('this._raw.sendText')) snippets.set('keyboard.insertText', contents);
    if (name === 'sendText' && contents.includes('"Input.insertText"')) snippets.set('chromium.sendText', contents);
  }
  ts.forEachChild(node, visit);
}
visit(parsed);
const names = ['client.insertText', 'dispatcher.keyboardInsertText', 'keyboard.apiInsertText', 'keyboard.insertText', 'chromium.sendText'];
for (const name of names) assert.ok(snippets.has(name), `Pinned native insertion is missing ${name}`);
const extract = names.map(name => `// ${name}\n${snippets.get(name)}`).join('\n\n') + '\n';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const implementation = {};
for (const path of [
  'packages/flashwright-core/src/keyboard.ts', 'packages/flashwright-core/src/index.ts',
  'packages/flashwright-core/src/engine-contract.ts', 'crates/flashwright-engine/src/keyboard.rs',
  'crates/flashwright-engine/src/input.rs', 'crates/flashwright-engine/src/lib.rs',
  'packages/flashwright-core/src/tracing.ts',
]) implementation[path] = hash(await readFile(path));
const outputs = {
  'compatibility/upstream/keyboard-insert-text.source.txt': extract,
  'compatibility/upstream/keyboard-insert-text-provenance.json': JSON.stringify({
    referenceVersion: '1.60.0', distributionPath, distributionSha256: hash(source),
    sources: [
      'https://github.com/microsoft/playwright/blob/v1.60.0/packages/playwright-core/src/client/input.ts',
      'https://github.com/microsoft/playwright/blob/v1.60.0/packages/playwright-core/src/server/input.ts',
      'https://github.com/microsoft/playwright/blob/v1.60.0/packages/playwright-core/src/server/chromium/crInput.ts',
      'https://github.com/microsoft/playwright/blob/v1.60.0/packages/playwright-core/src/server/dispatchers/pageDispatcher.ts',
    ],
    retainedExtract: 'compatibility/upstream/keyboard-insert-text.source.txt', extractSha256: hash(extract), implementation,
    relationship: 'Preserve one whole-string native Input.insertText command, existing browser focus/selection and before-input instrumentation.',
    changes: [
      'Apply the existing 100000 UTF-16 unit bound and explicit rejection of unpaired surrogates before native input.',
      'Serialize native input under existing per-page ownership without selector resolution, focus, navigation waits or input replay.',
      'Cancellation preserves its original public error and input delivery uncertainty; dispatched replies retain existing native credits until reply or connection loss.',
      'Optional snapshots retain the original trace context, chunk, call and page; native acknowledgement is not evidence that insertion occurred.',
    ],
    license: 'Apache-2.0', licensePath: 'compatibility/upstream/LICENSE.playwright', noticePath: 'compatibility/upstream/NOTICE.playwright',
  }, null, 2) + '\n',
};
for (const [path, contents] of Object.entries(outputs)) {
  if (process.argv.includes('--check')) assert.equal(await readFile(path, 'utf8'), contents, `Native insertion provenance differs: ${path}`);
  else await writeFile(path, contents);
}
console.log('Verified pinned keyboard.insertText provenance.');
