import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import ts from 'typescript';

const distributionPath = 'node_modules/playwright-core/lib/coreBundle.js';
const distribution = await readFile(distributionPath, 'utf8');
assert.equal(JSON.parse(await readFile('node_modules/playwright-core/package.json', 'utf8')).version, '1.60.0');
const parsed = ts.createSourceFile(distributionPath, distribution, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const names = ['getExceptionMessage', 'exceptionToError', 'splitErrorMessage'];
const retainedSource = names.map(name => {
  const declaration = parsed.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(declaration, `Pinned page error helper ${name} must exist`);
  return declaration.getText(parsed);
}).join('\n\n') + '\n';
const hash = value => createHash('sha256').update(value).digest('hex');
const destination = 'packages/flashwright-core/src/page-errors.ts';
const retainedExtract = 'compatibility/upstream/page-error.source.js';
const outputs = {
  [retainedExtract]: retainedSource,
  'compatibility/upstream/page-error-provenance.json': JSON.stringify({
    referenceVersion: '1.60.0', referenceFiles: ['server/chromium/crProtocolHelper.ts', 'utils/isomorphic/stackTrace.ts', 'server/chromium/crPage.ts', 'server/errors.ts'],
    source: 'https://github.com/microsoft/playwright/blob/v1.60.0/packages/playwright-core/src/server/chromium/crProtocolHelper.ts',
    distributionPath, distributionSha256: hash(distribution), retainedExtract, extractSha256: hash(retainedSource), destination, implementationSha256: hash(await readFile(destination)),
    changes: ['Combine exception formatting and error reconstruction in the TypeScript client.', 'Carry the original bounded Chromium event as JSON text through Rust, preserving lone UTF-16 surrogates without evaluating code in the failing document.', 'Validate the event envelope before reconstructing a native Error with the reference name, message and stack.'],
    license: 'Apache-2.0', licensePath: 'compatibility/upstream/LICENSE.playwright', noticePath: 'compatibility/upstream/NOTICE.playwright',
  }, null, 2) + '\n',
};
for (const [path, contents] of Object.entries(outputs)) {
  if (process.argv.includes('--check')) assert.equal(await readFile(path, 'utf8'), contents, `Pinned page error provenance differs: ${path}`);
  else await writeFile(path, contents);
}
console.log('Verified pinned page error formatting provenance.');
