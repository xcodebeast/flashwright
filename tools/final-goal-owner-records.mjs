import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { posix } from 'node:path';

const mebibyte = 1024 * 1024;
const maximumAggregateBytes = 128 * mebibyte;
const maximumAggregateRecords = 200000;
const fixedInputs = {
  watchdogReportBytes: ['watchdog', 16 * mebibyte],
  ownerReportBytes: ['owner', mebibyte],
  runnerReportBytes: ['runner', 16 * mebibyte],
  preparedBytes: ['prepared', mebibyte],
  planBytes: ['plan', 64 * 1024],
};
const inventoryInputs = {
  processJournals: { maximumEntries: 64, maximumBytes: 16 * mebibyte },
  launchRecords: { maximumEntries: 32, maximumBytes: 64 * 1024 },
  nativeCaptures: { maximumEntries: 64, maximumBytes: 8 * mebibyte },
  guardianReaps: { maximumEntries: 32, maximumBytes: 64 * 1024 },
};

export function hashBytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function positiveProcessId(value) {
  assert(Number.isSafeInteger(value) && value > 0 && value <= 0x7fffffff, 'Invalid process identifier');
  return value;
}

export function decimalNanoseconds(value) {
  assert(typeof value === 'string' && /^[1-9][0-9]{0,38}$/.test(value), 'Missing positive decimal clock or kernel identity');
  return BigInt(value);
}

export function identityKey(identity) {
  return `${identity.process}:${identity.uniqueId}:${identity.version}`;
}

export function eventNanoseconds(event) {
  return decimalNanoseconds(event.nanoseconds);
}

export function canonicalAbsolutePath(value) {
  assert(typeof value === 'string' && value.length <= 8192 && !value.includes('\0')
    && posix.isAbsolute(value) && value !== '/' && posix.normalize(value) === value
    && !value.endsWith('/') && !value.includes('//'), 'Expected a normalized absolute path');
  return value;
}

export function validateKernelIdentity(identity) {
  assert(identity && typeof identity === 'object');
  positiveProcessId(identity.process);
  for (const field of ['uniqueId', 'parentUniqueId', 'startTicks']) {
    assert(decimalNanoseconds(identity[field]) <= 0xffffffffffffffffn, 'Invalid unsigned kernel identity');
  }
  for (const field of ['version', 'originalParentVersion']) {
    assert(Number.isSafeInteger(identity[field]) && identity[field] >= 0 && identity[field] <= 0xffffffff,
      'Invalid kernel process version');
  }
  assert(Number.isInteger(identity.readIterations) && identity.readIterations >= 1 && identity.readIterations <= 3);
  canonicalAbsolutePath(identity.executablePath);
  assert(decimalNanoseconds(identity.startedNanoseconds) <= decimalNanoseconds(identity.finishedNanoseconds));
}

/** Bound every supplied file and inventory before parsing any caller-controlled JSON. */
export function readOwnerTreeEvidence(evidence) {
  assert(evidence && typeof evidence === 'object' && !Array.isArray(evidence));
  assert.deepEqual(Object.keys(evidence).sort(), [...Object.keys(fixedInputs), ...Object.keys(inventoryInputs)].sort(),
    'Unknown or missing raw owner-tree inputs');
  let aggregateBytes = 0;
  let aggregateRecords = 0;
  const provenance = { fixed: {}, inventories: {}, aggregateBytes: 0 };
  const pendingFixed = {};
  const pendingInventories = {};
  const retain = (value, maximumBytes) => {
    assert(Buffer.isBuffer(value) || typeof value === 'string', 'Raw evidence must be Buffer or UTF-8 string');
    const length = Buffer.isBuffer(value) ? value.length : Buffer.byteLength(value, 'utf8');
    assert(length > 0 && length <= maximumBytes, 'Raw evidence file exceeds its byte limit');
    aggregateBytes += length;
    assert(aggregateBytes <= maximumAggregateBytes, 'Raw evidence exceeds aggregate byte limit');
    return Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8');
  };
  for (const [field, [name, maximumBytes]] of Object.entries(fixedInputs)) {
    const bytes = retain(evidence[field], maximumBytes);
    pendingFixed[name] = bytes;
    provenance.fixed[name] = { sha256: hashBytes(bytes), bytes: bytes.length };
  }
  for (const [field, limits] of Object.entries(inventoryInputs)) {
    const entries = evidence[field];
    assert(Array.isArray(entries) && entries.length <= limits.maximumEntries, 'Raw inventory exceeds entry limit');
    const names = new Set();
    pendingInventories[field] = entries.map(entry => {
      assert(entry && typeof entry === 'object');
      assert.deepEqual(Object.keys(entry).sort(), ['bytes', 'name']);
      assert(typeof entry.name === 'string' && entry.name.length <= 160 && /^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(entry.name),
        'Invalid raw inventory filename');
      assert(!names.has(entry.name), 'Duplicate raw inventory filename');
      names.add(entry.name);
      return { name: entry.name, bytes: retain(entry.bytes, limits.maximumBytes) };
    }).sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    provenance.inventories[field] = pendingInventories[field].map(entry => ({ name: entry.name,
      sha256: hashBytes(entry.bytes), bytes: entry.bytes.length }));
  }
  const decode = bytes => new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const parseObject = text => {
    const value = JSON.parse(text);
    assert(value && typeof value === 'object' && !Array.isArray(value), 'Expected a JSON object');
    return value;
  };
  const parseEntry = (entry, jsonLines) => {
    const text = decode(entry.bytes);
    if (!jsonLines) return { ...entry, value: parseObject(text) };
    assert(text.endsWith('\n'), 'JSONL evidence must end with a complete newline');
    const lines = text.slice(0, -1).split('\n');
    assert(lines.length > 0 && lines.length <= 50000, 'JSONL record limit exceeded');
    aggregateRecords += lines.length;
    assert(aggregateRecords <= maximumAggregateRecords, 'Aggregate JSONL record limit exceeded');
    assert(lines.every(line => line.length > 0 && Buffer.byteLength(line) <= 64 * 1024), 'Invalid or oversized JSONL record');
    return { ...entry, value: lines.map(parseObject) };
  };
  const records = Object.fromEntries(Object.entries(pendingFixed).map(([name, bytes]) => [name, parseObject(decode(bytes))]));
  for (const [field, entries] of Object.entries(pendingInventories)) {
    records[field] = entries.map(entry => parseEntry(entry, field === 'processJournals' || entry.name.endsWith('.jsonl')));
  }
  provenance.aggregateBytes = aggregateBytes;
  provenance.aggregateJsonlRecords = aggregateRecords;
  return { ...records, provenance };
}

/** Traverse reporter suites iteratively so nested raw input cannot exhaust the call stack. */
export function runnerSpecifications(suites) {
  assert(Array.isArray(suites));
  const specifications = [];
  const pending = suites.map(suite => ({ suite, depth: 1 })).reverse();
  let visited = 0;
  while (pending.length) {
    const { suite, depth } = pending.pop();
    assert(++visited <= 10000 && depth <= 64, 'Runner suite nesting or count exceeds limit');
    assert(suite && typeof suite === 'object');
    assert(Array.isArray(suite.specs ?? []) && Array.isArray(suite.suites ?? []));
    specifications.push(...(suite.specs ?? []));
    for (const child of [...(suite.suites ?? [])].reverse()) pending.push({ suite: child, depth: depth + 1 });
  }
  return specifications;
}
