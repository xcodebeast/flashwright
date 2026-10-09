import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import ts from 'typescript';

const distributionPath = 'node_modules/playwright-core/lib/coreBundle.js';
const source = await readFile(distributionPath, 'utf8');
assert.equal(JSON.parse(await readFile('node_modules/playwright-core/package.json', 'utf8')).version, '1.60.0');
const parsed = ts.createSourceFile(distributionPath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const snippets = new Map();
function retain(name, contents) {
  assert.equal(snippets.has(name), false, `Ambiguous pinned dialog source ${name}`);
  snippets.set(name, contents);
}
function visit(node) {
  if (ts.isClassExpression(node) && ts.isBinaryExpression(node.parent)) {
    const name = node.parent.left.getText(parsed);
    const retained = { Dialog: 'server.Dialog', Dialog2: 'client.Dialog', DialogDispatcher: 'dispatchers.Dialog', DialogManager: 'server.DialogManager' }[name];
    if (retained) retain(retained, node.getText(parsed));
  }
  if (ts.isMethodDeclaration(node) && node.name.getText(parsed) === '_onDialog' && node.getText(parsed).includes('Page.handleJavaScriptDialog')) retain('chromium.dialog', node.getText(parsed));
  if (ts.isArrowFunction(node) && node.getText(parsed).includes('const dialogObject = Dialog2.from(dialog);') && node.getText(parsed).includes('this.emit(Events.BrowserContext.Dialog')) retain('client.delivery', node.getText(parsed));
  ts.forEachChild(node, visit);
}
visit(parsed);
const names = ['server.Dialog', 'server.DialogManager', 'client.Dialog', 'dispatchers.Dialog', 'chromium.dialog', 'client.delivery'];
for (const name of names) assert(snippets.has(name), `Missing pinned dialog source ${name}`);
const extract = names.map(name => `// ${name}\n${snippets.get(name)}`).join('\n\n') + '\n';
const hash = value => createHash('sha256').update(value).digest('hex');
const implementation = {};
for (const path of [
  'crates/flashwright-engine/src/dialogs.rs', 'crates/flashwright-engine/src/dialogs/state.rs',
  'crates/flashwright-engine/src/dialogs/handling.rs', 'crates/flashwright-engine/src/dialogs/control.rs',
  'crates/flashwright-engine/src/dialogs/events.rs', 'crates/flashwright-engine/src/events.rs',
  'crates/flashwright-protocol/src/admission.rs', 'crates/flashwright-driver/src/main.rs',
  'crates/flashwright-browser/src/connection.rs', 'packages/flashwright-core/src/operation-admission.ts',
  'packages/flashwright-core/src/event-control-lane.ts', 'packages/flashwright-core/src/client.ts',
  'packages/flashwright-core/src/trace-admission.ts', 'packages/flashwright-core/src/attachments.ts',
  'packages/flashwright-core/src/dialog.ts', 'packages/flashwright-core/src/index.ts',
  'packages/flashwright-core/src/trace-hooks.ts', 'packages/flashwright-core/src/tracing.ts',
]) implementation[path] = hash(await readFile(path));
const outputs = {
  'compatibility/upstream/dialog.source.txt': extract,
  'compatibility/upstream/dialog-provenance.json': JSON.stringify({
    referenceVersion: '1.60.0', distributionPath, distributionSha256: hash(source),
    retainedExtract: 'compatibility/upstream/dialog.source.txt', extractSha256: hash(extract), implementation,
    sources: ['client/dialog.ts', 'client/browserContext.ts', 'server/dialog.ts', 'server/dispatchers/dialogDispatcher.ts', 'server/chromium/crPage.ts'].map(path => `https://github.com/microsoft/playwright/blob/v1.60.0/packages/playwright-core/src/${path}`),
    relationship: 'Independent native occurrence ownership and bounded recovery transport follow the pinned public metadata, null-page publication, handling consumption and context-before-page delivery contracts. Generic EventEmitter types retain console-provenance.json attribution.',
    changes: [
      'Bind each occurrence to original page, frame and CDP session; retain command and metadata admission until original acknowledgement or terminal cleanup.',
      'Reserve recovery capacity inside negotiated totals and order subscription controls without awaiting renderer work or unrelated handling replies.',
      'Carry exact received raw JSON through native transport; preserve outgoing UTF-16 prompt escapes without inventing browser normalization.',
      'Retain a null public page snapshot for context delivery before page publication.',
      'Reject metadata exceeding1MiB with original error and bounded owned cleanup; the pinned browser truncates message but preserves large defaultPrompt values.',
      'Reject Page.close runBeforeUnload:true before effects; navigation beforeunload dialogs have separate coverage.',
      'Cross-process child dialog coverage requires the actual original parent-session opening, not general child-frame API support.',
      'Dialog tracing records metadata with the original internal page identifier even when the public page snapshot is null. It omits filmstrip activity, diagnostic fences and snapshot requests on the handling critical path; native metadata retains context and chunk generation without snapshot recording/call fields.',
      'Queue optional trace work within independent bounds; native-only snapshot/network collection shares the negotiated recovery total with public recovery priority. Busy attachment admission transfers no bytes and retries within the original deadline, so retained snapshot pressure cannot occupy every path to modal handling.',
    ],
    verification: ['compatibility/m1/test_dialogs.py', 'compatibility/m2/dialog-fixture.mjs', 'compatibility/m2/dialog-types.ts',
      'tools/test-dialog-host.mjs', 'tools/test-dialog-control-lane.mjs', 'tools/probe-dialog-public-admission.mjs',
      'tools/test-dialog-native-public.mjs', 'tools/run-dialog-tests.mjs', 'tools/probe-dialog-late-reply.mjs', 'tools/test-packed-dialogs.mjs',
      'tools/test-dialog-trace-hooks.mjs', 'tools/test-trace-admission.mjs', 'tools/test-trace-capacity.mjs'],
    license: 'Apache-2.0', licensePath: 'compatibility/upstream/LICENSE.playwright', noticePath: 'compatibility/upstream/NOTICE.playwright',
  }, null, 2) + '\n',
};
for (const [path, contents] of Object.entries(outputs)) {
  if (process.argv.includes('--check')) assert.equal(await readFile(path, 'utf8'), contents, `Dialog provenance differs: ${path}`);
  else await writeFile(path, contents);
}
console.log('Verified pinned dialog provenance.');
