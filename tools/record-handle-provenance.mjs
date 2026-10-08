import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import ts from 'typescript';

const distributionPath = 'node_modules/playwright-core/lib/coreBundle.js';
const distribution = await readFile(distributionPath, 'utf8');
assert.equal(JSON.parse(await readFile('node_modules/playwright-core/package.json', 'utf8')).version, '1.60.0');
const parsed = ts.createSourceFile(distributionPath, distribution, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const names = ['serialize', 'parseUnserializableValue', 'potentiallyUnserializableValue', 'renderPreview', 'createHandle'];
const retainedSource = names.map(name => {
  const declaration = parsed.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(declaration, `Pinned handle helper ${name} must exist`);
  return declaration.getText(parsed);
}).join('\n\n') + '\n';
assert.ok(retainedSource.includes('ref: <Node>'));
const hash = value => createHash('sha256').update(value).digest('hex');
const implementationPaths = ['packages/resident-runtime/serialization.cjs', 'packages/resident-runtime/evaluation.cjs', 'packages/flashwright/src/handles.ts', 'crates/flashwright-engine/src/handles.rs', 'crates/flashwright-engine/src/handle_values.rs'];
const implementations = Object.fromEntries(await Promise.all(implementationPaths.map(async path => [path, hash(await readFile(path))])));
const retainedExtract = 'compatibility/upstream/handle-value.source.js';
const outputs = {
  [retainedExtract]: retainedSource,
  'compatibility/upstream/handle-value-provenance.json': JSON.stringify({
    referenceVersion: '1.60.0',
    referenceFiles: ['server/isomorphic/utilityScriptSerializers.ts', 'server/chromium/crExecutionContext.ts', 'server/javascript.ts', 'client/jsHandle.ts'],
    source: 'https://github.com/microsoft/playwright/blob/v1.60.0/packages/playwright-core/src/server/isomorphic/utilityScriptSerializers.ts',
    distributionPath, distributionSha256: hash(distribution), retainedExtract, extractSha256: hash(retainedSource), implementations,
    relationship: 'Independent native handle ownership and wire representation. DOM reference descriptions adapt the pinned serializer contract. Retained helper extracts also document primitive previews and the S4.l BigInt difference; they are not bundled as executable code.',
    changes: ['Use the shared bounded graph codec and exact UTF-16 strings for values and property names.', 'Allocate new remote references in private groups, publish transactionally and clean up rejected or cancelled results.', 'Preserve BigInt handle values instead of the reference parseUnserializableValue fallthrough to undefined.'],
    license: 'Apache-2.0', licensePath: 'compatibility/upstream/LICENSE.playwright', noticePath: 'compatibility/upstream/NOTICE.playwright',
  }, null, 2) + '\n',
};
for (const [path, contents] of Object.entries(outputs)) {
  if (process.argv.includes('--check')) assert.equal(await readFile(path, 'utf8'), contents, `Pinned handle provenance differs: ${path}`);
  else await writeFile(path, contents);
}
console.log('Verified pinned handle value provenance.');
