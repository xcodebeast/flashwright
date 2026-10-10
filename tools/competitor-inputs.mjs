import { createHash } from 'node:crypto';
import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';

export const hash = bytes => createHash('sha256').update(bytes).digest('hex');

/** Freeze executable dependency bytes, following links once without filesystem cycles. */
export async function dependencyManifest(directory, entries = ['package.json', 'bun.lock', 'node_modules']) {
  const manifest = {};
  const visited = new Set();
  async function visit(path) {
    const absolute = join(directory, path);
    const resolved = await realpath(absolute);
    if (visited.has(resolved)) return;
    visited.add(resolved);
    if ((await stat(absolute)).isDirectory()) {
      for (const name of (await readdir(absolute)).sort()) await visit(join(path, name));
    } else manifest[path] = hash(await readFile(absolute));
  }
  for (const path of entries) await visit(path);
  return manifest;
}
