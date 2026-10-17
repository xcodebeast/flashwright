import assert from 'node:assert/strict';

// JSON.parse validates grammar; the token walk additionally rejects duplicate
// decoded property names, excessive nesting and nonfinite numeric values.
export function decodeLinuxApplicationJson(bytes) {
  assert(Buffer.isBuffer(bytes) && bytes.length <= 4 * 1024 ** 2, 'Application JSON byte limit exceeded');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const value = JSON.parse(text, (key, item) => {
    assert(typeof item !== 'number' || Number.isFinite(item), 'Nonfinite application JSON number');
    return item;
  });
  const stack = [];
  for (const match of text.matchAll(/"(?:[^"\\]|\\.)*"|[{}\[\],:]|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/g)) {
    const token = match[0], parent = stack.at(-1);
    if (token === '{' || token === '[') {
      stack.push({ object: token === '{', keys: new Set(), key: token === '{' });
      assert(stack.length <= 128, 'Application JSON nesting limit exceeded');
    } else if (token === '}' || token === ']') stack.pop();
    else if (token === ',' && parent?.object) parent.key = true;
    else if (token.startsWith('"') && parent?.object && parent.key) {
      const key = JSON.parse(token);
      assert(!parent.keys.has(key), 'Duplicate application JSON property');
      parent.keys.add(key); parent.key = false;
    }
  }
  return value;
}
