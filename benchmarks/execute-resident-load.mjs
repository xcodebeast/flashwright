import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { verifyResidentLoad } from './resident-load-contract.mjs';

export function residentLoadName({ mode, scenario, launchGroup }) {
  return `${launchGroup}-${scenario.workload}-${scenario.conditionCount}-${mode}`;
}

/** Each launch owns immutable raw output and a watchdog report, including failed attempts. */
export async function runResidentLoad({ mode, scenario, launchGroup, destination, configuration, launchPolicy, driverPath, executablePath, diagnostic = false }) {
  const name = residentLoadName({ mode, scenario, launchGroup });
  const resourcePath = join(destination, `resources-${name}.json`);
  const started = performance.now();
  const child = spawn('python3', ['tools/watchdog.py', '--timeout', '45', '--report', resourcePath, '--', process.execPath,
    'benchmarks/resident-load-sample.mjs', mode, scenario.workload, String(scenario.conditionCount), String(launchGroup)], {
    env: { ...process.env, DEBUG: 'pw:browser', DEBUG_COLORS: '0', FLASHWRIGHT_DEBUG_BROWSER: '1',
      FLASHWRIGHT_DRIVER_PATH: driverPath, FLASHWRIGHT_BROWSER_PATH: executablePath,
      FLASHWRIGHT_RESIDENT_ASSERTIONS: mode === 'flashwright-on' ? '1' : '0',
      FLASHWRIGHT_CONDITION_INSTRUMENTATION: diagnostic ? '1' : '0', FLASHWRIGHT_LOAD_DIAGNOSTICS: diagnostic ? '1' : '0' },
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
  catch (error) { result = { mode, scenario, launchGroup, failures: [error.stack] }; }
  Object.assign(result, { processExit, processWallMilliseconds: performance.now() - started, output, diagnostics });
  result.resources = await readFile(resourcePath, 'utf8').then(JSON.parse, error => ({ error: error.message }));
  result.contractFailures = [];
  try { verifyResidentLoad(result, configuration, launchPolicy, executablePath, diagnostic); }
  catch (error) { result.contractFailures.push(error.stack); }
  await writeFile(join(destination, `launch-${name}.json`), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  return result;
}
