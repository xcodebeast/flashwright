import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

const distributionPath = 'node_modules/playwright-core/lib/coreBundle.js';
const distribution = await readFile(distributionPath, 'utf8');
assert.equal(JSON.parse(await readFile('node_modules/playwright-core/package.json', 'utf8')).version, '1.60.0');
const hash = value => createHash('sha256').update(value).digest('hex');
const regions = [
  ["forbidden header filtering", 13434, 13452, "ca393224319197fef29b6cefd14a143ef36ae8cd62fe4816de8c39985008e1ce"],
  ["forbidden header and method sets", 13516, 13538, "8aeb7e1b819aaee60367d916119b77611c62e4b3eebc756b8a0f1ab1bbefafc5"],
  ['server Route ownership and header behavior', 13666, 13802, 'd80c93b45e6e5e87673e766670fe1b8765623eb622a550e7db9c583ad96346c4'],
  ['Chromium interception and Fetch/Network joining', 34835, 35043, '36bc89a6ee659cd7b9e05dee89ff84ce458bb63cbb2d8af419feaa78d10575d3'],
  ['client Route methods', 54848, 54997, '7c7fde1d0897f3b0e3687e7580a0f440b2b94fe91cfcab6955f7bd6bf04f36f3'],
  ['client RouteHandler callback lifecycle', 55274, 55345, '3884c47557a87c870a7a3302762919e4e0477ab2cc01da7d3f08cd8443000500'],
  ['page dispatch', 56472, 56494, 'f2f289dd70826fbe91f7de28e8caa975e85856df2f4d64dcf9010685ac78b780'],
  ['page registration and removal', 56751, 56811, '09212da69427d072a270746887b264ee091e6cafb1c11f9ca748f7254e299dad'],
  ['context dispatch', 57360, 57387, '54ceacff6b756477424c68df46d0f9b3638f86b62cbf3de09ade336f5a656e4b'],
];
const lines = distribution.split('\n');
const extract = regions.map(([name, first, last, expected]) => {
  const snippet = lines.slice(first - 1, last).join('\n') + '\n';
  assert.equal(hash(snippet), expected, `Pinned routing contract changed: ${name}`);
  return `// ${name}: ${distributionPath}:${first}-${last}\n${snippet}`;
}).join('\n');
const implementation = {};
for (const path of ['crates/flashwright-browser/src/connection.rs', 'crates/flashwright-browser/src/connection/fetch_body.rs', 'crates/flashwright-engine/src/routing.rs', 'crates/flashwright-engine/src/routing_state.rs', 'crates/flashwright-engine/src/network_state.rs', 'crates/flashwright-engine/src/network_request.rs', 'crates/flashwright-engine/src/network_observer.rs', 'crates/flashwright-engine/src/page_state.rs', 'crates/flashwright-engine/src/context_state.rs', 'crates/flashwright-engine/src/events.rs', 'crates/flashwright-engine/src/lib.rs', 'packages/flashwright-core/src/routing.ts', 'packages/flashwright-core/src/network.ts', 'packages/flashwright-core/src/index.ts', 'packages/flashwright-core/src/engine-contract.ts']) implementation[path] = hash(await readFile(path));
const outputs = {
  'compatibility/upstream/routing.source.txt': extract,
  'compatibility/upstream/routing-provenance.json': JSON.stringify({
    referenceVersion: '1.60.0', distributionPath, distributionSha256: hash(distribution),
    sources: ['server/network.ts', 'server/chromium/crNetworkManager.ts', 'client/network.ts', 'client/page.ts', 'client/browserContext.ts'].map(path => 'https://github.com/microsoft/playwright/blob/v1.60.0/packages/playwright-core/src/' + path),
    retainedExtract: 'compatibility/upstream/routing.source.txt', extractSha256: hash(extract), implementation,
    relationship: 'Independent native interception and host callback ownership follow the pinned precedence, registration, continuation, removal and header contracts. No upstream browser driver is used for candidate routing.',
    changes: ['Immutable occurrence joins and bounded shared native pause/body ownership replace upstream channel objects.', 'Only typed Fetch body fields use the bounded binary-input writer; generic control limits remain unchanged.', 'Host history evicts whole redirect chains and accounts for lazy body/header growth. External user references remain valid.', 'Callback scopes prevent a removed handler from claiming a later handling stage. User registration async context and original error stacks are preserved.', 'Route.fetch and APIResponse-backed fulfillment remain unsupported. Original request observation has independent event limits; 32 MiB output bodies do not establish 32 MiB original-request or redirect observation.'],
    license: 'Apache-2.0', licensePath: 'compatibility/upstream/LICENSE.playwright', noticePath: 'compatibility/upstream/NOTICE.playwright',
  }, null, 2) + '\n',
};
for (const [path, contents] of Object.entries(outputs)) {
  if (process.argv.includes('--check')) assert.equal(await readFile(path, 'utf8'), contents, `Routing provenance differs: ${path}`);
  else await writeFile(path, contents);
}
console.log('Verified pinned routing provenance.');
