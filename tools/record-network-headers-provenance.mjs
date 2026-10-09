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
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    const name = node.left.getText(parsed);
    if (['ResponseExtraInfoTracker', 'RawHeaders'].includes(name)) snippets.set(name, node.getText(parsed));
  }
  if (ts.isMethodDeclaration(node)) {
    const name = node.name.getText(parsed);
    const contents = node.getText(parsed);
    if (name === '_actualHeaders' && contents.includes('rawRequestHeaders')) snippets.set('Request.actualHeaders', contents);
    if (name === '_actualHeaders' && contents.includes('rawResponseHeaders')) snippets.set('Response.actualHeaders', contents);
    if (name === 'headersArray' && contents.includes('this._actualHeaders()')) snippets.set(contents.includes('.slice()') ? 'Response.headersArray' : 'Request.headersArray', contents);
    if (name === 'setRawRequestHeaders') snippets.set('Request.setRawHeaders', contents);
    if (name === '_onLoadingFailed' && contents.includes('setRawRequestHeaders(null)')) snippets.set('Chromium.loadingFailed', contents);
  }
  ts.forEachChild(node, visit);
}
visit(parsed);
const selected = ['ResponseExtraInfoTracker', 'RawHeaders', 'Request.actualHeaders', 'Response.actualHeaders', 'Request.headersArray', 'Response.headersArray', 'Request.setRawHeaders', 'Chromium.loadingFailed'];
for (const name of selected) assert.ok(snippets.has(name), `Pinned network header contract missing ${name}`);
const extract = selected.map(name => `// ${name}\n${snippets.get(name)}`).join('\n\n') + '\n';
const hash = value => createHash('sha256').update(value).digest('hex');
const implementation = {};
for (const path of ['crates/flashwright-browser/src/connection/incoming.rs', 'crates/flashwright-browser/src/connection/incoming/request_event.rs', 'crates/flashwright-engine/src/network_request.rs', 'crates/flashwright-engine/src/network_observer.rs', 'crates/flashwright-engine/src/network_state.rs', 'crates/flashwright-engine/src/network_headers.rs', 'crates/flashwright-engine/src/page_state.rs', 'crates/flashwright-engine/src/events.rs', 'crates/flashwright-engine/src/lib.rs', 'packages/flashwright-core/src/network.ts', 'packages/flashwright-core/src/index.ts', 'packages/flashwright-core/src/frame.ts', 'packages/flashwright-core/src/engine-contract.ts']) implementation[path] = hash(await readFile(path));
const outputs = {
  'compatibility/upstream/network-headers.source.txt': extract,
  'compatibility/upstream/network-headers-provenance.json': JSON.stringify({
    referenceVersion: '1.60.0', sources: ['https://github.com/microsoft/playwright/blob/v1.60.0/packages/playwright-core/src/server/chromium/crNetworkManager.ts', 'https://github.com/microsoft/playwright/blob/v1.60.0/packages/playwright-core/src/server/network.ts', 'https://github.com/microsoft/playwright/blob/v1.60.0/packages/playwright-core/src/client/network.ts'], distributionPath, distributionSha256: hash(source),
    retainedExtract: 'compatibility/upstream/network-headers.source.txt', extractSha256: hash(extract), implementation,
    relationship: 'Independent native occurrence history and extra-info queues follow pinned redirect ordering, cache/no-extra-info fallback and failed-request fallback. Host header indexing follows pinned case-insensitive values, repeated fields, Set-Cookie joining and header-array ownership.',
    changes: ['Request occurrence ownership is immutable and independent of the latest Chromium identifier used for body access.', 'Completed history is bounded to 1024 occurrences, with current live navigation responses pinned. Active records are separately bounded at 4096; they do not expire under completed-history pressure.', 'Raw and queued metadata share 64 MiB per-page and 256 MiB per-engine logical encoded JSON admission credits; unmatched header records are bounded at 4096 per page.', 'Private network.headers reads retained occurrences lazily without another HTTP request; cancellation, timeout and page closure end pending reads. Expired history is an explicit ResourceLimitError. Cached host headers remain available after closure; uncached reads require the original live page.', 'Host caches completed request/response identities together and retain active request objects through completion. Routing and trace-network integration are separate pending work.'],
    license: 'Apache-2.0', licensePath: 'compatibility/upstream/LICENSE.playwright', noticePath: 'compatibility/upstream/NOTICE.playwright',
  }, null, 2) + '\n',
};
for (const [path, contents] of Object.entries(outputs)) {
  if (process.argv.includes('--check')) assert.equal(await readFile(path, 'utf8'), contents, `Network headers provenance differs: ${path}`);
  else await writeFile(path, contents);
}
console.log('Verified pinned network-header provenance.');
