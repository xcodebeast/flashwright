import assert from 'node:assert/strict';
import { posix } from 'node:path';
import { hashBytes, ownerTreeEvidenceLimits } from './final-goal-owner-records.mjs';
import { adaptFinalGoalResources } from './final-goal-original-resources.mjs';

/** Shared campaign path: read originals, reconstruct custody and project resources before comparing summaries. */
export async function reconstructFinalGoalResourceEvidence(manifest, options, readBytes) {
  const ownerTreeEvidence = await loadFinalGoalOwnerEvidence(manifest, readBytes);
  return adaptFinalGoalResources({ ...options, ownerTreeEvidence });
}

/** Validate the complete raw-file inventory before issuing a bounded read of any member. */
export async function loadFinalGoalOwnerEvidence(manifest, readBytes) {
  assert.deepEqual(Object.keys(manifest ?? {}).sort(), ['files', 'schemaVersion']);
  assert.equal(manifest.schemaVersion, 1);
  const limits = ownerTreeEvidenceLimits;
  assert.deepEqual(Object.keys(manifest.files ?? {}).sort(),
    [...Object.keys(limits.fixed), ...Object.keys(limits.inventories)].sort(), 'Missing or unknown raw owner evidence inventory');
  const pending = [];
  const paths = new Set();
  let aggregateBytes = 0;
  function retain(field, receipt, maximumBytes, named) {
    assert.deepEqual(Object.keys(receipt ?? {}).sort(), named ? ['bytes', 'name', 'path', 'sha256'] : ['bytes', 'path', 'sha256']);
    assert(typeof receipt.path === 'string' && receipt.path.length > 0 && !posix.isAbsolute(receipt.path)
      && posix.normalize(receipt.path) === receipt.path && !receipt.path.includes('\\')
      && !receipt.path.split('/').some(part => ['', '.', '..'].includes(part)), 'Raw owner evidence path must be relative and contained');
    assert(!paths.has(receipt.path), 'Raw owner evidence path reused');
    paths.add(receipt.path);
    assert.match(receipt.sha256 ?? '', /^[a-f0-9]{64}$/);
    assert(Number.isSafeInteger(receipt.bytes) && receipt.bytes > 0 && receipt.bytes <= maximumBytes,
      'Raw owner evidence file exceeds its byte limit');
    aggregateBytes += receipt.bytes;
    assert(aggregateBytes <= limits.maximumAggregateBytes, 'Raw owner evidence exceeds aggregate byte limit');
    if (named) assert(typeof receipt.name === 'string' && receipt.name.length <= 160
      && /^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(receipt.name), 'Invalid raw inventory filename');
    pending.push({ field, receipt, maximumBytes, named });
  }
  for (const [field, maximumBytes] of Object.entries(limits.fixed)) retain(field, manifest.files[field], maximumBytes, false);
  for (const [field, inventoryLimits] of Object.entries(limits.inventories)) {
    const inventory = manifest.files[field];
    assert(Array.isArray(inventory) && inventory.length <= inventoryLimits.maximumEntries, 'Raw inventory exceeds entry limit');
    assert.equal(new Set(inventory.map(entry => entry.name)).size, inventory.length, 'Duplicate raw inventory filename');
    for (const receipt of inventory) retain(field, receipt, inventoryLimits.maximumBytes, true);
  }
  const evidence = Object.fromEntries(Object.keys(limits.inventories).map(field => [field, []]));
  for (const { field, receipt, maximumBytes, named } of pending) {
    // The reader must check expected size before allocating. The second check also protects alternate readers.
    const bytes = await readBytes(receipt, { maximumFileBytes: maximumBytes, expectedSize: receipt.bytes });
    assert(Buffer.isBuffer(bytes) && bytes.length === receipt.bytes, 'Raw owner evidence size differs');
    assert.equal(hashBytes(bytes), receipt.sha256, 'Raw owner evidence bytes changed');
    if (named) evidence[field].push({ name: receipt.name, bytes });
    else evidence[field] = bytes;
  }
  return evidence;
}
