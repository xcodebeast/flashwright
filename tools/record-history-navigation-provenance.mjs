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
    if (['reload', 'goBack', 'goForward'].includes(name) && contents.includes('raceNavigationAction')) snippets.set(`server.${name}`, contents);
    if (['reload', 'goBack', 'goForward'].includes(name) && contents.includes('Response3.fromNullable')) snippets.set(`client.${name}`, contents);
    if (name === '_go' && contents.includes('Page.getNavigationHistory')) snippets.set('chromium.history', contents);
    if (name === 'reload' && contents.includes('this._mainFrameSession._client.send("Page.reload")')) snippets.set('chromium.reload', contents);
    if (name === 'waitForNavigation' && contents.includes('requiresNewDocument')) snippets.set('frame.waitForNavigation', contents);
  }
  ts.forEachChild(node, visit);
}
visit(parsed);
const selected = ['server.reload', 'server.goBack', 'server.goForward', 'chromium.reload', 'chromium.history', 'client.reload', 'client.goBack', 'client.goForward', 'frame.waitForNavigation'];
for (const name of selected) assert.ok(snippets.has(name), `Pinned navigation contract missing ${name}`);
const extract = selected.map(name => `// ${name}\n${snippets.get(name)}`).join('\n\n') + '\n';
const hash = value => createHash('sha256').update(value).digest('hex');
const implementation = {};
for (const path of ['crates/flashwright-engine/src/history_navigation.rs', 'crates/flashwright-engine/src/page_state.rs', 'packages/flashwright-core/src/index.ts']) implementation[path] = hash(await readFile(path));
const outputs = {
  'compatibility/upstream/history-navigation.source.txt': extract,
  'compatibility/upstream/history-navigation-provenance.json': JSON.stringify({
    referenceVersion: '1.60.0', sources: ['https://github.com/microsoft/playwright/blob/v1.60.0/packages/playwright-core/src/server/page.ts', 'https://github.com/microsoft/playwright/blob/v1.60.0/packages/playwright-core/src/server/chromium/crPage.ts', 'https://github.com/microsoft/playwright/blob/v1.60.0/packages/playwright-core/src/server/frames.ts', 'https://github.com/microsoft/playwright/blob/v1.60.0/packages/playwright-core/src/client/page.ts'], distributionPath, distributionSha256: hash(source),
    retainedExtract: 'compatibility/upstream/history-navigation.source.txt', extractSha256: hash(extract), implementation,
    relationship: 'Independent native implementation follows the pinned reload/new-document and history/first-navigation distinction, missing-entry null, nullable response and navigation timeout/lifecycle options.',
    changes: ['Bound the main-frame navigation journal to 1024 events and fail explicitly if an active observer misses retained history.', 'Dispatch each action once; cancellation before a history query completes prevents its later traversal.', 'Keep existing owned-page and child-frame lifecycle limits; no new routing, popup or cross-process support.'],
    license: 'Apache-2.0', licensePath: 'compatibility/upstream/LICENSE.playwright', noticePath: 'compatibility/upstream/NOTICE.playwright',
  }, null, 2) + '\n',
};
for (const [path, contents] of Object.entries(outputs)) {
  if (process.argv.includes('--check')) assert.equal(await readFile(path, 'utf8'), contents, `History navigation provenance differs: ${path}`);
  else await writeFile(path, contents);
}
console.log('Verified pinned history-navigation provenance.');
