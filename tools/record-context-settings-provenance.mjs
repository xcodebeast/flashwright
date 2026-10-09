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
    if (name === 'emulatedMedia' && contents.includes('contextOptions.colorScheme')) snippets.set('page.mediaDefaults', contents);
    if (name === '_updateEmulateMedia' && contents.includes('Emulation.setEmulatedMedia')) snippets.set('chromium.mediaDefaults', contents);
  }
  if (ts.isIfStatement(node)) {
    const condition = node.expression.getText(parsed);
    const contents = node.getText(parsed);
    if (condition === 'options2.ignoreHTTPSErrors || options2.internalIgnoreHTTPSErrors'
      && contents.includes('Security.setIgnoreCertificateErrors')) snippets.set('chromium.ignoreHTTPSErrors', contents);
    if (condition === 'options2.javaScriptEnabled === false'
      && contents.includes('Emulation.setScriptExecutionDisabled')) snippets.set('chromium.javaScriptEnabled', contents);
  }
  ts.forEachChild(node, visit);
}
visit(parsed);
const selected = ['chromium.ignoreHTTPSErrors', 'chromium.javaScriptEnabled', 'page.mediaDefaults', 'chromium.mediaDefaults'];
for (const name of selected) assert.ok(snippets.has(name), `Pinned context policy missing ${name}`);
const extract = selected.map(name => `// ${name}\n${snippets.get(name)}`).join('\n\n') + '\n';
const hash = value => createHash('sha256').update(value).digest('hex');
const implementation = {};
for (const path of ['crates/flashwright-engine/src/context_settings.rs', 'crates/flashwright-engine/src/lib.rs',
  'packages/flashwright-core/src/context-settings.ts', 'packages/flashwright-core/src/index.ts', 'packages/flashwright-runner/src/index.ts']) {
  implementation[path] = hash(await readFile(path));
}
const outputs = {
  'compatibility/upstream/context-settings.source.txt': extract,
  'compatibility/upstream/context-settings-provenance.json': JSON.stringify({
    referenceVersion: '1.60.0', sources: ['https://github.com/microsoft/playwright/blob/v1.60.0/packages/playwright-core/src/server/chromium/crPage.ts',
      'https://github.com/microsoft/playwright/blob/v1.60.0/packages/playwright-core/src/server/page.ts',
      'https://github.com/microsoft/playwright/blob/v1.60.0/packages/playwright/src/index.ts'],
    distributionPath, distributionSha256: hash(source), retainedExtract: 'compatibility/upstream/context-settings.source.txt',
    extractSha256: hash(extract), implementation,
    relationship: 'Independent native context policy follows the pinned opt-in certificate bypass, opt-out JavaScript execution and explicit light/normal-accessibility media defaults before public page use. Private storage pages retain independent execution settings.',
    changes: ['Validate booleans at both host and native allocation boundaries.', 'Apply sequential owned initialization commands under the existing cancellation and allocation cleanup contract.',
      'Forward runner settings through the canonical context-default boundary; explicit undefined/false/true retains precedence.', 'Explicit slowMo:0 selects ordinary execution; nonzero values remain typed unsupported.',
      'Set default media features before user init scripts so operating-system dark and higher-contrast preferences do not change application CSS. Explicit media overrides remain unsupported.'],
    license: 'Apache-2.0', licensePath: 'compatibility/upstream/LICENSE.playwright', noticePath: 'compatibility/upstream/NOTICE.playwright',
  }, null, 2) + '\n',
};
for (const [path, contents] of Object.entries(outputs)) {
  if (process.argv.includes('--check')) assert.equal(await readFile(path, 'utf8'), contents, `Context settings provenance differs: ${path}`);
  else await writeFile(path, contents);
}
console.log('Verified pinned context-settings provenance.');
