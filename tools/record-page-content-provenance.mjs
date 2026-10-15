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
    if (name === 'setContent' && contents.includes('document.open()') && contents.includes('_consoleMessageTags')) snippets.set('frame.setContent', contents);
    if (name === '_onClearLifecycle' && contents.includes('_inflightRequests')) snippets.set('frame.clearLifecycle', contents);
    if (name === 'interceptConsoleMessage' && contents.includes('_consoleMessageTags')) snippets.set('frameManager.interceptConsoleMessage', contents);
  }
  ts.forEachChild(node, visit);
}
visit(parsed);
const selected = ['frame.setContent', 'frame.clearLifecycle', 'frameManager.interceptConsoleMessage'];
for (const name of selected) assert(snippets.has(name), `Pinned content contract missing ${name}`);
const extract = selected.map(name => `// ${name}\n${snippets.get(name)}`).join('\n\n') + '\n';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const implementation = {};
for (const path of ['crates/flashwright-engine/src/content.rs', 'crates/flashwright-engine/src/events.rs', 'crates/flashwright-engine/src/page_state.rs', 'crates/flashwright-engine/src/recording/phases.rs', 'packages/flashwright-core/src/index.ts', 'packages/resident-runtime/condition-registry.js', 'packages/resident-runtime/locator-runtime.js']) implementation[path] = hash(await readFile(path));
const outputs = {
  'compatibility/upstream/page-content.source.txt': extract,
  'compatibility/upstream/page-content-provenance.json': JSON.stringify({
    referenceVersion: '1.60.0', sources: ['https://github.com/microsoft/playwright/blob/v1.60.0/packages/playwright-core/src/server/frames.ts'],
    distributionPath, distributionSha256: hash(source), retainedExtract: 'compatibility/upstream/page-content.source.txt', extractSha256: hash(extract), implementation,
    relationship: 'Independent Rust implementation follows the original-world console boundary and document.open/write/close lifecycle contract; the retained source is a compatibility reference.',
    changes: ['Bound exact UTF-16LE HTML to 1000000 code units and transport it as compact base64.', 'Bind private markers to their original isolated session and unique execution context, capped at 128 pending replacements per page.', 'Reattach resident condition observation while preserving pending checks and original deadlines.', 'Withdraw cancelled writes before dispatch or retire their original page when browser completion remains uncertain.'],
    license: 'Apache-2.0', licensePath: 'compatibility/upstream/LICENSE.playwright', noticePath: 'compatibility/upstream/NOTICE.playwright',
  }, null, 2) + '\n',
};
for (const [path, contents] of Object.entries(outputs)) {
  if (process.argv.includes('--check')) assert.equal(await readFile(path, 'utf8'), contents, `Content provenance differs: ${path}`);
  else await writeFile(path, contents);
}
console.log('Verified pinned content-replacement provenance.');
