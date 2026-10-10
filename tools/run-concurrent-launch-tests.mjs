import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';

const destination = resolve(process.argv[2] ?? `compatibility/evidence/concurrent-launch-${process.platform}-${Date.now()}`);
await mkdir(destination, { recursive: true });
const report = { platform: process.platform, status: 'running', cases: [], scope: 'Concurrent launch ownership and macOS launch-status descriptor inheritance; no performance claim.' };
async function execute(name, command, environment = process.env) {
  const child = spawn(command[0], command.slice(1), { env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
  const output = [], errors = [];
  child.stdout.on('data', chunk => output.push(chunk));
  child.stderr.on('data', chunk => errors.push(chunk));
  const [code, signal] = await once(child, 'close');
  const stdout = Buffer.concat(output), stderr = Buffer.concat(errors);
  await writeFile(join(destination, `${name}.stdout.txt`), stdout);
  await writeFile(join(destination, `${name}.stderr.txt`), stderr);
  assert.equal(signal, null, name);
  assert.equal(code, 0, `${name}: ${stderr.toString()}`);
  return stderr.toString();
}
async function verify(name, environment) {
  const resourcePath = join(destination, `${name}.resources.json`);
  const errors = await execute(name, ['python3', 'tools/watchdog.py', '--timeout', '60', '--report', resourcePath, '--', process.execPath, 'compatibility/m1/concurrent-launch.mjs'], environment);
  const resources = JSON.parse(await readFile(resourcePath, 'utf8'));
  assert.equal(resources.timedOut, false);
  assert.deepEqual(resources.cleanupSignals, []);
  assert.deepEqual(resources.remainingObservedProcesses, []);
  if (name === 'inheritance-window') assert.equal(errors.match(/flashwright:test launch pipe inheritance window/g)?.length, 3, 'Every new driver must execute the controlled pipe window');
  report.cases.push({ name, passed: true, browserPairs: 3 });
}
try {
  await verify('ordinary', process.env);
  if (process.platform === 'darwin') {
    const library = join(destination, 'launch-pipe-window.dylib');
    await execute('compile-injector', ['clang', '-dynamiclib', '-O2', '-o', library, 'compatibility/m1/launch-pipe-window.c']);
    await verify('inheritance-window', { ...process.env, DYLD_INSERT_LIBRARIES: library, FLASHWRIGHT_TEST_PIPE_WINDOW: '1', FLASHWRIGHT_DEBUG_BROWSER: '1' });
  }
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = String(error.stack ?? error); throw error; }
finally { await writeFile(join(destination, 'report.json'), JSON.stringify(report, null, 2) + '\n'); }
console.log(JSON.stringify(report));
