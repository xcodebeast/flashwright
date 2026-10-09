import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { requireBun } from './bun-toolchain.mjs';
import { resolve } from 'node:path';

/** Pack the real dependency graph so consumer tests cannot resolve workspace symlinks. */
export async function packConsumerPackages(directory, { runner = false } = {}) {
  const archives = {};
  const dependencies = {};
  for (const name of ['flashwright-core', 'flashwright', ...(runner ? ['flashwright-runner', 'flashwright-test'] : [])]) {
    const packageDirectory = `packages/${name}`;
    const manifest = JSON.parse(await readFile(`${packageDirectory}/package.json`, 'utf8'));
    archives[name] = resolve(directory, `${manifest.name.replace('@', '').replace('/', '-')}-${manifest.version}.tgz`);
    execFileSync(requireBun(), ['pm', 'pack', '--filename', archives[name], '--ignore-scripts', '--quiet'], { cwd: packageDirectory, encoding: 'utf8' });
    dependencies[manifest.name] = manifest.version;
  }
  return { archives, dependencies };
}
