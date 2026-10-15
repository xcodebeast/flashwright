import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

/** A passing trace loader is insufficient: verify the same artifacts in the real pinned viewer. */
async function run(script, arguments_ = [], { intentionalCrash = false } = {}) {
  const command = intentionalCrash
    ? ['python3', 'tools/process-fault-fixture.py', process.execPath, script, ...arguments_]
    : [process.execPath, script, ...arguments_];
  const child = spawn(command[0], command.slice(1), { stdio: ['ignore', 'pipe', 'inherit'] });
  let tail = '';
  child.stdout.on('data', bytes => { process.stdout.write(bytes); tail = (tail + bytes.toString()).slice(-16384); });
  const code = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  assert.equal(code, 0, `${script} failed`);
  return tail;
}
const output = await run('tools/run-manual-trace-tests.mjs', [], { intentionalCrash: true });
const reportPath = /^Manual tracing evidence: (.+)$/m.exec(output)?.[1];
assert.ok(reportPath, 'manual tracing run must identify its completed evidence report');
await run('tools/test-manual-trace-viewer.mjs', [reportPath]);
await run('tools/run-manual-trace-runner-tests.mjs');
