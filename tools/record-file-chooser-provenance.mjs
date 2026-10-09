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
  if (ts.isClassExpression(node)) {
    const contents = node.getText(parsed);
    if (contents.includes('this._elementHandle.setInputFiles') && node.members.some(member => ts.isMethodDeclaration(member) && member.name.getText(parsed) === 'isMultiple')) snippets.set('client.FileChooser', contents);
  }
  if (ts.isMethodDeclaration(node)) {
    const name = node.name.getText(parsed);
    const contents = node.getText(parsed);
    if (name === '_onFileChooserOpened' && contents.includes('handle.evaluate')) snippets.set('page.publishChooser', contents);
    if (name === '_onFileChooserOpened' && contents.includes('_adoptBackendNodeId')) snippets.set('chromium.adoptChooser', contents);
    if (name === '_updateFileChooserInterception' && contents.includes('Page.setInterceptFileChooserDialog')) snippets.set('chromium.interception', contents);
    if (name === '_onConsoleAPI' && contents.includes('this._contextIdToContext')) snippets.set('chromium.consoleWorlds', contents);
  }
  ts.forEachChild(node, visit);
}
visit(parsed);
const names = ['client.FileChooser', 'page.publishChooser', 'chromium.adoptChooser', 'chromium.interception', 'chromium.consoleWorlds'];
for (const name of names) assert(snippets.has(name), `Missing pinned chooser source ${name}`);
const extract = names.map(name => `// ${name}\n${snippets.get(name)}`).join('\n\n') + '\n';
const hash = value => createHash('sha256').update(value).digest('hex');
const implementation = {};
for (const path of ['crates/flashwright-engine/src/file_chooser.rs', 'crates/flashwright-engine/src/handles.rs', 'crates/flashwright-engine/src/handle_allocation.rs', 'crates/flashwright-engine/src/console.rs',
  'crates/flashwright-engine/src/events.rs', 'crates/flashwright-engine/src/page_state.rs', 'crates/flashwright-engine/src/publication.rs',
  'packages/flashwright-core/src/file-chooser.ts', 'packages/flashwright-core/src/subscribed-events.ts',
  'packages/flashwright-core/src/client.ts', 'packages/flashwright-core/src/index.ts']) implementation[path] = hash(await readFile(path));
const outputs = {
  'compatibility/upstream/file-chooser.source.txt': extract,
  'compatibility/upstream/file-chooser-provenance.json': JSON.stringify({ referenceVersion: '1.60.0', distributionPath, distributionSha256: hash(source),
    retainedExtract: 'compatibility/upstream/file-chooser.source.txt', extractSha256: hash(extract), implementation,
    sources: ['https://github.com/microsoft/playwright/blob/v1.60.0/packages/playwright-core/src/client/fileChooser.ts',
      'https://github.com/microsoft/playwright/blob/v1.60.0/packages/playwright-core/src/server/page.ts',
      'https://github.com/microsoft/playwright/blob/v1.60.0/packages/playwright-core/src/server/chromium/crPage.ts'],
    relationship: 'Independent bounded chooser adoption follows original utility-world identity, actual input multiplicity, listener-driven native interception and FileChooser delegation. Generic EventEmitter types retain console-provenance.json attribution.',
    changes: ['Await interception acknowledgement through a per-page host readiness gate while unrelated pages and closure can progress.',
      'Serial adoption preserves browser event order with16 pending events per page,128 per engine and existing4096 public handle reservations per page.',
      'Listener removal cancels unpublished adoption; S4.n records the measured pinned race difference for removal and later subscription.',
      'Require the receipt main-world identity and listener generation during atomic publication of a utility-world handle.',
      'Unobserved chooser groups share console background release ownership, bounded at4096 queued or pending remote references per page without interrupting later application work.',
      'Utility-world console calls preserve original-context argument handles; out-of-process frames remain unsupported.'],
    verification: ['compatibility/m1/chooser-subscription.mjs', 'compatibility/m1/test_file_chooser.py', 'compatibility/m2/file-chooser.mjs',
      'compatibility/m2/runner/file-input-types.ts', 'tools/test-packed-package.mjs', 'tools/run-manual-trace-tests.mjs'],
    license: 'Apache-2.0', licensePath: 'compatibility/upstream/LICENSE.playwright', noticePath: 'compatibility/upstream/NOTICE.playwright',
  }, null, 2) + '\n',
};
for (const [path, contents] of Object.entries(outputs)) {
  if (process.argv.includes('--check')) assert.equal(await readFile(path, 'utf8'), contents, `File chooser provenance differs: ${path}`);
  else await writeFile(path, contents);
}
console.log('Verified pinned file chooser provenance.');
