import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import ts from 'typescript';

assert.equal(JSON.parse(await readFile('node_modules/playwright/package.json', 'utf8')).version, '1.60.0');
const hash = contents => createHash('sha256').update(contents).digest('hex');
const distributions = {};
const snippets = new Map();
for (const path of ['node_modules/playwright/lib/index.js', 'node_modules/playwright/lib/worker/workerProcessEntry.js', 'node_modules/playwright-core/lib/coreBundle.js']) {
  const source = await readFile(path, 'utf8');
  distributions[path] = hash(source);
  const parsed = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  function visit(node) {
    if (ts.isClassDeclaration(node) && node.name?.text === 'SnapshotRecorder') snippets.set('SnapshotRecorder', node.getText(parsed));
    if (ts.isClassDeclaration(node) && node.name?.text === 'ArtifactsRecorder') {
      for (const member of node.members) {
        const name = ts.isConstructorDeclaration(member) ? 'constructor' : member.name?.getText(parsed);
        if (['constructor', 'willStartTest', 'willCloseBrowserContext', 'didFinishTestFunction', 'didFinishTest'].includes(name)) snippets.set(`ArtifactsRecorder.${name}`, member.getText(parsed));
      }
    }
    if (ts.isMethodDeclaration(node)) {
      const name = node.name.getText(parsed);
      if (name === '_isFailure' && node.getText(parsed).includes('expectedStatus')) snippets.set('TestInfo.isFailure', node.getText(parsed));
      if (name === 'close' && node.getText(parsed).includes('runBeforeCloseBrowserContext')) snippets.set('BrowserContext.close', node.getText(parsed));
      if (name === 'close' && node.getText(parsed).includes('this._ownedContext.close')) snippets.set('Page.close', node.getText(parsed));
      if (name === 'close' && node.getText(parsed).includes('this._shouldCloseConnectionOnClose')) snippets.set('Browser.close', node.getText(parsed));
    }
    ts.forEachChild(node, visit);
  }
  visit(parsed);
}
const selected = ['SnapshotRecorder', 'ArtifactsRecorder.constructor', 'ArtifactsRecorder.willStartTest', 'ArtifactsRecorder.willCloseBrowserContext', 'ArtifactsRecorder.didFinishTestFunction', 'ArtifactsRecorder.didFinishTest', 'TestInfo.isFailure', 'BrowserContext.close', 'Page.close', 'Browser.close'];
for (const name of selected) assert.ok(snippets.has(name), `Missing pinned screenshot contract ${name}`);
const extract = selected.map(name => `// ${name}\n${snippets.get(name)}`).join('\n\n') + '\n';
const implementation = {};
for (const path of ['packages/flashwright-core/src/index.ts', 'packages/flashwright-core/src/runner-integration.ts', 'packages/flashwright-core/src/runner-lifecycle.ts', 'packages/flashwright-core/src/public-browsers.ts', 'packages/flashwright-runner/src/index.ts', 'packages/flashwright-runner/src/screenshot-policy.ts', 'packages/flashwright-runner/src/screenshot-recorder.ts']) implementation[path] = hash(await readFile(path));
const outputs = {
  'compatibility/upstream/runner-screenshots.source.txt': extract,
  'compatibility/upstream/runner-screenshots-provenance.json': JSON.stringify({
    referenceVersion: '1.60.0', distributions,
    sources: ['https://github.com/microsoft/playwright/blob/v1.60.0/packages/playwright/src/index.ts', 'https://github.com/microsoft/playwright/blob/v1.60.0/packages/playwright/src/worker/testInfo.ts', 'https://github.com/microsoft/playwright/blob/v1.60.0/packages/playwright-core/src/client/browserContext.ts', 'https://github.com/microsoft/playwright/blob/v1.60.0/packages/playwright-core/src/client/page.ts', 'https://github.com/microsoft/playwright/blob/v1.60.0/packages/playwright-core/src/client/browser.ts'],
    retainedExtract: 'compatibility/upstream/runner-screenshots.source.txt', extractSha256: hash(extract), implementation,
    relationship: 'Independent native runner screenshot lifecycle follows pinned policy, outcome, retry, pre-context-close, deduplication, PNG naming and attachment behavior. Native public-context observation replaces upstream browser instrumentation. A canonical weak public-browser registry discovers contexts created before worker setup; observation is installed before enumeration and deduplicates context identities. Disconnect and finalization remove registry entries. Private prepared/storage contexts are excluded.',
    policies: ['off', 'on', 'only-on-failure', 'on-first-failure'], options: ['fullPage', 'omitBackground'],
    limits: ['One five-second budget per capture batch, including recorder queue time; at most four captures run concurrently per scope.', 'At most 1024 attempted screenshots and 512 MiB retained image bytes per recording scope; overflows become explicit capture diagnostics.', 'Screenshot errors preserve the original outcome and retain up to 16 original error stacks, each bounded to 4096 characters, in one screenshot-error attachment with an additional-error count.', 'Context-close temporary files are atomically captured, conditionally retained, then removed. Ordinary individual page close and direct browser close do not gain an extra capture hook.'],
    exclusions: ['Trace and video policies remain explicitly unsupported.', 'Screenshot assertions, masks and broader page screenshot capabilities retain their existing boundaries.', 'Screenshot policy support alone does not establish original-config public-corpus completion.'],
    license: 'Apache-2.0', licensePath: 'compatibility/upstream/LICENSE.playwright', noticePath: 'compatibility/upstream/NOTICE.playwright',
  }, null, 2) + '\n',
};
for (const [path, contents] of Object.entries(outputs)) {
  if (process.argv.includes('--check')) assert.equal(await readFile(path, 'utf8'), contents, `Runner screenshot provenance differs: ${path}`);
  else await writeFile(path, contents);
}
console.log('Verified pinned runner screenshot provenance.');
