import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { open, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { applicationCorpusDirectory, loadApplicationCorpus, startApplicationServer } from './application-corpus.mjs';
import { createFinalGoalClock } from '../tools/final-goal-clock.mjs';

assert.equal(process.platform, 'linux');
assert.equal(process.versions.bun, '1.4.2');
const directory = process.argv[2];
const prepared = JSON.parse(await readFile(join(directory, 'prepared.json'), 'utf8'));
const clock = await createFinalGoalClock(JSON.parse(process.env.FLASHWRIGHT_CAPTURE_CLOCK));
const report = { schemaVersion: 1, status: 'running', ownerProcess: process.pid, engine: prepared.engine,
  application: prepared.application, workers: 1, clock: clock.metadata, runnerCommand: prepared.runnerCommand,
  events: [], failures: [], serviceClosed: false };
const event = name => report.events.push({ name, nanoseconds: clock.nowNanoseconds().toString() });
let server;
try {
  event('fixture-start-requested');
  const corpus = await loadApplicationCorpus(applicationCorpusDirectory(prepared.application));
  assert.equal(corpus.manifestSha256, prepared.corpusManifestSha256);
  server = await startApplicationServer(corpus);
  report.fixtureUrl = server.url;
  event('fixture-listening');
  const stdout = await open(join(directory, 'runner-stdout.txt'), 'wx');
  let stderr;
  try {
    stderr = await open(join(directory, 'runner-stderr.txt'), 'wx');
    event('runner-spawn-requested');
    const child = spawn(prepared.runnerCommand[0], prepared.runnerCommand.slice(1), {
      cwd: prepared.workspaceDirectory,
      env: { ...process.env, FLASHWRIGHT_APPLICATION_URL: server.url,
        FLASHWRIGHT_BROWSER_PATH: prepared.browser.executablePath, FLASHWRIGHT_DRIVER_PATH: prepared.driverPath,
        FORCE_COLOR: '0', PLAYWRIGHT_FORCE_TTY: '0' },
      stdio: ['ignore', stdout.fd, stderr.fd],
    });
    report.runnerProcess = child.pid;
    report.runnerExit = await new Promise(resolve => {
      let error;
      child.once('error', cause => { error = cause.message; });
      child.once('close', (code, signal) => resolve({ code, signal, ...(error ? { error } : {}) }));
    });
    event('runner-closed');
    await stdout.sync();
    await stderr.sync();
  } finally {
    await stdout.close();
    await stderr?.close();
  }
  event('runner-streams-retained');
  assert.deepEqual(report.runnerExit, { code: 0, signal: null });
  JSON.parse(await readFile(join(prepared.project, 'report.json'), 'utf8'));
  event('reporter-output-readable');
} catch (error) {
  report.failures.push(error.stack ?? String(error));
} finally {
  event('fixture-close-requested');
  try {
    await server?.close();
    report.serviceClosed = Boolean(server);
    event('fixture-closed');
  } catch (error) {
    report.failures.push(error.stack ?? String(error));
  }
  report.requests = server?.requests ?? [];
  report.status = report.failures.length ? 'failed' : 'completed-owner';
  event('owner-report-write-requested');
  await writeFile(join(directory, 'owner-report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  clock.close();
  if (report.failures.length) process.exitCode = 1;
}
