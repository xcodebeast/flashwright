import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { verifyLaunch } from './paired-contract.mjs';

/** Retain each attempted browser launch, including invalid observations and independent resource samples. */
export async function runSample({ launchIndex, engine, destination, configuration, launchPolicy, driverPath, executablePath }) {
  const resourcePath = join(destination, `resources-${launchIndex}-${engine}.json`);
  const started = performance.now();
  const child = spawn('python3', ['tools/watchdog.py', '--timeout', '90', '--report', resourcePath, '--', process.execPath, 'benchmarks/sample.mjs', String(launchIndex), engine], {
    env: { ...process.env, DEBUG: 'pw:browser', DEBUG_COLORS: '0', FLASHWRIGHT_DEBUG_BROWSER: '1', FLASHWRIGHT_DRIVER_PATH: driverPath, FLASHWRIGHT_BROWSER_PATH: executablePath, FLASHWRIGHT_BENCHMARK_OBSERVATIONS: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  let diagnostics = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { diagnostics += chunk; });
  const processExit = await new Promise(resolve => {
    child.on('error', error => resolve({ code: null, error: error.message }));
    child.on('close', (code, signal) => resolve({ code, signal }));
  });
  let result;
  try { result = JSON.parse(output); }
  catch (error) { result = { launchIndex, engine, workloads: [], failures: [error.stack], output }; }
  result.processExit = processExit;
  result.processWallMilliseconds = performance.now() - started;
  result.diagnostics = diagnostics;
  result.resources = await readFile(resourcePath, 'utf8').then(JSON.parse, error => ({ error: error.message }));
  result.contractFailures = [];
  try { verifyLaunch(result, configuration, launchPolicy, executablePath); }
  catch (error) { result.contractFailures.push(error.stack); }
  const path = join(destination, `launch-${launchIndex}-${engine}.json`);
  await writeFile(path, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  return result;
}

