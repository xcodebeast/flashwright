import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import ts from 'typescript';

const distributionPath = 'node_modules/playwright-core/lib/coreBundle.js';
const distribution = await readFile(distributionPath, 'utf8');
assert.equal(JSON.parse(await readFile('node_modules/playwright-core/package.json', 'utf8')).version, '1.60.0');
const parsed = ts.createSourceFile(distributionPath, distribution, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const names = ['renderPreview', 'sparseArrayToString', 'stackTraceToLocation'];
const extracts = names.map(name => {
  const declaration = parsed.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(declaration, `Pinned console helper ${name} must exist`);
  return declaration.getText(parsed);
});
const retainedSource = extracts.join('\n\n') + '\n';
const hash = value => createHash('sha256').update(value).digest('hex');
const implementationPaths = ['packages/flashwright-core/src/console.ts', 'packages/flashwright-core/src/subscribed-events.ts', 'packages/flashwright-core/src/handles.ts', 'crates/flashwright-engine/src/console.rs'];
const implementations = Object.fromEntries(await Promise.all(implementationPaths.map(async path => [path, hash(await readFile(path))])));
const retainedExtract = 'compatibility/upstream/console.source.js';
const nodeTypesPath = 'node_modules/@types/node/events.d.ts';
assert.equal(JSON.parse(await readFile('node_modules/@types/node/package.json', 'utf8')).version, '24.10.1');
assert.equal(await readFile('compatibility/upstream/LICENSE.node-types', 'utf8'), await readFile('node_modules/@types/node/LICENSE', 'utf8'));
const outputs = {
  [retainedExtract]: retainedSource,
  'compatibility/upstream/console-provenance.json': JSON.stringify({
    referenceVersion: '1.60.0',
    referenceFiles: ['server/javascript.ts', 'server/chromium/crProtocolHelper.ts', 'server/chromium/crPage.ts', 'server/console.ts', 'client/consoleMessage.ts', 'client/browserContext.ts'],
    source: 'https://github.com/microsoft/playwright/blob/v1.60.0/packages/playwright-core/src/server/javascript.ts',
    distributionPath, distributionSha256: hash(distribution), retainedExtract, extractSha256: hash(retainedSource), implementations,
    relationship: 'TypeScript preview formatting adapts the pinned renderPreview and sparseArrayToString helpers. Independent native subscriptions and ownership preserve live page/context delivery without installing an evaluation helper for capture.',
    changes: ['Carry bounded raw CDP JSON through Rust to preserve exact UTF-16 descriptions and locations.', 'Separate console object references from private evaluation groups; drop unseen references through a bounded background queue.', 'Preserve BigInt arguments and resulting message text as documented in S4.l.', 'Deliver page listeners before context listeners with the same message and handle identities.'],
    license: 'Apache-2.0', licensePath: 'compatibility/upstream/LICENSE.playwright', noticePath: 'compatibility/upstream/NOTICE.playwright',
    eventEmitterTypes: { package: '@types/node', version: '24.10.1', source: nodeTypesPath, sha256: hash(await readFile(nodeTypesPath)), relationship: 'EventKey and EventListener adapt the Key and Listener/Listener1 conditional types to maintain typed overrides and polymorphic this; use readable parameter names and unknown[] for the unused default event map.', license: 'MIT', licensePath: 'compatibility/upstream/LICENSE.node-types' },
  }, null, 2) + '\n',
};
for (const [path, contents] of Object.entries(outputs)) {
  if (process.argv.includes('--check')) assert.equal(await readFile(path, 'utf8'), contents, `Pinned console provenance differs: ${path}`);
  else await writeFile(path, contents);
}
console.log('Verified pinned console formatting and EventEmitter type provenance.');
