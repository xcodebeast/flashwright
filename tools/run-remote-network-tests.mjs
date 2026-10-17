import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { sourceManifest } from './source-manifest.mjs';
import { identifyBrowser } from './browser-identity.mjs';

const output = resolve(process.argv[2]); await mkdir(output);
const browser = process.env.FLASHWRIGHT_BROWSER_PATH, driver = process.env.FLASHWRIGHT_DRIVER_PATH;
assert(browser && driver);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const report = { status: 'running', sources: await sourceManifest(), browser: await identifyBrowser(browser), driverSha256: hash(await readFile(driver)), checks: [], scope: 'Native Linux renderer network ownership; no complete trace, snapshot or performance acceptance.' };
const save = () => writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
try {
  for (const [engine, mode] of [['reference', 'public'], ['candidate', 'public'], ['candidate', 'recording']]) {
    const directory = join(output, `${engine}-${mode}`); await mkdir(directory);
    const protocol = join(directory, 'protocol');
    const resources = join(directory, 'resources.json');
    const child = spawn('python3', ['-B', 'tools/watchdog.py', '--timeout', '45', '--report', resources, '--', process.execPath, 'compatibility/m2/remote-network.mjs', engine, directory, mode], {
      env: { ...process.env, FLASHWRIGHT_BROWSER_PATH: resolve('tools/network-renderer-proxy.py'), FLASHWRIGHT_PROFILE_BROWSER_PATH: browser, FLASHWRIGHT_PROFILE_CLOCK_PORT: '0', FLASHWRIGHT_PROFILE_PROTOCOL_DIRECTORY: protocol }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks = []; child.stdout.on('data', chunk => chunks.push(chunk)); child.stderr.on('data', chunk => chunks.push(chunk));
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    await writeFile(join(directory, 'test.log'), Buffer.concat(chunks));
    const resource = JSON.parse(await readFile(resources, 'utf8'));
    const clean = !resource.timedOut && !resource.interrupted && resource.cleanupSignals.length === 0 && resource.remainingObservedProcesses.length === 0;
    const fixture = JSON.parse(await readFile(join(directory, 'report.json'), 'utf8'));
    const rows = (await Promise.all((await readdir(protocol)).filter(name => name.endsWith('.jsonl')).map(async name => (await readFile(join(protocol, name), 'utf8')).trim().split('\n').map(JSON.parse)))).flat().filter(row => row.kind === 'networkOwnership');
    const sessions = new Set(rows.filter(row => row.method === 'Target.attachedToTarget' && row.parameters.targetInfo.type === 'iframe').map(row => row.parameters.sessionId));
    const bodyCommands = rows.filter(row => row.direction === 'send' && row.method === 'Network.getResponseBody');
    const remoteBodyCommands = bodyCommands.filter(row => sessions.has(row.sessionId));
    const starts = new Map(rows.filter(row => row.method === 'Network.requestWillBeSent' && row.parameters.type === 'Document').map(row => [row.parameters.requestId, row]));
    const transfers = rows.filter(row => row.method === 'Page.frameNavigated' && starts.has(row.parameters.frame.loaderId)).filter(row => starts.get(row.parameters.frame.loaderId).sessionId !== row.sessionId);
    report.checks.push({ engine, mode, exitCode: code, clean, fixtureStatus: fixture.status, remoteSessions: sessions.size, remoteBodyCommands: remoteBodyCommands.length, documentTransfers: transfers.length, referenceImmediateBodyDifferences: fixture.referenceImmediateBodyDifferences?.length, bodyAfterChildRemoval: fixture.bodyAfterChildRemoval, resourceSha256: hash(await readFile(resources)), fixtureSha256: hash(await readFile(join(directory, 'report.json'))) }); await save();
    assert.equal(code, 0, `${engine} ${mode}: ${fixture.error}`); assert(clean); assert.equal(fixture.status, 'passed');
    assert(sessions.size >= 2); assert(remoteBodyCommands.length >= 4); assert(transfers.length >= 3);
    if (engine === 'candidate') for (const commit of transfers) {
      const source = starts.get(commit.parameters.frame.loaderId);
      assert(bodyCommands.some(command => command.parameters.requestId === source.parameters.requestId && command.sessionId === commit.sessionId), `missing original response owner: ${source.parameters.request.url}`);
    }
    console.log(engine, mode, 'passed');
  }
  assert.deepEqual(await sourceManifest(), report.sources); assert.equal(hash(await readFile(driver)), report.driverSha256);
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = error.stack; process.exitCode = 1; }
finally { await save(); }
