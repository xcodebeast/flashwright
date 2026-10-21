import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
const root = resolve(import.meta.dirname, '..');
const destination = resolve(process.argv[2] ?? join(root, 'workbench', `independent-browser-timeout-${Date.now()}`));
assert.ok(destination.startsWith(join(root, 'workbench') + '/'));
await mkdir(destination);
const browser = process.env.FLASHWRIGHT_BROWSER_PATH;
assert.ok(browser, 'Set FLASHWRIGHT_BROWSER_PATH to the pinned browser');
const paths = [browser, join(root, 'target/release/flashwright-driver'), ...['browser-case.cjs','browser-worker.cjs','browser-owner.mjs'].map(n => join(root,'compatibility/runner-timeouts',n))];
const hash = async p => createHash('sha256').update(await readFile(p)).digest('hex');
const hashes = Object.fromEntries(await Promise.all(paths.map(async p => [p, await hash(p)])));
await writeFile(join(destination, 'inputs.json'), JSON.stringify({ runtime: process.execPath, version: process.version, hashes }, null, 2));
for (const engine of ['reference', 'candidate']) {
  const directory = join(destination, engine); await mkdir(directory);
  if (engine === 'reference') {
    await writeFile(join(directory, 'browser.spec.cjs'), `const {test,chromium}=require('@playwright/test');require(${JSON.stringify(join(root,'compatibility/runner-timeouts/browser-case.cjs'))}).declare(test,chromium);`);
    await writeFile(join(directory, 'playwright.config.cjs'), 'module.exports=' + JSON.stringify({ testDir: directory, workers: 1, retries: 1, timeout: 10000, reporter: [['json', { outputFile: join(directory, 'result.json') }]], outputDir: join(directory, 'output') }));
  }
  const args = ['-B',join(root,'tools/watchdog.py'),'--timeout','60','--report',join(directory,'resources.json'),'--',process.execPath,join(root,'compatibility/runner-timeouts/browser-owner.mjs'),directory,engine];
  const env = { ...process.env, FW_TIMEOUT_BROWSER: browser, FLASHWRIGHT_DRIVER_PATH: join(root, 'target/release/flashwright-driver') };
  await writeFile(join(directory, 'command.json'), JSON.stringify({ executable: 'python3', args }, null, 2));
  const child = spawn('python3', args, { cwd: root, env, stdio: ['ignore','pipe','pipe'] });
  let output = ''; child.stdout.on('data', b => output += b); child.stderr.on('data', b => output += b);
  const exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); });
  await writeFile(join(directory, 'output.txt'), output);
  assert.deepEqual(exit, { code: 0, signal: null }, output);
  const resources = JSON.parse(await readFile(join(directory, 'resources.json')));
  assert.equal(resources.exitCode, 0); for (const flag of ['timedOut', 'interrupted']) assert.equal(resources[flag], false);
  assert.deepEqual(resources.cleanupSignals, []); assert.deepEqual(resources.remainingObservedProcesses, []);
  console.log(engine + ': native timeout, cleanup and fresh retry passed');
}
for (const [path, digest] of Object.entries(hashes)) assert.equal(await hash(path), digest, path);
await writeFile(join(destination, 'verified.json'), JSON.stringify({ status: 'passed', engines: ['reference','candidate'], selectedInputsUnchanged: true, nativeTimeoutRetry: true, naturalObservedProcessCleanup: true, performanceClaim: false }, null, 2));
