const assert = require('node:assert/strict');
const keys = ['DISPLAY', 'HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_SESSION_TYPE', 'ELECTRON_OZONE_PLATFORM_HINT'];
const MAX_BYTES = 1024 * 1024;
function overwrittenBytes(ranges, command) {
  const { argStart, argEnd, envStart, envEnd } = Object.fromEntries(['argStart', 'argEnd', 'envStart', 'envEnd'].map(key => {
    assert.match(ranges[key], /^[1-9]\d*$/);
    return [key, BigInt(ranges[key])];
  }));
  assert.ok(argStart < argEnd && argEnd === envStart && envStart < envEnd);
  const size = envEnd - argStart;
  assert.ok(size <= BigInt(MAX_BYTES));
  const title = Buffer.from(command, 'utf8');
  // Chromium reserves one byte from the contiguous argv/envp range, then
  // vsnprintf reserves its terminator. Truncation is not admitted here.
  assert.ok(BigInt(title.length + 2) <= size);
  const memory = Buffer.alloc(Number(size));
  title.copy(memory);
  return memory.subarray(Number(envStart - argStart));
}
function observeEnvironment(bytes, stat, command, isTitle) {
  assert.ok(bytes.length > 0 && bytes.length <= MAX_BYTES);
  if (!isTitle) {
    const selected = Object.fromEntries(bytes.toString('utf8').split('\0').filter(Boolean).map(entry => {
      const at = entry.indexOf('='); return [entry.slice(0, at), entry.slice(at + 1)];
    }).filter(([key]) => keys.includes(key)));
    return { mode: 'proc-selected-environment', selected };
  }
  // /proc stat field numbers48..51, with this array starting at field3.
  const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
  const ranges = Object.fromEntries(['argStart','argEnd','envStart','envEnd'].map((key,i) => [key, fields[45+i]]));
  assert.ok(bytes.equals(overwrittenBytes(ranges, command)), 'Unexpected original environment memory contents');
  return { mode: 'title-overwritten-proc-storage', selected: null, ranges, rawBase64: bytes.toString('base64'), liveBrowserEnvironmentObserved: false };
}
function verifyEnvironment(observation, command, isTitle, expected) {
  if (!isTitle) {
    assert.equal(observation.mode, 'proc-selected-environment');
    assert.deepEqual(observation.selected, expected);
    return;
  }
  assert.equal(observation.mode, 'title-overwritten-proc-storage');
  assert.equal(observation.selected, null);
  assert.equal(observation.liveBrowserEnvironmentObserved, false);
  assert.ok(typeof observation.rawBase64 === 'string' && observation.rawBase64.length <= Math.ceil(MAX_BYTES / 3) * 4);
  const bytes = Buffer.from(observation.rawBase64, 'base64');
  assert.ok(bytes.toString('base64') === observation.rawBase64, 'Noncanonical environment encoding');
  // Avoid constructing a quadratic assertion diff for malformed byte records.
  assert.ok(bytes.equals(overwrittenBytes(observation.ranges, command)), 'Unexpected original environment memory contents');
}
module.exports = { observeEnvironment, verifyEnvironment, overwrittenBytes };
