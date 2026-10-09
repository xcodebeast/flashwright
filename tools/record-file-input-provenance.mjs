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
  if (ts.isFunctionDeclaration(node) && node.name) {
    const name = node.name.getText(parsed);
    if (['convertInputFiles', 'resolvePathsAndDirectoryForInputFiles', 'prepareFilesForUpload'].includes(name)) snippets.set(name, node.getText(parsed));
  }
  if (ts.isMethodDeclaration(node)) {
    const name = node.name.getText(parsed);
    const contents = node.getText(parsed);
    if (name === '_setInputFiles' && contents.includes('follow-label')) snippets.set('element.setInputFiles', contents);
    if (name === 'setInputFilePaths' && contents.includes('DOM.setFileInputFiles')) snippets.set('chromium.setInputFilePaths', contents);
  }
  ts.forEachChild(node, visit);
}
visit(parsed);
const names = ['convertInputFiles', 'resolvePathsAndDirectoryForInputFiles', 'prepareFilesForUpload', 'element.setInputFiles', 'chromium.setInputFilePaths'];
for (const name of names) assert(snippets.has(name), `Missing pinned file input source ${name}`);
const extract = names.map(name => `// ${name}\n${snippets.get(name)}`).join('\n\n') + '\n';
const hash = value => createHash('sha256').update(value).digest('hex');
const implementation = {};
for (const path of ['crates/flashwright-engine/src/file_inputs.rs', 'crates/flashwright-protocol/src/attachment.rs',
  'packages/resident-runtime/locator-runtime.js', 'packages/flashwright-core/src/file-inputs.ts', 'packages/flashwright-core/src/file-mime-types.ts',
  'packages/flashwright-core/src/index.ts', 'packages/flashwright-core/src/frame.ts', 'packages/flashwright-core/src/locator.ts', 'packages/flashwright-core/src/handles.ts']) implementation[path] = hash(await readFile(path));
const mimeDistribution = 'node_modules/playwright-core/lib/utilsBundle.js';
const outputs = {
  'compatibility/upstream/file-inputs.source.txt': extract,
  'compatibility/upstream/file-inputs-provenance.json': JSON.stringify({ referenceVersion: '1.60.0', distributionPath, distributionSha256: hash(source),
    retainedExtract: 'compatibility/upstream/file-inputs.source.txt', extractSha256: hash(extract), implementation,
    sources: ['https://github.com/microsoft/playwright/blob/v1.60.0/packages/playwright-core/src/client/elementHandle.ts',
      'https://github.com/microsoft/playwright/blob/v1.60.0/packages/playwright-core/src/server/fileUploadUtils.ts',
      'https://github.com/microsoft/playwright/blob/v1.60.0/packages/playwright-core/src/server/dom.ts',
      'https://github.com/microsoft/playwright/blob/v1.60.0/packages/playwright-core/src/server/chromium/crPage.ts'],
    relationship: 'Independent native file assignment preserves label targeting, individual local paths, File/DataTransfer payload and event contracts. The MIME lookup/database is transformed from the pinned mime distribution. Existing injected selector helpers retain selector-provenance attribution.',
    changes: ['Stream bounded raw payload input and stage renderer bytes in private 256 KiB chunks without enlarging control frames.',
      'Keep one native action deadline and private object-group cleanup without public handle allocations.',
      'Reject non-file inputs explicitly; directory uploads are unsupported and aggregate payload admission is 32 MiB.',
      'Captured elements retain original nodes; only read-only locator resolution retries and uncertain assignments are never replayed.'],
    mime: { distributionPath: mimeDistribution, sha256: hash(await readFile(mimeDistribution)), generator: 'tools/generate-file-mime-types.mjs',
      license: 'MIT', licensePath: 'compatibility/upstream/LICENSE.mime', licenseSha256: hash(await readFile('compatibility/upstream/LICENSE.mime')),
      licenseSource: 'https://github.com/broofa/mime/blob/v3.0.0/LICENSE' },
    verification: ['compatibility/m2/file-inputs.mjs', 'compatibility/m1/test_file_inputs.py', 'compatibility/m2/runner/file-input-types.ts', 'tools/test-packed-package.mjs', 'tools/run-manual-trace-tests.mjs'],
    license: 'Apache-2.0', licensePath: 'compatibility/upstream/LICENSE.playwright', noticePath: 'compatibility/upstream/NOTICE.playwright',
  }, null, 2) + '\n',
};
for (const [path, contents] of Object.entries(outputs)) {
  if (process.argv.includes('--check')) assert.equal(await readFile(path, 'utf8'), contents, `File input provenance differs: ${path}`);
  else await writeFile(path, contents);
}
console.log('Verified pinned file input provenance.');
