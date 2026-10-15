import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';

const artifactRoot = resolve(process.env.FLASHWRIGHT_ARTIFACT_DIR ?? 'workbench');
await mkdir(artifactRoot, { recursive: true });
const directory = await mkdtemp(join(artifactRoot, 'page-content-'));
for (const engine of ['playwright', 'flashwright']) {
  const child = spawn('python3', ['tools/watchdog.py', '--timeout', '120', '--report', join(directory, `${engine}.resources.json`), '--', process.execPath, 'compatibility/m2/page-content.mjs', engine, join(directory, `${engine}.json`)], {
    stdio: 'inherit',
    env: { ...process.env, FLASHWRIGHT_DRIVER_PATH: process.env.FLASHWRIGHT_DRIVER_PATH ?? resolve('target/debug/flashwright-driver'), FLASHWRIGHT_BROWSER_PATH: process.env.FLASHWRIGHT_BROWSER_PATH ?? chromium.executablePath() },
  });
  const result = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  assert.deepEqual(result, { code: 0, signal: null }, `${engine} content replacement checks failed; retained evidence: ${directory}`);
}
console.log(`Content replacement evidence: ${directory}`);
