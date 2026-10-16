import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { sourceManifest } from './source-manifest.mjs';
import { identifyBrowser } from './browser-identity.mjs';

const output = resolve(process.argv[2]);
await mkdir(output);
const browser = process.env.FLASHWRIGHT_BROWSER_PATH, driver = process.env.FLASHWRIGHT_DRIVER_PATH;
assert(browser && driver, 'Explicit browser and driver paths are required');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const report = { status: 'running', sources: await sourceManifest(), browser: await identifyBrowser(browser),
  driverSha256: hash(await readFile(driver)), checks: [], scope: 'Forced init-script registration/disposal ordering and original renderer failure ownership. No performance claim.' };
const save = () => writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
try {
  for (const mode of ['writer-add', 'reader-add', 'writer-dispose', 'reader-dispose', 'late-add-cancel', 'malformed-add', 'remove-destroyed', 'remove-timeout', 'late-add-destroyed', 'late-remove-cancel', 'blocked-init-close']) {
    const directory = join(output, mode); await mkdir(directory);
    const resources = join(directory, 'resources.json');
    const child = spawn('python3', ['-B', 'tools/watchdog.py', '--timeout', '45', '--report', resources, '--', 'python3', '-B', 'compatibility/m1/remote_init_script_races.py'], {
      env: { ...process.env, FLASHWRIGHT_BROWSER_PATH: resolve('tools/init-script-race-proxy.py'),
        FLASHWRIGHT_PROFILE_BROWSER_PATH: browser, FLASHWRIGHT_PROFILE_CLOCK_PORT: '0',
        FLASHWRIGHT_INIT_RACE_MODE: mode, FLASHWRIGHT_INIT_RACE_DIRECTORY: directory,
        FLASHWRIGHT_PROFILE_PROTOCOL_DIRECTORY: join(directory, 'protocol') }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks = []; child.stdout.on('data', chunk => chunks.push(chunk)); child.stderr.on('data', chunk => chunks.push(chunk));
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    await writeFile(join(directory, 'test.log'), Buffer.concat(chunks));
    const resource = JSON.parse(await readFile(resources, 'utf8'));
    const clean = !resource.timedOut && !resource.interrupted && resource.cleanupSignals.length === 0 && resource.remainingObservedProcesses.length === 0;
    report.checks.push({ mode, exitCode: code, clean, resourceSha256: hash(await readFile(resources)) }); await save();
    assert.equal(code, 0, mode); assert(clean, mode); console.log(mode, 'passed');
  }
  assert.deepEqual(await sourceManifest(), report.sources);
  assert.equal(hash(await readFile(driver)), report.driverSha256);
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = error.stack; process.exitCode = 1; }
finally { await save(); }
