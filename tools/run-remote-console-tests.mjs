import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { sourceManifest } from './source-manifest.mjs';
import { identifyBrowser } from './browser-identity.mjs';
import { verifyRemoteConsole } from './verify-remote-console.mjs';

const output = resolve(process.argv[2]);
await mkdir(output);
const browser = process.env.FLASHWRIGHT_BROWSER_PATH, driver = process.env.FLASHWRIGHT_DRIVER_PATH;
assert(browser && driver);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const report = {
  status: 'running', sources: await sourceManifest(), browser: await identifyBrowser(browser),
  driverSha256: hash(await readFile(driver)), runtime: { node: process.versions.node, bun: process.versions.bun ?? null },
  checks: [], scope: 'Remote console API delivery, original argument handles and observed cleanup. No workers, history, complete artifact or performance admission.',
};
const save = () => writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
try {
  for (const engine of ['reference', 'candidate']) {
    const directory = join(output, engine), protocol = join(directory, 'protocol');
    await mkdir(directory);
    const resources = join(directory, 'resources.json');
    const child = spawn('python3', ['-B', 'tools/watchdog.py', '--timeout', '60', '--report', resources, '--', process.execPath, 'compatibility/m2/remote-console.mjs', engine, directory], {
      env: { ...process.env, FLASHWRIGHT_BROWSER_PATH: resolve('tools/remote-console-proxy.py'), FLASHWRIGHT_PROFILE_BROWSER_PATH: browser,
        FLASHWRIGHT_PROFILE_CLOCK_PORT: '0', FLASHWRIGHT_PROFILE_PROTOCOL_DIRECTORY: protocol },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks = [];
    child.stdout.on('data', chunk => chunks.push(chunk)); child.stderr.on('data', chunk => chunks.push(chunk));
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    await writeFile(join(directory, 'test.log'), Buffer.concat(chunks));
    const resource = JSON.parse(await readFile(resources, 'utf8'));
    const fixture = JSON.parse(await readFile(join(directory, 'report.json'), 'utf8'));
    const streams = (await readdir(protocol)).filter(name => name.endsWith('.jsonl'));
    assert.equal(streams.length, 1);
    const rows = (await readFile(join(protocol, streams[0]), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(code, 0, fixture.error); assert.equal(fixture.status, 'passed'); assert.equal(fixture.checks.length, 8);
    const ownership = verifyRemoteConsole(rows, engine);
    const clean = !resource.timedOut && !resource.interrupted && resource.cleanupSignals.length === 0 && resource.remainingObservedProcesses.length === 0;
    const exit = rows.filter(row => row.kind === 'exit');
    assert.equal(exit.length, 1); assert.equal(exit[0].exitCode, 0); assert.deepEqual(exit[0].failures, []);
    report.checks.push({ engine, exitCode: code, fixtureStatus: fixture.status, groups: fixture.checks.length, clean,
      ...ownership, resourceSha256: hash(await readFile(resources)),
      fixtureSha256: hash(await readFile(join(directory, 'report.json'))), protocolSha256: hash(await readFile(join(protocol, streams[0]))) });
    await save();
    assert(clean);
    console.log(engine, 'remote console passed');
  }
  assert.deepEqual(await sourceManifest(), report.sources);
  assert.equal(hash(await readFile(driver)), report.driverSha256);
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.error = error.stack; process.exitCode = 1;
} finally { await save(); }
