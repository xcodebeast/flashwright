import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/** Check before opening any graph: incompatible Ninja versions can discard its log. */
export function checkedChromiumNinja(sourceDirectory, override) {
  const executable = override ?? resolve(sourceDirectory, 'third_party/ninja', process.platform === 'win32' ? 'ninja.exe' : 'ninja');
  if (!existsSync(executable)) throw new Error('The checkout must provide its pinned Ninja executable.');
  const version = spawnSync(executable, ['--version'], {
    cwd: sourceDirectory, encoding: 'utf8', timeout: 5000, maxBuffer: 4096,
  });
  if (version.error) throw version.error;
  if (version.status !== 0 || version.stdout.trim() !== '1.12.1') {
    throw new Error(`${override ? '--single-pass-ninja' : 'The pinned Chromium build'} requires Ninja 1.12.1; refusing to open build metadata with this executable.`);
  }
  return executable;
}
