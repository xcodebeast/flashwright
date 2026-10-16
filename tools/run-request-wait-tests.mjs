import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

const directory = resolve(process.argv[2] ?? `workbench/request-waits-${Date.now()}`);
const child = spawn('python3', ['tools/watchdog.py', '--timeout', '180', '--report', `${directory}/resources.json`,
  '--', process.execPath, 'compatibility/m2/request-waits.mjs', directory], {
  stdio: 'inherit', env: { ...process.env,
    FLASHWRIGHT_DRIVER_PATH: process.env.FLASHWRIGHT_DRIVER_PATH ?? resolve('target/debug/flashwright-driver'),
    FLASHWRIGHT_BROWSER_PATH: process.env.FLASHWRIGHT_BROWSER_PATH ?? chromium.executablePath(),
  },
});
child.on('error', error => { throw error; });
child.on('close', code => { process.exitCode = code ?? 1; });
