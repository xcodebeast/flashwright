import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

const child = spawn('python3', ['tools/watchdog.py', '--timeout', '90', '--report-directory', 'compatibility/evidence/resources', '--', process.execPath, 'compatibility/m2/assertions.mjs'], {
  stdio: 'inherit', env: { ...process.env, FLASHWRIGHT_DRIVER_PATH: process.env.FLASHWRIGHT_DRIVER_PATH ?? resolve('target/debug/flashwright-driver'), FLASHWRIGHT_BROWSER_PATH: process.env.FLASHWRIGHT_BROWSER_PATH ?? chromium.executablePath() },
});
child.on('error', error => { throw error; });
child.on('close', code => { process.exitCode = code ?? 1; });
