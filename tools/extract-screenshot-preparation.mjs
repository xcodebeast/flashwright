import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import ts from 'typescript';

const distributionPath = 'node_modules/playwright-core/lib/coreBundle.js';
const distribution = await readFile(distributionPath, 'utf8');
assert.equal(JSON.parse(await readFile('node_modules/playwright-core/package.json', 'utf8')).version, '1.60.0');
const parsed = ts.createSourceFile(distributionPath, distribution, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const declaration = parsed.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'inPagePrepareForScreenshots');
assert.ok(declaration, 'Pinned screenshot preparation must exist');
const retainedSource = declaration.getText(parsed) + '\n';
assert.equal(retainedSource.split('window.__pwCleanupScreenshot = () => {').length, 2);
const generated = '// Adapted from Playwright 1.60.0, Apache-2.0; see compatibility/upstream/screenshot-provenance.json.\n' + retainedSource
  .replace('    return;', '    return () => {};')
  .replace('window.__pwCleanupScreenshot = () => {', 'return () => {')
  .replace('    delete window.__pwCleanupScreenshot;\n', '');
const destination = 'packages/resident-runtime/screenshot-preparation.js';
const retainedExtract = 'compatibility/upstream/screenshot-preparation.source.js';
const hash = value => createHash('sha256').update(value).digest('hex');
const outputs = {
  [destination]: generated,
  [retainedExtract]: retainedSource,
  'compatibility/upstream/screenshot-provenance.json': JSON.stringify({
    referenceVersion: '1.60.0', referenceFiles: ['server/screenshotter.ts', 'server/helper.ts', 'server/chromium/crPage.ts', 'client/page.ts', 'client/elementHandle.ts'], source: 'https://github.com/microsoft/playwright/blob/v1.60.0/packages/playwright-core/src/server/screenshotter.ts',
    distributionPath, distributionSha256: hash(distribution), retainedExtract, extractSha256: hash(retainedSource), destination, generatedSha256: hash(generated),
    changes: ['Match the reference page window bounds, screen metrics and desktop/headless insets during page creation.', 'Port clipping, viewport scale conversion and JPEG defaults into Rust with explicit pixel limits and owned cancellation cleanup.', 'Return the restoration closure instead of publishing it on window, allowing an opaque CDP object to retain the exact prepared document.', 'Return an empty restoration closure when no preparation is needed. Chromium does not request animation stylesheet synchronization.'],
    license: 'Apache-2.0', licensePath: 'compatibility/upstream/LICENSE.playwright', noticePath: 'compatibility/upstream/NOTICE.playwright',
  }, null, 2) + '\n',
};
for (const [path, contents] of Object.entries(outputs)) {
  if (process.argv.includes('--check')) assert.equal(await readFile(path, 'utf8'), contents, `Pinned screenshot preparation differs: ${path}`);
  else await writeFile(path, contents);
}
console.log('Verified pinned screenshot caret, style and animation preparation.');
