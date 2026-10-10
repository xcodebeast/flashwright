import assert from 'node:assert/strict';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { hash } from './competitor-inputs.mjs';

export async function applicationEvidenceFiles(directory) {
  const files = {};
  async function visit(path = '') {
    for (const name of (await readdir(join(directory, path))).sort()) {
      const relative = join(path, name);
      const information = await lstat(join(directory, relative));
      assert.equal(information.isSymbolicLink(), false, 'Evidence must not contain symbolic links');
      if (information.isDirectory()) await visit(relative);
      else {
        assert.ok(information.isFile());
        files[relative] = await readFile(join(directory, relative));
      }
    }
  }
  await visit();
  return files;
}

export const applicationEvidenceHashes = files => Object.fromEntries(Object.entries(files).map(([path, bytes]) => [path, hash(bytes)]));

/** Only known execution paths change. Unknown private paths stop publication. */
export function normalizeApplicationEvidence(files, inputs) {
  const replacements = [
    [inputs.outputDirectory, '/retained/application'],
    [inputs.runtime, '/runtime/executable'],
    [inputs.browser.executablePath, '/browser/executable'],
    [inputs.driverPath, '/driver/executable'],
    [inputs.workspaceDirectory, '/workspace'],
  ].flatMap(([original, replacement]) => {
    assert.ok(typeof original === 'string' && original.startsWith('/'));
    return [[original, replacement], [pathToFileURL(original).href, pathToFileURL(replacement).href]];
  }).sort((left, right) => right[0].length - left[0].length);
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const normalized = {};
  for (const [path, bytes] of Object.entries(files)) {
    let contents = decoder.decode(bytes);
    assert.equal(contents.includes('\0'), false, 'Binary artifacts require a separate reviewed export policy');
    for (const [original, replacement] of replacements) contents = contents.split(original).join(replacement);
    assert.equal(/\/(?:Users|home)\/|\/var\/folders\/|\/private\/var\//.test(contents), false, `Unmapped private path in ${path}`);
    normalized[path] = Buffer.from(contents);
  }
  return normalized;
}

export function numericApplicationObservations(value, path = '', numbers = {}) {
  if (typeof value === 'number') numbers[path] = value;
  else if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) numericApplicationObservations(child, `${path}/${key}`, numbers);
  return numbers;
}
