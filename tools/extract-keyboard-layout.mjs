import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const distributionPath = 'node_modules/playwright-core/lib/coreBundle.js';
const distribution = await readFile(distributionPath, 'utf8');
assert.equal(JSON.parse(await readFile('node_modules/playwright-core/package.json', 'utf8')).version, '1.60.0');
const parsed = ts.createSourceFile(distributionPath, distribution, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const assignments = new Map();
let buildLayout;
function visit(node) {
  if (ts.isBinaryExpression(node) && ts.isIdentifier(node.left) && ['USKeyboardLayout', 'aliases', 'macEditingCommands'].includes(node.left.text)) assignments.set(node.left.text, node.right.getText(parsed));
  if (ts.isFunctionDeclaration(node) && node.name?.text === 'buildLayoutClosure') buildLayout = node.getText(parsed);
  ts.forEachChild(node, visit);
}
visit(parsed);
assert.equal(assignments.size, 3); assert.ok(buildLayout);
const retainedSource = `const keypadLocation = 3;\n${[...assignments].map(([name, expression]) => `const ${name} = ${expression};`).join('\n')}\n${buildLayout}\n`;
// Only the inspected constants and pure layout builder execute, never the browser driver bundle.
const layout = runInNewContext(`${retainedSource}\n({ keys: Object.fromEntries(buildLayoutClosure(USKeyboardLayout)), macEditingCommands });`, { assert }, { timeout: 1000 });
const destination = 'crates/flashwright-engine/src/keyboard-layout.json';
const retainedExtract = 'compatibility/upstream/keyboard-layout.source.js';
const hash = value => createHash('sha256').update(value).digest('hex');
const data = JSON.stringify(layout, null, 2) + '\n';
const outputs = {
  [destination]: data,
  [retainedExtract]: retainedSource,
  'compatibility/upstream/keyboard-provenance.json': JSON.stringify({
    referenceVersion: '1.60.0', source: 'https://github.com/microsoft/playwright/tree/v1.60.0/packages/playwright-core/src/server',
    referenceFiles: ['usKeyboardLayout.ts', 'input.ts', 'macEditingCommands.ts', 'chromium/crInput.ts'],
    distributionPath, distributionSha256: hash(distribution), retainedExtract, extractSha256: hash(retainedSource),
    destination, generatedSha256: hash(data),
    extraction: 'Retain the pinned US layout, aliases, macOS editing commands and pure layout builder; evaluate only that extract to generate immutable key descriptions.',
    changes: ['Ported chord parsing, modifier state, native key event fields and macOS editing-command selection into Rust with owned cancellation cleanup', 'Share chord dispatch between locator.press and page.keyboard.press while preserving locator focus, timeout and navigation barriers separately', 'Sequential typing shares key-pair dispatch for layout characters and uses native insertion for other Unicode code points; typing does not inherit the press navigation barrier'],
    license: 'Apache-2.0', licensePath: 'compatibility/upstream/LICENSE.playwright', noticePath: 'compatibility/upstream/NOTICE.playwright',
  }, null, 2) + '\n',
};
for (const [path, content] of Object.entries(outputs)) {
  if (process.argv.includes('--check')) assert.equal(await readFile(path, 'utf8'), content, `Pinned keyboard source differs: ${path}`);
  else await writeFile(path, content);
}
console.log(`Verified ${Object.keys(layout.keys).length} pinned keyboard descriptions and ${Object.keys(layout.macEditingCommands).length} macOS editing shortcuts.`);
