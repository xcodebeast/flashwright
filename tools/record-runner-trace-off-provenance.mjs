import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import ts from 'typescript';

const hash = value => createHash('sha256').update(value).digest('hex');
assert.equal(JSON.parse(await readFile('node_modules/playwright/package.json', 'utf8')).version, '1.60.0');
const distribution = 'node_modules/playwright/lib/worker/workerProcessEntry.js';
const source = await readFile(distribution, 'utf8');
const parsed = ts.createSourceFile(distribution, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const names = ['startIfNeeded', 'traceOptions', 'stopIfNeeded', 'appendForError', 'appendStdioToTrace', 'appendBeforeActionForStep', 'appendAfterActionForStep', '_appendTraceEvent', 'resolveParametersForFunction'];
const methods = {};
function visit(node) {
  if (ts.isMethodDeclaration(node) && ts.isClassExpression(node.parent)) {
    const owner = node.parent.parent.name?.getText(parsed);
    const name = node.name.getText(parsed);
    if (names.includes(name) && (owner === 'TestTracing' || owner === 'FixtureRunner' && name === 'resolveParametersForFunction')) methods[name] = hash(node.getText(parsed));
  }
  ts.forEachChild(node, visit);
}
visit(parsed);
for (const name of names) assert(methods[name], `Missing pinned runner contract ${name}`);
const implementation = {};
for (const path of ['packages/flashwright-runner/src/index.ts', 'packages/flashwright-runner/src/runner-trace-off.ts', 'compatibility/m2/runner-trace-off/trace-off.spec.cjs', 'compatibility/m2/runner-trace-off/reporter.cjs', 'compatibility/m2/runner-trace-off/playwright.config.cjs', 'tools/run-runner-trace-off-tests.mjs']) implementation[path] = hash(await readFile(path));
const output = JSON.stringify({
  referenceVersion: '1.60.0', distribution, distributionSha256: hash(source), methods, implementation,
  sources: ['https://github.com/microsoft/playwright/blob/v1.60.0/packages/playwright/src/worker/testTracing.ts', 'https://github.com/microsoft/playwright/blob/v1.60.0/packages/playwright/src/worker/fixtureRunner.ts', 'https://github.com/microsoft/playwright/blob/v1.60.0/packages/playwright/src/worker/workerMain.ts'],
  relationship: 'Independent per-attempt adaptation of the pinned TestTracing instance. The first zero-dependency worker and all-hooks test fixtures disable unused append methods and clear the internal prefix when traceOptions is undefined. Reporter steps, attachments, errors and stdio retain their upstream owners. No global prototype or module-resolution mutation.',
  exclusions: ['Automatic enabled tracing remains unsupported.', 'Manual browser-context tracing is independent.', 'No performance or release claim.'],
  license: 'Apache-2.0', licensePath: 'compatibility/upstream/LICENSE.playwright', noticePath: 'compatibility/upstream/NOTICE.playwright',
}, null, 2) + '\n';
const path = 'compatibility/upstream/runner-trace-off-provenance.json';
if (process.argv.includes('--check')) assert.equal(await readFile(path, 'utf8'), output, 'Runner disabled-trace provenance differs');
else await writeFile(path, output);
console.log('Verified pinned disabled runner-trace provenance.');
