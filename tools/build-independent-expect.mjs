import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const digest = value => createHash('sha256').update(value).digest('hex');
const roots = {
  playwright: dirname(require.resolve('flashwright-upstream-runner/package.json')),
  core: dirname(require.resolve('playwright-core/package.json')),
};
function boundary(source, marker, occurrences = 1) {
  assert.equal(source.split(marker).length, occurrences + 1, `Pinned extraction boundary changed: ${marker}`);
  return source.indexOf(marker);
}

/** Extract only independently usable assertions and parsing; never initialize a runner or driver. */
export async function buildIndependentExpect(destination) {
  const manifest = JSON.parse(await readFile('compatibility/upstream/independent-expect-provenance.json', 'utf8'));
  assert.equal(manifest.referenceVersion, '1.60.0');
  const inputs = {};
  for (const [name, input] of Object.entries(manifest.inputs)) {
    const bytes = await readFile(join(roots[input.package], input.path));
    assert.equal(digest(bytes), input.sha256, `Pinned independent expect input changed: ${name}`);
    inputs[name] = bytes.toString();
  }
  const library = inputs.expect.slice(0, boundary(inputs.expect, '// packages/playwright/src/matchers/matcherHint.ts'));
  const parser = inputs.core.slice(0, boundary(inputs.core, '// packages/isomorphic/stringUtils.ts', 2));
  const yamlHeader = inputs.utils.slice(0, inputs.utils.indexOf('// node_modules/'));
  const yaml = inputs.utils.slice(boundary(inputs.utils, '// node_modules/yaml/dist/nodes/identity.js'), boundary(inputs.utils, '// node_modules/json5/lib/unicode.js'));
  const outputs = {
    'expect-library.cjs': library + '\nmodule.exports = { ' + manifest.libraryExports.join(', ') + ' };\n',
    'aria-parser.cjs': parser + '\ninit_ariaSnapshot();\nmodule.exports = { parseAriaSnapshotUnsafe };\n',
    'yaml.cjs': yamlHeader + yaml + '\nmodule.exports = require_dist4();\n',
    'LICENSE.playwright': inputs.license,
    'NOTICE.playwright': inputs.notice,
    'expect-library.cjs.LICENSE': inputs.expectLicense,
    'yaml.cjs.LICENSE': inputs.utilsLicense,
  };
  for (const [name, bytes] of Object.entries(outputs)) assert.equal(digest(bytes), manifest.outputs[name], `Independent expect output changed: ${name}`);
  await mkdir(destination, { recursive: true });
  for (const [name, bytes] of Object.entries(outputs)) await writeFile(join(destination, name), bytes);
  await writeFile(join(destination, 'independent-expect-provenance.json'), JSON.stringify(manifest, null, 2) + '\n');
}
