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
    if (name === 'waitForNavigation' && contents.includes('navigatedEvent')) snippets.set('frame.waitForNavigation', contents);
    if (name === '_setupNavigationWaiter') snippets.set('frame.setupNavigationWaiter', contents);
    if (name === 'waitForURL' && contents.includes('urlMatches')) snippets.set('frame.waitForURL', contents);
    if (name === 'waitForRequest' && contents.includes('urlOrPredicate')) snippets.set('page.waitForRequest', contents);
    if (name === 'waitForResponse' && contents.includes('urlOrPredicate')) snippets.set('page.waitForResponse', contents);
  }
  if (ts.isFunctionDeclaration(node) && node.name?.text === 'urlMatches') snippets.set('urlMatches', node.getText(parsed));
  if (ts.isBinaryExpression(node) && node.left.getText(parsed) === 'isURLPattern' && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) snippets.set('isURLPattern', node.getText(parsed));
  ts.forEachChild(node, visit);
}
visit(parsed);
const selected = ['frame.waitForNavigation', 'frame.setupNavigationWaiter', 'frame.waitForURL', 'page.waitForRequest', 'page.waitForResponse', 'urlMatches', 'isURLPattern'];
for (const name of selected) assert.ok(snippets.has(name), `Pinned navigation waiter contract missing ${name}`);
const declarations = await readFile('node_modules/playwright-core/types/types.d.ts', 'utf8');
const patternDeclaration = declarations.split('\n').find(line => line.startsWith('type URLPattern ='));
assert.ok(patternDeclaration);
const extract = selected.map(name => `// ${name}\n${snippets.get(name)}`).join('\n\n') + `\n\n// Native URLPattern declaration\n${patternDeclaration}\n`;
const hash = value => createHash('sha256').update(value).digest('hex');
const implementation = {};
for (const path of ['crates/flashwright-engine/src/navigation_waits.rs', 'crates/flashwright-engine/src/history_navigation.rs', 'crates/flashwright-engine/src/page_state.rs', 'packages/flashwright-core/src/navigation-waiter.ts', 'packages/flashwright-core/src/waits.ts', 'packages/flashwright-core/src/client.ts', 'packages/flashwright-core/src/index.ts']) implementation[path] = hash(await readFile(path));
const outputs = {
  'compatibility/upstream/navigation-waits.source.txt': extract,
  'compatibility/upstream/navigation-waits-provenance.json': JSON.stringify({
    referenceVersion: '1.60.0', sources: ['https://github.com/microsoft/playwright/blob/v1.60.0/packages/playwright-core/src/client/frame.ts', 'https://github.com/microsoft/playwright/blob/v1.60.0/packages/playwright-core/src/client/page.ts', 'https://github.com/microsoft/playwright/blob/v1.60.0/packages/playwright-core/src/utils/isomorphic/urlMatch.ts'], distributionPath, distributionSha256: hash(source),
    retainedExtract: 'compatibility/upstream/navigation-waits.source.txt', extractSha256: hash(extract), implementation,
    relationship: 'Independent native navigation journal and host watermark preserve the pinned host-observed boundary, URL filtering, unconditional navigation failure, nullable response and one navigation deadline. Native URLPattern recognition and conditional declaration adapt the pinned helper; existing string/glob code retains its own provenance.',
    changes: ['Private immutable navigation events advance the host watermark before public callbacks; page allocation metadata supplies its initial value.', 'Acceptance-order capture validates the supplied host cursor; event selection and lifecycle completion share bounded native history without persistent waiter allocation.', 'Uniform client readiness promise stages preserve request invocation order for finite/unbounded timeouts, including handshake resolution.', 'Page closure and the same deadline cover native waits and host callback promises. User callback errors retain their identity.', 'URLPattern is supported only through the runtime native global for navigation/URL/frame matching. waitForRequest and waitForResponse preserve their narrower pinned string/RegExp/request-or-response predicate contracts; request observation returns the original object before response completion.'],
    license: 'Apache-2.0', licensePath: 'compatibility/upstream/LICENSE.playwright', noticePath: 'compatibility/upstream/NOTICE.playwright',
  }, null, 2) + '\n',
};
for (const [path, contents] of Object.entries(outputs)) {
  if (process.argv.includes('--check')) assert.equal(await readFile(path, 'utf8'), contents, `Navigation-wait provenance differs: ${path}`);
  else await writeFile(path, contents);
}
console.log('Verified pinned navigation-wait provenance.');
