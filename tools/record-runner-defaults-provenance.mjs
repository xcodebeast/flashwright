import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import ts from 'typescript';

const distributionPath = 'node_modules/playwright/lib/index.js';
const source = await readFile(distributionPath, 'utf8');
assert.equal(JSON.parse(await readFile('node_modules/playwright/package.json', 'utf8')).version, '1.60.0');
const parsed = ts.createSourceFile(distributionPath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const snippets = new Map();
function visit(node) {
  if (ts.isPropertyAssignment(node)) {
    const name = node.name.getText(parsed);
    if (name === 'runBeforeCreateBrowserContext' || name === '_setupContextOptions' || name === '_combinedContextOptions' && ts.isArrayLiteralExpression(node.initializer) && ts.isArrowFunction(node.initializer.elements[0])) snippets.set(name, node.getText(parsed));
  }
  ts.forEachChild(node, visit);
}
visit(parsed);
const selected = ['_combinedContextOptions', 'runBeforeCreateBrowserContext', '_setupContextOptions'];
for (const name of selected) assert.ok(snippets.has(name), `Pinned runner contract missing ${name}`);
const extract = selected.map(name => `// ${name}\n${snippets.get(name)}`).join('\n\n') + '\n';
const hash = value => createHash('sha256').update(value).digest('hex');
const implementation = {};
for (const path of ['packages/flashwright-core/src/runner-context-defaults.ts', 'packages/flashwright-core/src/runner-integration.ts', 'packages/flashwright-runner/src/index.ts']) implementation[path] = hash(await readFile(path));
const outputs = {
  'compatibility/upstream/runner-defaults.source.txt': extract,
  'compatibility/upstream/runner-defaults-provenance.json': JSON.stringify({
    referenceVersion: '1.60.0', source: 'https://github.com/microsoft/playwright/blob/v1.60.0/packages/playwright/src/index.ts', distributionPath, distributionSha256: hash(source),
    retainedExtract: 'compatibility/upstream/runner-defaults.source.txt', extractSha256: hash(extract), implementation,
    relationship: 'The adapter preserves pinned combined-options precedence, explicit-property suppression of inherited defaults and all-hooks-included lifecycle. Native context creation and versioned canonical scope ownership are independent implementations.',
    changes: ['Apply only implemented native context options; reject unsupported options explicitly.', 'Use one canonical-core scope instead of upstream client instrumentation.', 'Capture options and timeouts at context invocation; restore scope on runner teardown.', 'Keep the boundary private to canonical core; preserve mixed ESM/CommonJS identity.'],
    license: 'Apache-2.0', licensePath: 'compatibility/upstream/LICENSE.playwright', noticePath: 'compatibility/upstream/NOTICE.playwright',
  }, null, 2) + '\n',
};
for (const [path, contents] of Object.entries(outputs)) {
  if (process.argv.includes('--check')) assert.equal(await readFile(path, 'utf8'), contents, `Runner defaults provenance differs: ${path}`);
  else await writeFile(path, contents);
}
console.log('Verified pinned runner-defaults provenance.');
