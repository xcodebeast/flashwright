import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';

assert.equal(JSON.parse(await readFile('node_modules/playwright-core/package.json', 'utf8')).version, '1.60.0');
const source = await readFile('node_modules/playwright-core/lib/utilsBundle.js', 'utf8');
const types = {};
for (const name of ['standard', 'other']) {
  const section = source.split(`// node_modules/mime/types/${name}.js\n`)[1]?.split('\n});')[0];
  const literal = section?.match(/module2\.exports = (\{.*\});/)?.[1];
  assert(literal, `Missing pinned MIME database ${name}`);
  for (const [mimeType, extensions] of Object.entries(JSON.parse(literal))) {
    for (const extension of extensions) {
      if (extension.startsWith('*')) continue;
      assert(!Object.hasOwn(types, extension), `Duplicate extension ${extension}`);
      types[extension.toLowerCase()] = mimeType.toLowerCase();
    }
  }
}
const contents = `// Generated from the MIME database bundled with Playwright 1.60.0; see file-inputs-provenance.json.
// Copyright (c) 2010 Benjamin Thomas, Robert Kieffer. MIT license: dist/LICENSE.mime.
const types: Readonly<Record<string, string>> = ${JSON.stringify(Object.fromEntries(Object.entries(types).sort(([first], [second]) => first < second ? -1 : first > second ? 1 : 0)), null, 2)};

/** Preserve the pinned filename fallback, including bare extensions and dotted basenames. */
export function fileMimeType(name: string): string {
  const basename = name.replace(/^.*[/\\\\]/, '').toLowerCase();
  const extension = basename.replace(/^.*\\./, '');
  const hasPath = basename.length < name.length;
  const hasDot = extension.length < basename.length - 1;
  return (hasDot || !hasPath) && Object.hasOwn(types, extension) ? types[extension]! : 'application/octet-stream';
}
`;
const path = 'packages/flashwright-core/src/file-mime-types.ts';
if (process.argv.includes('--check')) assert.equal(await readFile(path, 'utf8'), contents, 'MIME map differs from the pinned distribution');
else await writeFile(path, contents);
console.log(`Verified ${Object.keys(types).length} pinned MIME extensions.`);
