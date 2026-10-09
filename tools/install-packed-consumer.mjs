import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { requireBun, bunVersion } from './bun-toolchain.mjs';
import { startConsumerRegistry } from './consumer-registry.mjs';

/** Exercise unchanged package versions through normal registry resolution in a fresh cache. */
export async function installPackedConsumer(directory, archives) {
  const registry = await startConsumerRegistry(archives);
  const command = [requireBun(), 'install', '--ignore-scripts', '--registry', registry.url];
  let output = '';
  try {
    const child = spawn('python3', [resolve('tools/watchdog.py'), '--timeout', '180', '--', ...command], {
      cwd: directory, env: { ...process.env, BUN_INSTALL_CACHE_DIR: join(directory, 'install-cache') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { output += bytes; });
    const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
    await writeFile(join(directory, 'install.log'), output);
    assert.equal(code, 0, output);
    return { packageManager: `bun@${bunVersion}`, command, code, registryRequests: registry.requests,
      logSha256: createHash('sha256').update(output).digest('hex'), log: join(directory, 'install.log') };
  } finally { await registry.close(); }
}
