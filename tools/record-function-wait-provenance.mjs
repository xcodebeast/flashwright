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
    if (name === 'waitForFunctionExpression' && contents.includes('this.retryWithProgressAndTimeouts')) snippets.set('server.frame.waitForFunctionExpression', contents);
    if (name === 'retryWithProgressAndTimeouts' && contents.includes('this._detachedScope')) snippets.set('server.frame.retryWithProgressAndTimeouts', contents);
    if (name === 'isNonRetriableError' && contents.includes('isJavaScriptErrorInEvaluate')) snippets.set('server.frame.isNonRetriableError', contents);
    if (name === 'waitForFunction' && contents.includes('this._channel.waitForFunction')) snippets.set('client.frame.waitForFunction', contents);
    if (name === 'waitForFunction' && contents.includes('this._mainFrame.waitForFunction')) snippets.set('client.page.waitForFunction', contents);
  }
  if (ts.isFunctionDeclaration(node) && node.name?.text === 'normalizeEvaluationExpression') snippets.set('evaluation.normalizeEvaluationExpression', node.getText(parsed));
  ts.forEachChild(node, visit);
}
visit(parsed);
const injectedPath = 'packages/resident-runtime/playwright-injected.js';
const injected = await readFile(injectedPath, 'utf8');
const injectedParsed = ts.createSourceFile(injectedPath, injected, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
function visitBuiltins(node) {
  if (ts.isConstructorDeclaration(node) && node.getText(injectedParsed).includes('global.__pwClock.builtins')) snippets.set('injected.utilityScript.builtins', node.getText(injectedParsed));
  ts.forEachChild(node, visitBuiltins);
}
visitBuiltins(injectedParsed);
const names = ['server.frame.waitForFunctionExpression', 'server.frame.retryWithProgressAndTimeouts', 'server.frame.isNonRetriableError',
  'client.frame.waitForFunction', 'client.page.waitForFunction', 'evaluation.normalizeEvaluationExpression', 'injected.utilityScript.builtins'];
for (const name of names) assert.ok(snippets.has(name), `Pinned predicate contract is missing ${name}`);
const extract = names.map(name => `// ${name}\n${snippets.get(name)}`).join('\n\n') + '\n';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const implementation = {};
for (const path of ['crates/flashwright-engine/src/wait_for_function.rs', 'crates/flashwright-engine/src/evaluation.rs',
  'crates/flashwright-engine/src/handles.rs', 'crates/flashwright-engine/src/handle_allocation.rs', 'crates/flashwright-engine/src/publication.rs',
  'crates/flashwright-engine/src/recording/phases.rs',
  'packages/resident-runtime/function-wait.cjs', 'packages/flashwright-core/src/function-wait.ts', 'packages/flashwright-core/src/frame.ts',
  'packages/flashwright-core/src/index.ts', 'packages/flashwright-core/src/client.ts']) implementation[path] = hash(await readFile(path));
const outputs = {
  'compatibility/upstream/function-wait.source.txt': extract,
  'compatibility/upstream/function-wait-provenance.json': JSON.stringify({
    referenceVersion: '1.60.0', distributionPath, distributionSha256: hash(source), injectedPath, injectedSha256: hash(injected),
    sources: ['https://github.com/microsoft/playwright/blob/v1.60.0/packages/playwright-core/src/client/frame.ts',
      'https://github.com/microsoft/playwright/blob/v1.60.0/packages/playwright-core/src/client/page.ts',
      'https://github.com/microsoft/playwright/blob/v1.60.0/packages/playwright-core/src/server/frames.ts',
      'https://github.com/microsoft/playwright/blob/v1.60.0/packages/playwright-core/src/server/javascript.ts',
      'https://github.com/microsoft/playwright/blob/v1.60.0/packages/injected/src/utilityScript.ts'],
    retainedExtract: 'compatibility/upstream/function-wait.source.txt', extractSha256: hash(extract), implementation,
    relationship: 'Independent native operation and private renderer controller follow the pinned requested-predicate, builtin scheduling, source normalization and handle-return contract.',
    changes: ['Keep host deadlines and cancellation authoritative across original-world retries.',
      'Allocate a private controller without executing the predicate, then start caller execution through a separately owned reply.',
      'Preserve one-shot truthy Promise assimilation, including a resolved falsy handle, with an independently abortable outward result.',
      'Cancel exact scheduled callbacks and retain original-session replies, groups, arguments and handle admission through deferred cleanup.',
      'Bound source and diagnostic envelopes and use transactional public handle publication.',
      'Do not read application performance clocks, use assertion caches or terminate unrelated application JavaScript.'],
    license: 'Apache-2.0', licensePath: 'compatibility/upstream/LICENSE.playwright', noticePath: 'compatibility/upstream/NOTICE.playwright',
  }, null, 2) + '\n',
};
for (const [path, contents] of Object.entries(outputs)) {
  if (process.argv.includes('--check')) assert.equal(await readFile(path, 'utf8'), contents, `Predicate provenance differs: ${path}`);
  else await writeFile(path, contents);
}
console.log('Verified pinned function-wait provenance.');
