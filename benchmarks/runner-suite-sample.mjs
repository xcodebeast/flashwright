import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startFixtureServer } from './fixture-server.mjs';
import { runtimeMetadata } from '../tools/javascript-runtime.mjs';

const directory = process.argv[2];
const inputs = JSON.parse(await readFile(join(directory, 'launch-inputs.json'), 'utf8'));
const { configuration, engine, launchIndex, runnerCommand } = inputs;
assert.ok(['playwright', 'flashwright'].includes(engine));
const report = { schemaVersion: 1, engine, launchIndex, comparisonClass: 'runner-fixture', ...runtimeMetadata,
  configuration, browser: inputs.browser, driverSha256: inputs.driverSha256, failures: [],
  scope: 'Actual native runner fixtures and intentional failures. Controlled fixture suite; not a representative application migration or comparative performance acceptance.' };
const started = performance.now();
let server;
try {
  server = await startFixtureServer(configuration.backendDelayMilliseconds);
  const child = spawn(process.execPath, runnerCommand, {
    env: { ...process.env, FLASHWRIGHT_TEST_BASE_URL: server.origin, FLASHWRIGHT_BROWSER_PATH: inputs.browser.executablePath,
      FLASHWRIGHT_DRIVER_PATH: inputs.driverPath, DEBUG: 'pw:browser', DEBUG_COLORS: '0', FLASHWRIGHT_DEBUG_BROWSER: '1', FORCE_COLOR: '0', PLAYWRIGHT_FORCE_TTY: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  report.runnerExit = await new Promise(resolve => {
    child.on('error', error => resolve({ code: null, error: error.message }));
    child.on('close', (code, signal) => resolve({ code, signal }));
  });
  report.runnerStdout = stdout;
  report.runnerStderr = stderr;
  report.runner = JSON.parse(await readFile(join(directory, 'runner-report.json'), 'utf8'));
} catch (error) { report.failures.push(error.stack ?? String(error)); }
finally {
  try { await server?.close(); } catch (error) { report.failures.push(error.stack ?? String(error)); }
  report.completeMilliseconds = performance.now() - started;
  report.backend = server?.counts;
  process.stdout.write(JSON.stringify(report) + '\n');
}
