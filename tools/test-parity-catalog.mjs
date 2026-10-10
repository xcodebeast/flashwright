import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { applyParityReviews, declarationFingerprint, renderParityTables, sha256 } from './parity-catalog.mjs';

function fixture() {
  const parent = { id: 'Page#1', parentId: null, kind: 'InterfaceDeclaration', source: 'playwright-core/types/types.d.ts', signature: 'interface Page {}', defaults: [] };
  const method = { ...parent, id: 'Page.method#1', parentId: parent.id, kind: 'MethodSignature', signature: 'method(options?: { value?: boolean }): void;' };
  const option = { ...method, id: 'Page.method.options.value#1', parentId: method.id, kind: 'PropertySignature', signature: 'value?: boolean;' };
  const overload = { ...method, id: 'Page.method#2', signature: 'method(value: string): void;' };
  const inventory = { referenceVersion: '1.60.0', entries: [parent, method, option, overload] };
  const reference = { path: 'packages/example.ts', sha256: sha256('implementation') };
  const evidence = { path: 'compatibility/evidence/example.json', sha256: sha256('evidence'), kind: 'conformance' };
  const group = { id: 'example', title: 'Example', scope: 'One reviewed overload.', limitations: 'Other options unverified.', defaults: 'Not established.', differences: [], status: 'experimental', assessment: 'verified-subset', implementation: [reference], evidence: [evidence], entries: [{ id: method.id, declarationSha256: declarationFingerprint(method) }] };
  const reviews = { schemaVersion: 1, referenceVersion: '1.60.0', groups: [group] };
  const files = new Map([[reference.path, 'implementation'], [evidence.path, 'evidence']]);
  const readReference = async path => {
    if (files.has(path)) return files.get(path);
    throw new Error(`Missing file: ${path}`);
  };
  return { inventory, reviews, group, readReference };
}

test('one reviewed method never promotes parents, options or sibling overloads', async () => {
  const { inventory, reviews, readReference } = fixture();
  const catalog = await applyParityReviews(inventory, reviews, readReference);
  assert.equal(catalog.reviewedEntries, 1);
  assert.deepEqual(catalog.entries.map(entry => entry.status), ['planned', 'experimental', 'planned', 'planned']);
  assert.deepEqual(catalog.entries.map(entry => entry.assessment), ['unverified', 'verified-subset', 'unverified', 'unverified']);
  assert.equal(inventory.entries[1].status, undefined);
});

for (const [name, mutate, message] of [
  ['unknown ID', state => { state.group.entries[0].id = 'missing'; }, /unknown entry/],
  ['duplicate claim', state => { state.group.entries.push(state.group.entries[0]); }, /Duplicate claim/],
  ['duplicate review', state => { state.reviews.groups.push(state.group); }, /duplicate review/],
  ['changed declaration', state => { state.inventory.entries[1].signature += ' changed'; }, /stale declaration/],
  ['changed overload parent', state => { state.inventory.entries[1].parentId = null; }, /stale declaration/],
  ['changed documented default', state => { state.inventory.entries[1].defaults.push('Defaults to false'); }, /stale declaration/],
  ['changed implementation', state => { state.group.implementation[0].sha256 = '0'.repeat(64); }, /stale reference/],
  ['changed evidence', state => { state.group.evidence[0].sha256 = '0'.repeat(64); }, /stale reference/],
  ['missing evidence', state => { state.group.evidence[0].path = 'missing.json'; }, /Missing file/],
  ['private evidence', state => { state.group.evidence[0].path = '.cache/private.json'; }, /public repository-relative/],
  ['escaping reference', state => { state.group.evidence[0].path = '../private.json'; }, /public repository-relative/],
  ['mismatched version', state => { state.reviews.referenceVersion = '1.61.0'; }, /pinned reference mismatch/],
  ['unknown parent', state => { state.inventory.entries[1].parentId = 'missing'; }, /Unknown parent/],
  ['parent cycle', state => { state.inventory.entries[0].parentId = state.inventory.entries[1].id; }, /Cyclic parent/],
  ['duplicate inventory ID', state => { state.inventory.entries.push(state.inventory.entries[0]); }, /Duplicate capability/],
  ['source-only experimental claim', state => { state.group.evidence[0].kind = 'source-review'; }, /requires conformance/],
  ['supported without package evidence', state => { state.group.status = 'supported'; state.group.assessment = 'verified'; }, /requires conformance and package/],
  ['unsupported incorrectly called verified', state => { state.group.status = 'unsupported'; }, /invalid status\/assessment/],
  ['misspelled review field', state => { state.group.limitation = 'ignored?'; }, /unknown fields/],
]) {
  test(`rejects ${name}`, async () => {
    const state = fixture();
    mutate(state);
    await assert.rejects(applyParityReviews(state.inventory, state.reviews, state.readReference), message);
  });
}

test('shifted source lines preserve declaration fingerprints', () => {
  const { inventory } = fixture();
  const entry = inventory.entries[1];
  assert.equal(declarationFingerprint(entry), declarationFingerprint({ ...entry, line: 400 }));
});

test('complete tables include every entry once and preserve deliberate differences', async () => {
  const { inventory, reviews, group, readReference } = fixture();
  group.differences = ['Retains the value instead of losing it.'];
  const catalog = await applyParityReviews(inventory, reviews, readReference);
  const tables = renderParityTables(catalog, reviews);
  const rows = [...tables].filter(([path]) => path !== 'docs/compatibility.md').flatMap(([, text]) => text.split('\n').filter(line => line.startsWith('| ') && !line.startsWith('| Exact') && !line.startsWith('| ---')));
  assert.equal(rows.length, inventory.entries.length);
  for (const entry of inventory.entries) assert.equal(rows.filter(row => row.startsWith(`| ${entry.id} |`)).length, 1);
  assert.match(tables.get('docs/compatibility.md'), /Retains the value/);
  assert.match(tables.get('docs/parity-browser.md'), /compatibility.md#example/);
});

test('repository catalog matches retained references and exact overloaded option parents', async () => {
  const catalog = JSON.parse(await readFile('compatibility/capabilities.json', 'utf8'));
  const reviews = JSON.parse(await readFile('compatibility/parity-reviews.json', 'utf8'));
  assert.deepEqual(await applyParityReviews(catalog, reviews, path => readFile(path)), catalog);
  assert.equal(catalog.entries.length, 6425);
  const entries = new Map(catalog.entries.map(entry => [entry.id, entry]));
  for (const overload of [1, 2]) {
    const prefix = 'playwright/types/test.d.ts.LocatorAssertions.toHaveScreenshot';
    assert.equal(entries.get(`${prefix}.options#${overload}`).parentId, `${prefix}#${overload}`);
  }
  const dialog = entries.get('playwright-core/types/types.d.ts.Page.on.listener.dialog#1');
  assert.equal(dialog.parentId, 'playwright-core/types/types.d.ts.Page.on.listener#4');
});

test('review metadata preserves every original pinned declaration and package target', async () => {
  const catalog = JSON.parse(await readFile('compatibility/capabilities.json', 'utf8'));
  const fields = ['id', 'kind', 'reference', 'backend', 'milestone', 'source', 'line', 'signature', 'defaults', 'heritage', 'optional', 'event', 'targets'];
  const declarations = catalog.entries.map(entry => Object.fromEntries(fields.filter(field => field in entry).map(field => [field, entry[field]])));
  assert.equal(sha256(JSON.stringify(declarations)), '91a6443a7a0e8e2a7b86141e190c236afc8f7d045b0b41d487ef71a4be8ff093');
});
