import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import ts from 'typescript';

const bundlePath = 'node_modules/playwright-core/lib/coreBundle.js';
const typesPath = 'node_modules/playwright-core/types/types.d.ts';
const bundle = await readFile(bundlePath, 'utf8');
const types = await readFile(typesPath, 'utf8');
assert.equal(JSON.parse(await readFile('node_modules/playwright-core/package.json', 'utf8')).version, '1.60.0');
const bundleFile = ts.createSourceFile(bundlePath, bundle, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const typesFile = ts.createSourceFile(typesPath, types, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const snippets = new Map();
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

function assignedClassName(classNode) {
  if (classNode.name?.text) return classNode.name.text;
  const declaration = classNode.parent;
  if (ts.isBinaryExpression(declaration) && ts.isIdentifier(declaration.left)) return declaration.left.text;
  if (ts.isVariableDeclaration(declaration) && ts.isIdentifier(declaration.name)) return declaration.name.text;
  return undefined;
}

function methodClassName(node) {
  let current = node.parent;
  while (current && !ts.isClassLike(current)) current = current.parent;
  return current ? assignedClassName(current) : undefined;
}

function addMethod(className, methodName, key, predicate = () => true) {
  function visit(node) {
    const matchesMethodKind = ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node);
    const actualMethodName = ts.isConstructorDeclaration(node) ? 'constructor' : matchesMethodKind ? node.name.getText(bundleFile) : undefined;
    if (matchesMethodKind && methodClassName(node) === className && actualMethodName === methodName && predicate(node)) {
      snippets.set(key, node.getText(bundleFile));
    }
    ts.forEachChild(node, visit);
  }
  visit(bundleFile);
}

function addClass(className, key, predicate = () => true) {
  function visit(node) {
    if (ts.isClassExpression(node) && assignedClassName(node) === className && predicate(node)) snippets.set(key, node.getText(bundleFile));
    ts.forEachChild(node, visit);
  }
  visit(bundleFile);
}

function addFunction(name, key) {
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) snippets.set(key, node.getText(bundleFile));
    ts.forEachChild(node, visit);
  }
  visit(bundleFile);
}

function addVariable(name, key) {
  function visit(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name && node.initializer) snippets.set(key, node.getText(bundleFile));
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(node.left) && node.left.text === name) snippets.set(key, node.getText(bundleFile));
    ts.forEachChild(node, visit);
  }
  visit(bundleFile);
}

addClass('Download', 'server.Download');
addClass('Download2', 'client.Download');
addClass('Artifact', 'server.Artifact');
addClass('Artifact2', 'client.Artifact');
addClass('ReadableStreamImpl', 'client.ReadableStreamImpl');
addClass('_CRBrowser', 'chromium.CRBrowser');
addClass('CRBrowserContext', 'chromium.CRBrowserContext');
addClass('_BrowserContext', 'server.BrowserContext');
addClass('_Browser', 'server.Browser');
addMethod('_CRBrowser', 'constructor', 'chromium.CRBrowser.constructor', node => node.getText(bundleFile).includes('Browser.downloadWillBegin'));
for (const [className, methodName, key] of [
  ['_CRBrowser', '_onDownloadWillBegin', 'chromium.downloadWillBegin'],
  ['_CRBrowser', '_onDownloadProgress', 'chromium.downloadProgress'],
  ['CRBrowserContext', 'initialize', 'chromium.contextInitialize'],
  ['CRBrowserContext', 'doClose', 'chromium.contextClose'],
  ['CRBrowserContext', 'cancelDownload', 'chromium.cancelDownload'],
  ['_BrowserContext', '_deleteAllDownloads', 'server.deleteAllDownloads'],
  ['_BrowserContext', 'close', 'server.contextClose'],
  ['_Browser', 'downloadCreated', 'server.downloadCreated'],
  ['_Browser', 'downloadFilenameSuggested', 'server.downloadFilenameSuggested'],
  ['_Browser', 'downloadFinished', 'server.downloadFinished'],
  ['Artifact', '_localPathAfterFinished', 'server.artifactPathAfterFinished'],
  ['Artifact', 'saveAs', 'server.artifactSaveAs'],
  ['Artifact', '_failureError', 'server.artifactFailure'],
  ['Artifact', '_delete', 'server.artifactDelete'],
  ['Artifact', 'deleteOnContextClose', 'server.artifactContextClose'],
  ['Artifact', 'reportFinished', 'server.artifactReportFinished'],
  ['Artifact2', 'pathAfterFinished', 'client.artifactPathAfterFinished'],
  ['Artifact2', 'saveAs', 'client.artifactSaveAs'],
  ['Artifact2', 'failure', 'client.artifactFailure'],
  ['Artifact2', 'createReadStream', 'client.artifactCreateReadStream'],
  ['Artifact2', 'cancel', 'client.artifactCancel'],
  ['Artifact2', 'delete', 'client.artifactDelete'],
  ['Download2', 'path', 'client.downloadPath'],
  ['Download2', 'saveAs', 'client.downloadSaveAs'],
  ['Download2', 'failure', 'client.downloadFailure'],
  ['Download2', 'createReadStream', 'client.downloadCreateReadStream'],
  ['Download2', 'cancel', 'client.downloadCancel'],
  ['Download2', 'delete', 'client.downloadDelete'],
  ['ReadableStreamImpl', '_read', 'client.ReadableStreamImpl._read'],
]) addMethod(className, methodName, key);
addFunction('validateBrowserContextOptions', 'server.contextOptionDefaults');
addFunction('toAcceptDownloadsProtocol', 'client.acceptDownloadsMapping');
addVariable('defaultNewContextParamValues', 'server.defaultNewContextParamValues');

const typeSnippets = new Map();
function visitTypes(node) {
  if (ts.isInterfaceDeclaration(node) && node.name.text === 'Download') typeSnippets.set('types.Download', node.getText(typesFile));
  if (ts.isInterfaceDeclaration(node) && node.name.text === 'BrowserContextOptions') {
    const option = node.members.find(member => ts.isPropertySignature(member) && member.name.getText(typesFile) === 'acceptDownloads');
    if (option) typeSnippets.set('types.BrowserContextOptions.acceptDownloads', option.getFullText(typesFile).trim());
  }
  ts.forEachChild(node, visitTypes);
}
visitTypes(typesFile);
for (const key of ['types.Download', 'types.BrowserContextOptions.acceptDownloads']) assert.ok(typeSnippets.has(key), `Missing pinned type contract ${key}`);

const snippetOrder = [
  'types.Download', 'types.BrowserContextOptions.acceptDownloads',
  'server.contextOptionDefaults', 'server.defaultNewContextParamValues', 'client.acceptDownloadsMapping',
  'chromium.CRBrowser.constructor', 'chromium.downloadWillBegin', 'chromium.downloadProgress',
  'chromium.contextInitialize', 'chromium.contextClose', 'chromium.cancelDownload',
  'server.Download', 'server.downloadCreated', 'server.downloadFilenameSuggested', 'server.downloadFinished',
  'server.Artifact', 'server.artifactPathAfterFinished', 'server.artifactSaveAs', 'server.artifactFailure',
  'server.artifactDelete', 'server.artifactContextClose', 'server.artifactReportFinished', 'server.deleteAllDownloads', 'server.contextClose',
  'client.Download', 'client.downloadPath', 'client.downloadSaveAs', 'client.downloadFailure', 'client.downloadCreateReadStream', 'client.downloadCancel', 'client.downloadDelete',
  'client.Artifact', 'client.artifactPathAfterFinished', 'client.artifactSaveAs', 'client.artifactFailure', 'client.artifactCreateReadStream', 'client.artifactCancel', 'client.artifactDelete',
  'client.ReadableStreamImpl', 'client.ReadableStreamImpl._read',
];
for (const key of snippetOrder) assert.ok(snippets.has(key) || typeSnippets.has(key), `Missing pinned download contract ${key}`);
const extract = snippetOrder.map(key => `// ${key}\n${(typeSnippets.get(key) ?? snippets.get(key)).trim()}`).join('\n\n') + '\n';

const implementationPaths = [
  'packages/flashwright-core/src/download.ts',
  'packages/flashwright-core/src/index.ts',
  'packages/flashwright-core/src/context-settings.ts',
  'packages/flashwright-core/src/engine-contract.ts',
  'packages/flashwright-runner/src/index.ts',
  'crates/flashwright-engine/src/downloads.rs',
  'crates/flashwright-engine/src/lib.rs',
  'crates/flashwright-engine/src/context_state.rs',
  'crates/flashwright-engine/src/events.rs',
  'crates/flashwright-engine/src/publication.rs',
  'crates/flashwright-engine/src/operation.rs',
  'crates/flashwright-driver/src/main.rs',
  'crates/flashwright-browser/src/chromium.rs',
  'crates/flashwright-browser/src/guardian_metadata.rs',
  'crates/flashwright-browser/src/supervision.rs',
  'crates/flashwright-browser/src/connection.rs',
];
const implementation = {};
for (const path of implementationPaths) implementation[path] = hash(await readFile(path));
const sources = [
  'packages/playwright-core/src/client/download.ts',
  'packages/playwright-core/src/client/artifact.ts',
  'packages/playwright-core/src/client/stream.ts',
  'packages/playwright-core/src/server/download.ts',
  'packages/playwright-core/src/server/artifact.ts',
  'packages/playwright-core/src/server/chromium/crBrowser.ts',
  'packages/playwright-core/src/server/browserContext.ts',
  'packages/playwright-core/src/server/browser.ts',
  'packages/playwright-core/src/server/registry/index.ts',
  'packages/playwright-core/src/utilsBundle.ts',
];
const metadata = {
  referenceVersion: '1.60.0',
  distributions: [
    { path: typesPath, sha256: hash(types) },
    { path: bundlePath, sha256: hash(bundle) },
  ],
  sources: sources.map(path => `https://github.com/microsoft/playwright/blob/v1.60.0/${path}`),
  retainedExtract: 'compatibility/upstream/downloads.source.txt',
  extractSha256: hash(extract),
  implementation,
  adaptations: [
    'Context settings validate acceptDownloads as a boolean and default it to true; the engine applies Browser.setDownloadBehavior per context with an isolated guardian-owned artifacts directory.',
    'The native event path associates Browser.downloadWillBegin frame IDs with public pages in the same browser, preserves raw URL and suggested-filename JSON for the client, and tracks completion/cancellation by the original context and GUID.',
    'The TypeScript Download retains original Page and BrowserContext ownership, validates the event envelope and metadata, exposes path/saveAs/failure/cancel/delete, and manages local Readable streams against context close and download deletion.',
    'The browser guardian announces its artifact directory over a bounded private pipe and holds artifact liveness while physical file operations and browser cleanup are in flight.',
    'Current implementation files and hashes are recorded so the extract can be regenerated after implementation edits.',
  ],
  observedReferenceConcern: 'Pinned ReadableStreamImpl._read is async and awaits channel.read without catching rejection or calling the callback form of Node Readable._read. Context-close stream termination was observed to produce an unhandled rejection or leave the stream read unsettled; this retained source records that behavior and makes no claim that it is safe.',
  limitations: [
    'No out-of-process iframe download ownership claim is made.',
    'No popup-origin fallback claim is made.',
    'No remote-connection Download path or stream claim is made.',
    'No persistent-context download behavior claim is made.',
    'No disk-quota or total downloaded-file-size guarantee is made.',
    'This provenance record is not conformance, performance, or release acceptance.',
  ],
  license: 'Apache-2.0',
  licensePath: 'compatibility/upstream/LICENSE.playwright',
  noticePath: 'compatibility/upstream/NOTICE.playwright',
};
const outputs = {
  'compatibility/upstream/downloads.source.txt': extract,
  'compatibility/upstream/downloads-provenance.json': JSON.stringify(metadata, null, 2) + '\n',
};
for (const [path, contents] of Object.entries(outputs)) {
  if (process.argv.includes('--check')) assert.equal(await readFile(path, 'utf8'), contents, `Download provenance differs: ${path}`);
  else await writeFile(path, contents);
}
console.log('Verified pinned download provenance.');
