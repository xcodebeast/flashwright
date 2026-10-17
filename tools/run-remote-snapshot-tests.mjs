import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const output = resolve(process.argv[2]); await mkdir(output);
assert(process.env.FLASHWRIGHT_BROWSER_PATH && process.env.FLASHWRIGHT_DRIVER_PATH);
const child = spawn('python3', ['-B', 'tools/watchdog.py', '--timeout', '100', '--report', join(output, 'resources.json'), '--', process.execPath, 'tools/test-remote-snapshots.mjs', join(output, 'fixture'), process.argv[3] ?? 'both'], {
  env: { ...process.env, FLASHWRIGHT_PROFILE_BROWSER_PATH: process.env.FLASHWRIGHT_BROWSER_PATH,
    FLASHWRIGHT_BROWSER_PATH: resolve('tools/remote-snapshot-proxy.py'), FLASHWRIGHT_PROFILE_CLOCK_PORT: '0',
    FLASHWRIGHT_PROFILE_PROTOCOL_DIRECTORY: join(output, 'protocol') }, stdio: ['ignore', 'pipe', 'pipe'],
});
const chunks = []; child.stdout.on('data', chunk => chunks.push(chunk)); child.stderr.on('data', chunk => chunks.push(chunk));
const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
await writeFile(join(output, 'test.log'), Buffer.concat(chunks));
const resource = JSON.parse(await readFile(join(output, 'resources.json'), 'utf8'));
assert.equal(code, 0, Buffer.concat(chunks).toString());
assert(!resource.timedOut && !resource.interrupted && resource.cleanupSignals.length === 0 && resource.remainingObservedProcesses.length === 0);
const report = JSON.parse(await readFile(join(output, 'fixture/report.json'), 'utf8'));
assert.equal(report.status, 'passed');
console.log(`remote snapshots passed: ${report.cases.length} engines, ${report.cases.reduce((sum, item) => sum + item.replays.length, 0)} offline replays`);
