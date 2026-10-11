import assert from 'node:assert/strict';
import { readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Inspect final bytes because native dependencies and linkers can bypass compiler remapping. */
export async function verifyDriverBinaryPaths(bytes) {
  const prefixes = new Set();
  for (const directory of [homedir(), process.cwd()]) {
    for (const path of [directory, await realpath(directory)]) prefixes.add(path.endsWith(sep) ? path : `${path}${sep}`);
  }
  for (const prefix of prefixes) {
    assert.equal(bytes.includes(Buffer.from(prefix)), false, `Driver contains local build path ${prefix}; rebuild with tools/build-driver.mjs before packaging`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  assert.equal(process.argv.length, 3, 'Usage: bun tools/verify-driver-binary-paths.mjs EXECUTABLE');
  await verifyDriverBinaryPaths(await readFile(process.argv[2]));
  console.log('Driver binary contains no current home or workspace paths');
}
