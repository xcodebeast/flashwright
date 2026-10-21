import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';

test('native TypeScript loading resolves relative helpers without changing missing-module failures', async () => {
  const directory = await mkdtemp(resolve('workbench/independent-loader-'));
  try {
    await writeFile(join(directory, 'package.json'), '{"type":"module"}');
    await mkdir(join(directory, 'nested'));
    await writeFile(join(directory, 'value.ts'), 'export const value: number = 42;');
    await writeFile(join(directory, 'nested/index.ts'), 'export default "nested";');
    await writeFile(join(directory, 'entry.ts'), `import { value } from './value'; import { value as mapped } from './value.js'; import nested from './nested'; export default {value, mapped, nested};`);
    await writeFile(join(directory, 'broken.ts'), `import './missing-source';`);
    await writeFile(join(directory, 'owner.cjs'), `
      const assert = require('node:assert/strict');
      require(${JSON.stringify(resolve('packages/flashwright-runner/dist/commonjs/independent/loader.js'))}).registerIndependentLoader();
      assert.deepEqual(require('./entry.ts').default, {value:42, mapped:42, nested:'nested'});
      assert.throws(() => require('./broken.ts'), /missing-source/);
      assert.equal(require('node:path').basename('/test/file'), 'file');
    `);
    execFileSync(process.execPath, [join(directory, 'owner.cjs')], { stdio: 'pipe' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
