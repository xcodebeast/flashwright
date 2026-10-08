import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

for (const [pattern, timeout] of [['test_*.py', '240'], ['output_limits.py', '180'], ['watchdog_lifecycle.py', '180']]) {
  const child = spawn('python3', ['tools/watchdog.py', '--timeout', timeout, '--report-directory', 'compatibility/evidence/resources', '--', 'python3', '-m', 'unittest', 'discover', '-s', 'compatibility/m1', '-p', pattern, '-v'], {
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
