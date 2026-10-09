import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export const bunVersion = '1.4.2';
let verifiedExecutable;
export function requireBun() {
  if (verifiedExecutable) return verifiedExecutable;
  const local = resolve(`.tools/bun-v${bunVersion}-${process.platform}-${process.arch}/bin/bun`);
  const executable = process.env.FLASHWRIGHT_BUN_PATH ?? (process.versions.bun ? process.execPath : existsSync(local) ? local : 'bun');
  assert.equal(execFileSync(executable, ['--version'], { encoding: 'utf8' }).trim(), bunVersion, `Use Bun ${bunVersion}; run python3 tools/bootstrap.py`);
  verifiedExecutable = executable;
  return executable;
}
