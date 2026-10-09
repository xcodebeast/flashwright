import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

/** Verification and timing use the same source identity, excluding generated artifacts and results. */
export async function sourceManifest() {
  const manifest = {};
  async function visit(path) {
    if ((await stat(path)).isDirectory()) {
      for (const name of (await readdir(path)).sort()) {
        if (!['dist', 'node_modules', '__pycache__', 'results'].includes(name)) await visit(join(path, name));
      }
    } else manifest[path] = createHash('sha256').update(await readFile(path)).digest('hex');
  }
  for (const root of ['Cargo.toml', 'Cargo.lock', 'rust-toolchain.toml', 'package.json', 'bun.lock', 'tsconfig.json', 'crates', 'vendor', 'packages', 'tools', 'compatibility/m1', 'compatibility/m2', 'compatibility/migration-projects', 'benchmarks']) await visit(root);
  return manifest;
}
