import { failure } from './errors.js';

export const maximumSnapshotRecordBytes = 4 * 1024 * 1024;
const maximumWrapperBytes = 64 * 1024;
const maximumDepth = 260;
const maximumValues = 400000;
const outputChunkBytes = 64 * 1024;
const stringChunkUnits = 8192;
const snapshotFields = new Set(['callId', 'snapshotName', 'pageId', 'frameId', 'frameUrl', 'doctype', 'html', 'viewport', 'timestamp', 'wallTime', 'collectionTime', 'resourceOverrides', 'isMainFrame']);
const wrapperFields = ['callId', 'snapshotName', 'pageId', 'frameId', 'timestamp', 'isMainFrame'];

function invalid(message: string): Error { return failure('ProtocolError', 'tracing.snapshot', message); }
function limited(message: string): Error { return failure('ResourceLimitError', 'tracing.snapshot', message); }

/** Read only own data properties: snapshot serialization must not execute application accessors. */
function ownValue(object: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (!descriptor || !('value' in descriptor)) throw invalid('snapshot fields must be own data properties');
  return descriptor.value;
}
function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

/** Produce JSON with bounded string escaping; never split a UTF-16 surrogate pair between chunks. */
function* escapedString(value: string): Generator<string> {
  yield '"';
  for (let offset = 0; offset < value.length;) {
    let end = Math.min(value.length, offset + stringChunkUnits);
    const previous = value.charCodeAt(end - 1);
    const next = value.charCodeAt(end);
    if (end < value.length && previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end++;
    yield JSON.stringify(value.slice(offset, end)).slice(1, -1);
    offset = end;
  }
  yield '"';
}

/** The first pass freezes exclusively owned decoded data while validating its size and shape. */
function* fragments(root: unknown, freeze: boolean): Generator<string> {
  let values = 0;
  const ancestors = new Set<object>();
  function* visit(value: unknown, depth: number): Generator<string> {
    if (++values > maximumValues || depth > maximumDepth) throw limited('snapshot value or depth limit exceeded');
    if (typeof value === 'string') { yield* escapedString(value); return; }
    if (value === null) { yield 'null'; return; }
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw invalid('snapshot numbers must be finite');
      yield Object.is(value, -0) ? '0' : String(value); return;
    }
    if (typeof value === 'boolean') { yield value ? 'true' : 'false'; return; }
    if (!Array.isArray(value) && !plainObject(value)) throw invalid('snapshot contains a non-JSON value');
    if (ancestors.has(value)) throw invalid('snapshot contains a cycle');
    ancestors.add(value);
    if (Array.isArray(value)) {
      if (value.length > maximumValues) throw limited('snapshot array limit exceeded');
      if (freeze) Object.freeze(value);
      yield '[';
      for (let index = 0; index < value.length; index++) {
        if (index) yield ',';
        yield* visit(ownValue(value, String(index)), depth + 1);
      }
      yield ']';
    } else {
      const keys = Object.keys(value);
      if (keys.length > maximumValues) throw limited('snapshot object limit exceeded');
      if (freeze) Object.freeze(value);
      yield '{';
      for (let index = 0; index < keys.length; index++) {
        if (index) yield ',';
        const key = keys[index]!;
        yield* escapedString(key); yield ':';
        yield* visit(ownValue(value, key), depth + 1);
      }
      yield '}';
    }
    ancestors.delete(value);
  }
  yield* visit(root, 0);
}

function measure(value: unknown, maximumBytes: number, freeze: boolean): number {
  let bytes = 1; // trailing JSONL newline
  for (const fragment of fragments(value, freeze)) {
    bytes += Buffer.byteLength(fragment);
    if (bytes > maximumBytes) throw limited('snapshot serialized byte limit exceeded');
  }
  return bytes;
}

export interface PreparedSnapshotRecord {
  readonly byteLength: number;
  /** Each yielded chunk borrows one reusable buffer until the generator advances. */
  chunks(): Generator<Buffer>;
}

/** Check the viewer's node/reference grammar before allowing a large event through the writer. */
function validateSnapshotTree(root: unknown): void {
  let nodes = 0;
  let attributes = 0;
  const ancestors = new Set<object>();
  function visit(value: unknown, depth: number): void {
    if (++nodes > 50000 || depth > 130) throw limited('snapshot tree limit exceeded');
    if (typeof value === 'string') return;
    if (!Array.isArray(value) || ancestors.has(value)) throw invalid('invalid snapshot node');
    ancestors.add(value);
    const first = ownValue(value, '0');
    if (Array.isArray(first)) {
      if (value.length !== 1 || first.length !== 2) throw invalid('invalid snapshot reference');
      const distance = ownValue(first, '0');
      const index = ownValue(first, '1');
      if (!Number.isSafeInteger(distance) || Number(distance) <= 0 || !Number.isSafeInteger(index) || Number(index) < 0) throw invalid('invalid snapshot reference index');
    } else {
      if (typeof first !== 'string' || value.length < 2) throw invalid('invalid snapshot element');
      const properties = ownValue(value, '1');
      if (!plainObject(properties)) throw invalid('invalid snapshot attributes');
      for (const key of Object.keys(properties)) {
        if (++attributes > 100000) throw limited('snapshot attribute limit exceeded');
        if (typeof ownValue(properties, key) !== 'string') throw invalid('snapshot attributes must be strings');
      }
      for (let index = 2; index < value.length; index++) visit(ownValue(value, String(index)), depth + 1);
    }
    ancestors.delete(value);
  }
  visit(root, 0);
}

/** Admission retains one immutable decoded record, with only bounded encoding scratch at write time. */
export function prepareSnapshotRecord(event: unknown): PreparedSnapshotRecord {
  if (!plainObject(event) || Object.keys(event).length !== 2 || ownValue(event, 'type') !== 'frame-snapshot') throw invalid('expected one frame-snapshot event');
  const snapshot = ownValue(event, 'snapshot');
  if (!plainObject(snapshot) || Object.keys(snapshot).some(key => !snapshotFields.has(key))) throw invalid('invalid snapshot envelope');
  for (const name of ['pageId', 'frameId', 'frameUrl', 'snapshotName', 'callId'])
    if (typeof ownValue(snapshot, name) !== 'string') throw invalid(`invalid snapshot ${name}`);
  if (!Array.isArray(ownValue(snapshot, 'html')) && typeof ownValue(snapshot, 'html') !== 'string') throw invalid('invalid snapshot tree');
  validateSnapshotTree(ownValue(snapshot, 'html'));
  const resources = ownValue(snapshot, 'resourceOverrides');
  if (!Array.isArray(resources) || resources.length > 1024) throw invalid('invalid snapshot resources');
  for (const resource of resources) {
    if (!plainObject(resource) || Object.keys(resource).length !== 2 || typeof ownValue(resource, 'url') !== 'string') throw invalid('invalid snapshot resource');
    if (Object.hasOwn(resource, 'sha1')) {
      const alias = ownValue(resource, 'sha1');
      if (typeof alias !== 'string' || !/^[a-f0-9]{40,64}(?:\.[a-z0-9]{1,8})?$/.test(alias) || Buffer.byteLength(alias) > 128) throw invalid('invalid snapshot resource alias');
    } else {
      const reference = ownValue(resource, 'ref');
      if (!Number.isSafeInteger(reference) || Number(reference) <= 0) throw invalid('invalid snapshot stylesheet reference');
    }
  }
  const viewport = ownValue(snapshot, 'viewport');
  if (!plainObject(viewport) || Object.keys(viewport).length !== 2) throw invalid('invalid snapshot viewport');
  for (const name of ['width', 'height']) {
    const dimension = ownValue(viewport, name);
    if (typeof dimension !== 'number' || !Number.isFinite(dimension) || dimension < 0) throw invalid('invalid snapshot viewport dimension');
  }
  for (const name of ['timestamp', 'wallTime', 'collectionTime']) {
    const value = ownValue(snapshot, name);
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw invalid(`invalid snapshot ${name}`);
  }
  if (typeof ownValue(snapshot, 'isMainFrame') !== 'boolean' || typeof ownValue(snapshot, 'doctype') !== 'string') throw invalid('invalid snapshot document metadata');
  const wrapper = { type: 'frame-snapshot', snapshot: Object.fromEntries(wrapperFields.map(name => [name, ownValue(snapshot, name)])) };
  measure(wrapper, maximumWrapperBytes, false);
  const byteLength = measure(event, maximumSnapshotRecordBytes, true);
  return Object.freeze({
    byteLength,
    *chunks() {
      const buffer = Buffer.allocUnsafe(outputChunkBytes);
      let length = 0;
      for (const fragment of fragments(event, false)) {
        const bytes = Buffer.byteLength(fragment);
        if (bytes > buffer.length) throw invalid('snapshot encoder exceeded its bounded fragment size');
        if (length + bytes > buffer.length) { yield buffer.subarray(0, length); length = 0; }
        length += buffer.write(fragment, length, bytes, 'utf8');
      }
      if (length === buffer.length) { yield buffer; length = 0; }
      buffer[length++] = 10;
      yield buffer.subarray(0, length);
    },
  });
}
