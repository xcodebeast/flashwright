/** Shared Node/renderer value codec. Strings carry UTF-16 units, never lossy UTF-8 conversions. */
function createValueCodec() {
  const failures = new WeakMap();
  function codecFailure(code, message) {
    const error = new Error(message);
    error.name = code;
    failures.set(error, code);
    return error;
  }
  /** Only this codec's own failures may claim a capability, limit or protocol error category. */
  function describeError(error, classifyCodecFailure = true) {
    let message;
    try {
      const stack = error == null ? undefined : error.stack;
      message = typeof stack === 'string' ? stack : String(error);
    } catch {
      message = 'JavaScript threw a value whose description could not be read';
    }
    return {
      code: classifyCodecFailure && failures.get(error) || 'EvaluationError',
      messageUnits: stringUnits(message.slice(0, 8192)),
      messageTruncated: message.length > 8192,
    };
  }
  function stringUnits(value) {
    return Array.from({ length: value.length }, (_, index) => value.charCodeAt(index));
  }
  function fromUnits(units) {
    let value = '';
    for (let index = 0; index < units.length; index += 8192) value += String.fromCharCode(...units.slice(index, index + 8192));
    return value;
  }
  function encode(value, handleIndex) {
    const visited = new Map();
    let nodes = 0;
    function visit(value, depth) {
      if (++nodes > 100000 || depth > 48) throw codecFailure('ResourceLimitError', 'evaluation value exceeds depth or node limits');
      const index = handleIndex?.(value);
      if (index !== undefined) return { kind: 'handle', index };
      if (value === undefined) return { kind: 'undefined' };
      if (value === null) return { kind: 'null' };
      if (typeof value === 'string') {
        nodes += value.length;
        if (nodes > 100000) throw codecFailure('ResourceLimitError', 'evaluation string exceeds node limit');
        return { kind: 'string', units: stringUnits(value) };
      }
      if (typeof value === 'boolean') return { kind: 'boolean', value };
      if (typeof value === 'number') {
        if (Object.is(value, -0)) return { kind: 'special', value: '-0' };
        if (!Number.isFinite(value)) return { kind: 'special', value: String(value) };
        return { kind: 'number', value };
      }
      if (typeof value === 'bigint') return { kind: 'bigint', value: String(value) };
      if (typeof value !== 'object') throw codecFailure('UnsupportedFeatureError', `evaluation value of type ${typeof value}`);
      // Browser objects serialize as reference descriptions, including when nested.
      for (const name of ['Window', 'Document', 'Node']) {
        if (typeof globalThis[name] === 'function' && value instanceof globalThis[name]) return { kind: 'string', units: stringUnits(`ref: <${name}>`) };
      }
      if (visited.has(value)) return { kind: 'reference', identifier: visited.get(value) };
      const identifier = visited.size + 1;
      visited.set(value, identifier);
      if (Array.isArray(value)) return { kind: 'array', identifier, items: Array.from(value, item => visit(item, depth + 1)) };
      if (value instanceof Date) return { kind: 'date', identifier, value: value.toISOString() };
      if (value instanceof RegExp) return { kind: 'regexp', identifier, source: stringUnits(value.source), flags: value.flags };
      if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw codecFailure('UnsupportedFeatureError', `evaluation object ${Object.prototype.toString.call(value)}`);
      return { kind: 'object', identifier, entries: Object.keys(value).map(key => [stringUnits(key), visit(value[key], depth + 1)]) };
    }
    return visit(value, 0);
  }
  function decode(value, handles = []) {
    const references = new Map();
    let nodes = 0;
    function visit(value, depth) {
      if (++nodes > 100000 || depth > 48) throw codecFailure('ResourceLimitError', 'evaluation value exceeds depth or node limits');
      if (!value || typeof value !== 'object') throw codecFailure('ProtocolError', 'malformed evaluation value');
      switch (value.kind) {
        case 'handle': {
          if (!Number.isInteger(value.index) || value.index < 0 || value.index >= handles.length) throw codecFailure('ProtocolError', 'unknown evaluation handle');
          return handles[value.index];
        }
        case 'undefined': return undefined;
        case 'null': return null;
        case 'string': return fromUnits(value.units);
        case 'boolean': case 'number': return value.value;
        case 'special': {
          if (value.value === '-0') return -0;
          if (value.value === 'NaN') return NaN;
          if (value.value === 'Infinity') return Infinity;
          if (value.value === '-Infinity') return -Infinity;
          throw codecFailure('ProtocolError', 'unknown special number');
        }
        case 'bigint': return BigInt(value.value);
        case 'reference': {
          if (!references.has(value.identifier)) throw codecFailure('ProtocolError', 'unknown evaluation reference');
          return references.get(value.identifier);
        }
        case 'date': { const result = new Date(value.value); references.set(value.identifier, result); return result; }
        case 'regexp': { const result = new RegExp(fromUnits(value.source), value.flags); references.set(value.identifier, result); return result; }
        case 'array': {
          const result = []; references.set(value.identifier, result);
          for (const item of value.items) result.push(visit(item, depth + 1));
          return result;
        }
        case 'object': {
          const result = {}; references.set(value.identifier, result);
          for (const [key, item] of value.entries) Object.defineProperty(result, fromUnits(key), { value: visit(item, depth + 1), enumerable: true, configurable: true, writable: true });
          return result;
        }
        default: throw codecFailure('ProtocolError', 'unknown evaluation value kind');
      }
    }
    return visit(value, 0);
  }
  return { encode, decode, describeError };
}
exports.createValueCodec = createValueCodec;
