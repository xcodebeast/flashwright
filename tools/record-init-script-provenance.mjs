import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import ts from 'typescript';

const distributionPath = 'node_modules/playwright-core/lib/coreBundle.js';
const distribution = await readFile(distributionPath, 'utf8');
assert.equal(JSON.parse(await readFile('node_modules/playwright-core/package.json', 'utf8')).version, '1.60.0');
const parsed = ts.createSourceFile(distributionPath, distribution, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const helpers = ['evaluationScript', 'addSourceUrlToScript'].map(name => {
  const declaration = parsed.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(declaration, `Pinned init-script helper ${name} must exist`);
  return declaration.getText(parsed);
});
const extract = helpers.join('\n\n') + '\n';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const retainedExtract = 'compatibility/upstream/init-scripts.source.js';
const implementationPath = 'packages/flashwright-core/src/init-scripts.ts';
const outputs = {
  [retainedExtract]: extract,
  'compatibility/upstream/init-scripts-provenance.json': JSON.stringify({
    referenceVersion: '1.60.0', source: 'https://github.com/microsoft/playwright/blob/v1.60.0/packages/playwright-core/src/client/clientHelper.ts',
    referenceFiles: ['client/clientHelper.ts', 'client/disposable.ts', 'server/page.ts', 'server/browserContext.ts', 'server/chromium/crPage.ts'],
    distributionPath, distributionSha256: hash(distribution), retainedExtract, extractSha256: hash(extract), implementationPath, implementationSha256: hash(await readFile(implementationPath)),
    relationship: 'The facade adapts the pinned function/JSON-argument, content/path precedence and sourceURL preparation. Native registration uses the same per-script IIFE scope and Chromium runImmediately only during root or child renderer initialization. Disposable ownership, cancellation and wire representation are independently implemented.',
    changes: ['Typed invalid/unsupported/source-limit failures before allocation.', 'Transport a validated JSON string through Rust without losing UTF-16 or introducing an eval wrapper.', 'Bound retained scripts and roll back partial or unreturned registrations.'],
    license: 'Apache-2.0', licensePath: 'compatibility/upstream/LICENSE.playwright', noticePath: 'compatibility/upstream/NOTICE.playwright',
  }, null, 2) + '\n',
};
for (const [path, contents] of Object.entries(outputs)) {
  if (process.argv.includes('--check')) assert.equal(await readFile(path, 'utf8'), contents, `Init-script provenance differs: ${path}`);
  else await writeFile(path, contents);
}
console.log('Verified pinned init-script preparation provenance.');
