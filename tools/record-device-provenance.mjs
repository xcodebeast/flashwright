import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import ts from 'typescript';

const distributionPath = 'node_modules/playwright-core/lib/coreBundle.js';
const distribution = await readFile(distributionPath, 'utf8');
assert.equal(JSON.parse(await readFile('node_modules/playwright-core/package.json', 'utf8')).version, '1.60.0');
const source = ts.createSourceFile(distributionPath, distribution, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const declaration = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'calculateUserAgentMetadata');
assert.ok(declaration, 'Pinned user-agent metadata helper must exist');
const retainedSource = declaration.getText(source) + '\n';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const implementationPath = 'packages/flashwright-core/src/devices.ts';
const retainedExtract = 'compatibility/upstream/device-metadata.source.js';
const outputs = {
  [retainedExtract]: retainedSource,
  'compatibility/upstream/device-metadata-provenance.json': JSON.stringify({
    referenceVersion: '1.60.0', source: 'https://github.com/microsoft/playwright/blob/v1.60.0/packages/playwright-core/src/server/chromium/crPage.ts',
    distributionPath, distributionSha256: hash(distribution), retainedExtract, extractSha256: hash(retainedSource),
    implementationPath, implementationSha256: hash(await readFile(implementationPath)),
    relationship: 'The TypeScript helper adapts pinned calculateUserAgentMetadata for native Chromium Emulation.setUserAgentOverride; ordered platform matching, values and ARM override are preserved.',
    changes: ['Use descriptive names and an ordered platform table instead of repeated conditional branches.', 'Validate public options before context allocation; transport the metadata explicitly to the native context owner.'],
    license: 'Apache-2.0', licensePath: 'compatibility/upstream/LICENSE.playwright', noticePath: 'compatibility/upstream/NOTICE.playwright',
  }, null, 2) + '\n',
};
for (const [path, contents] of Object.entries(outputs)) {
  if (process.argv.includes('--check')) assert.equal(await readFile(path, 'utf8'), contents, `Pinned device metadata provenance differs: ${path}`);
  else await writeFile(path, contents);
}
console.log('Verified pinned device metadata provenance.');
