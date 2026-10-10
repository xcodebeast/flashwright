import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import ts from 'typescript';

const distributionPath = 'node_modules/playwright-core/lib/coreBundle.js';
const distribution = await readFile(distributionPath, 'utf8');
const packageVersion = JSON.parse(await readFile('node_modules/playwright-core/package.json', 'utf8')).version;
if (packageVersion !== '1.60.0') throw new Error('Selector runtime extraction requires Playwright 1.60.0');
const marker = '// packages/playwright-core/src/generated/injectedScriptSource.ts';
const start = distribution.indexOf(marker);
const end = distribution.indexOf('\n// packages/', start + marker.length);
const sourceFile = ts.createSourceFile('injected-source.js', distribution.slice(start, end), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
let source;
function visit(node) {
  if (ts.isBinaryExpression(node) && node.left.getText(sourceFile) === 'source3' && ts.isStringLiteral(node.right)) source = node.right.text;
  ts.forEachChild(node, visit);
}
visit(sourceFile);
if (!source?.includes('class InjectedScript') && !source?.includes('InjectedScript = class')) throw new Error('Pinned injected source was not found');
const destination = 'packages/resident-runtime/playwright-injected.js';
const check = process.argv.includes('--check');
async function save(path, content) {
  if (check) {
    if (await readFile(path, 'utf8') !== content) throw new Error(`Pinned source differs: ${path}`);
  } else await writeFile(path, content);
}
await save(destination, source);
const escapingStart = distribution.indexOf('function escapeRegexForSelector(');
const escapingEnd = distribution.indexOf('\nfunction trimString(', escapingStart);
const selectorsStart = distribution.indexOf('function getByAttributeTextSelector(');
const selectorsEnd = distribution.indexOf('\nvar init_locatorUtils', selectorsStart);
if ([escapingStart, escapingEnd, selectorsStart, selectorsEnd].some(position => position < 0)) throw new Error('Pinned locator helpers were not found');
const clientHelpers = distribution.slice(escapingStart, escapingEnd) + '\n\n' + distribution.slice(selectorsStart, selectorsEnd) + '\n';
const retainedHelpers = 'compatibility/upstream/locator-helpers.source.js';
await save(retainedHelpers, clientHelpers);
const hash = content => createHash('sha256').update(content).digest('hex');
await save('compatibility/upstream/selector-provenance.json', JSON.stringify({
  referenceVersion: packageVersion,
  source: 'https://github.com/microsoft/playwright/tree/v1.60.0/packages/injected/src',
  distributionPath, distributionSha256: hash(distribution),
  destination, sourceSha256: hash(source),
  extraction: 'Decode the generated injectedScriptSource.ts string literal using the TypeScript parser. The decoded bundle is unchanged.',
  changes: [],
  clientHelpers: {
    source: 'https://github.com/microsoft/playwright/tree/v1.60.0/packages/isomorphic',
    retainedExtract: retainedHelpers, extractSha256: hash(clientHelpers),
    implementation: 'packages/flashwright-core/src/locator.ts',
    changes: ['Adapted text, attribute and regular-expression escaping and selector composition into typed scope methods', 'Expanded local names and added development option validation', 'Read the v regular-expression flag using flags.includes for ES2022 declaration consumers'],
  },
  pointerAdaptations: {
    source: 'https://github.com/microsoft/playwright/tree/v1.60.0/packages/playwright-core/src/server',
    referenceFiles: ['dom.ts', 'input.ts', 'frames.ts', 'chromium/crInput.ts', 'chromium/crPage.ts'],
    implementations: ['crates/flashwright-engine/src/pointer.rs', 'crates/flashwright-engine/src/pointer/completion.rs', 'packages/resident-runtime/locator-runtime.js'],
    changes: [
      'Ported content-quad clipping, two-decimal point truncation, frame-owner targeting and native modifier/input sequencing into Rust',
      'Wrapped pinned actionability and hit-target helpers with fresh cancellable animation-frame stability checks and bounded attempt ownership',
      'Observed terminal native events through the pinned interceptor hook to release retained nodes and preserve noWaitAfter during pending navigation',
      'Release resident attempts inside completion and retain dispatched by-value completion commands through navigation until their original reply or connection loss',
      'Adapted main-frame commit/failure barriers to the owned Chromium event registry and host deadlines',
    ],
  },
  assertionAdaptations: {
    source: 'https://github.com/microsoft/playwright/tree/v1.60.0/packages',
    referenceFiles: ['injected/src/injectedScript.ts', 'isomorphic/expectUtils.ts', 'playwright/src/matchers/matchers.ts', 'playwright/src/index.ts'],
    implementations: ['crates/flashwright-engine/src/assertions.rs', 'packages/resident-runtime/locator-runtime.js', 'packages/flashwright-runner/src/matchers.ts', 'packages/flashwright-runner/src/index.ts'],
    changes: [
      'Call the unchanged injected _expectCore predicate through the isolated resident runtime, with strict single-target or array-specific resolution',
      'Own retry, cancellation and deadlines in Rust; retain the last observation with explicit bounded diagnostic truncation after evaluating the full predicate',
      'Adapt expected-text serialization and public matcher options through the documented expect.extend boundary',
      'Use the pinned _baseTest scheduling root with explicit native browser/context/page fixtures and option validation; supported launch/context fixture overrides follow upstream precedence',
      'Isolate matcher extension state from the upstream expectation object and use one runtime for ESM/CommonJS consumers',
    ],
  },
  license: 'Apache-2.0', licensePath: 'compatibility/upstream/LICENSE.playwright', noticePath: 'compatibility/upstream/NOTICE.playwright',
}, null, 2) + '\n');
console.log(`${check ? 'Verified' : 'Extracted'} ${source.length} characters of pinned injected runtime and locator helpers`);
