import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, copyFile, writeFile, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { buildRunnerRuntime } from './build-runner-runtime.mjs';

const require = createRequire(import.meta.url);
const compiler = require.resolve('typescript/bin/tsc');
const runtimeDigest = createHash('sha256');
const runtimeSources = (await readFile('packages/resident-runtime/sources.txt', 'utf8')).trimEnd().split('\n');
for (const name of runtimeSources) {
  const source = await readFile(`packages/resident-runtime/${name}`);
  const length = Buffer.alloc(8); length.writeBigUInt64LE(BigInt(source.length));
  runtimeDigest.update(length).update(source);
}
const runtimeHash = runtimeDigest.digest('hex');

/** ESM and CommonJS share both class identities and runner state in mixed consumers. */
async function writeModuleFacade(packageDirectory, entry) {
  const runtime = require(resolve(packageDirectory, 'dist/commonjs', `${entry}.js`));
  const names = Object.keys(runtime).filter(name => name !== '__esModule' && name !== 'default');
  if (names.some(name => !/^[a-zA-Z_$][\w$]*$/.test(name))) throw new Error('Invalid public export name');
  const hasDefault = Object.hasOwn(runtime, 'default');
  const defaultExportName = names.find(name => hasDefault && runtime[name] === runtime.default);
  if (hasDefault && !defaultExportName) throw new Error('A default export needs an explicit named declaration alias');
  const exports = names.map(name => `export const ${name} = runtime.${name};`);
  if (hasDefault) exports.push('export default runtime.default;');
  await mkdir(`${packageDirectory}/dist/esm`, { recursive: true });
  // Explicit require preserves the whole CommonJS export object on Node and Bun.
  await writeFile(`${packageDirectory}/dist/esm/${entry}.js`, `import { createRequire } from 'node:module';\nconst runtime = createRequire(import.meta.url)('../commonjs/${entry}.js');\n${exports.join('\n')}\n`);
  // A CommonJS default re-export is interpreted as its namespace by NodeNext.
  await writeFile(`${packageDirectory}/dist/esm/${entry}.d.ts`, `export * from '../commonjs/${entry}.js';\n${hasDefault ? `export { ${defaultExportName} as default } from '../commonjs/${entry}.js';\n` : ''}`);
}

async function writeNotices(packageDirectory) {
  for (const notice of ['LICENSE.playwright', 'NOTICE.playwright', 'LICENSE.node-types', 'LICENSE.mime']) await copyFile(`compatibility/upstream/${notice}`, `${packageDirectory}/dist/${notice}`);
}

for (const name of ['flashwright-core', 'flashwright-runner']) {
  const packageDirectory = `packages/${name}`;
  const destination = `${packageDirectory}/dist/commonjs`;
  await rm(`${packageDirectory}/dist`, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  if (name === 'flashwright-runner') await buildRunnerRuntime(`${packageDirectory}/dist/upstream`);
  execFileSync(process.execPath, [compiler, '--project', `${packageDirectory}/tsconfig.json`, '--outDir', destination, '--module', 'CommonJS', '--moduleResolution', 'Node'], { stdio: 'inherit' });
  await writeFile(`${destination}/package.json`, '{"type":"commonjs"}\n');
  if (name === 'flashwright-core') {
    await copyFile('packages/resident-runtime/serialization.cjs', `${destination}/serialization.cjs`);
    for (const source of ['serialization.d.cts', 'url-match.cjs', 'url-match.d.cts', 'runtime-version.d.cts']) {
      await copyFile(`${packageDirectory}/src/${source}`, `${destination}/${source}`);
    }
    await writeFile(`${destination}/runtime-version.cjs`, `exports.residentRuntimeSha256 = '${runtimeHash}';\n`);
  }
  await writeModuleFacade(packageDirectory, 'index');
  if (name === 'flashwright-core') await writeModuleFacade(packageDirectory, 'runner-integration');
  if (name === 'flashwright-runner') await writeModuleFacade(packageDirectory, 'reporter');
  await writeNotices(packageDirectory);
}

/** Aliased public packages are stateless facades over canonical implementation dependencies. */
for (const [name, implementation, entries] of [
  ['flashwright-test', '@flashwright/runner', ['index', 'reporter']],
  ['flashwright', '@flashwright/core', ['index']],
]) {
  const packageDirectory = `packages/${name}`;
  await rm(`${packageDirectory}/dist`, { recursive: true, force: true });
  await mkdir(`${packageDirectory}/dist/commonjs`, { recursive: true });
  await writeFile(`${packageDirectory}/dist/commonjs/package.json`, '{"type":"commonjs"}\n');
  for (const entry of entries) {
    const target = implementation + (entry === 'index' ? '' : `/${entry}`);
    await writeFile(`${packageDirectory}/dist/commonjs/${entry}.js`, `module.exports = require('${target}');\n`);
    const defaultDeclaration = Object.hasOwn(createRequire(resolve(packageDirectory, 'package.json'))(target), 'default') ? `export { test as default } from '${target}';\n` : '';
    await writeFile(`${packageDirectory}/dist/commonjs/${entry}.d.ts`, `export * from '${target}';\n${defaultDeclaration}`);
    await writeModuleFacade(packageDirectory, entry);
  }
  await writeNotices(packageDirectory);
}
await copyFile('packages/flashwright/test.cjs', 'packages/flashwright/dist/commonjs/test.js');
await writeFile('packages/flashwright/dist/commonjs/test.d.ts', "export * from '@flashwright/test';\nexport { test as default } from '@flashwright/test';\n");
await writeModuleFacade('packages/flashwright', 'test');
