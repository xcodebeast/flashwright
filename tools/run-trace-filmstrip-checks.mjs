import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { runtimeArtifactLabel } from './javascript-runtime.mjs';

const directory = resolve(`compatibility/evidence/filmstrip-${process.platform}-${process.arch}-${runtimeArtifactLabel}-${new Date().toISOString().replaceAll(':', '-')}`);
await mkdir(directory, { recursive: true });

/** Native bounds and the shared corpus must also produce archives usable by the real viewer. */
async function run(script, arguments_, timeout) {
  const child = spawn('python3', ['tools/watchdog.py', '--timeout', String(timeout), '--report-directory', join(directory, 'resources'), '--', process.execPath, script, ...arguments_], { stdio: 'inherit' });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  assert.equal(code, 0, `${script} failed`);
}

await run('tools/test-native-filmstrip.mjs', [join(directory, 'native.json')], 120);
await run('tools/run-trace-filmstrip-tests.mjs', [directory], 180);
await run('tools/test-trace-filmstrip-viewer.mjs', [join(directory, 'report.json')], 180);
