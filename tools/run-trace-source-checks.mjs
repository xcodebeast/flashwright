import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

/** A passing trace loader is insufficient: verify the same artifacts in the real pinned viewer. */
async function run(script, arguments_ = []) {
  const child = spawn(process.execPath, [script, ...arguments_], { stdio: ['ignore', 'pipe', 'inherit'] });
  let tail = '';
  child.stdout.on('data', bytes => { process.stdout.write(bytes); tail = (tail + bytes.toString()).slice(-16384); });
  const code = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  assert.equal(code, 0, `${script} failed`);
  return tail;
}
const output = await run('tools/run-trace-source-tests.mjs');
const reportPath = /^Trace source evidence: (.+)$/m.exec(output)?.[1];
assert.ok(reportPath, 'source capture run must identify its completed evidence report');
await run('tools/test-trace-source-viewer.mjs', [reportPath]);
