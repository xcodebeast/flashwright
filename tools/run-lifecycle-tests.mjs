import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

// Bound each discovered module independently; unrelated browser startups do not share a job budget.
const lifecycleModules = (await readdir('compatibility/m1')).filter(name => /^test_.*\.py$/.test(name)).sort();
const jobs = [...lifecycleModules.map(name => [name, '240']), ['output_limits.py', '180'], ['binary_attachments.py', '180'], ['watchdog_lifecycle.py', '180']];
for (const [pattern, timeout] of jobs) {
  const child = spawn('python3', ['tools/watchdog.py', '--timeout', timeout, '--report-directory', 'compatibility/evidence/resources', '--', 'python3', 'tools/run-python-tests.py', '--start-directory', 'compatibility/m1', '--pattern', pattern], {
    stdio: 'inherit', env: { ...process.env, FLASHWRIGHT_TEST_NODE: process.execPath, FLASHWRIGHT_DRIVER_PATH: process.env.FLASHWRIGHT_DRIVER_PATH ?? resolve('target/debug/flashwright-driver'), FLASHWRIGHT_BROWSER_PATH: process.env.FLASHWRIGHT_BROWSER_PATH ?? chromium.executablePath() },
  });
  const code = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', code => resolve(code ?? 1));
  });
  if (code !== 0) {
    process.exitCode = code;
    break;
  }
}
