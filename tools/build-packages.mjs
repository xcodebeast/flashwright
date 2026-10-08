import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, copyFile, writeFile, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

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
  const exports = names.map(name => `export const ${name} = runtime.${name};`);
  if (hasDefault) exports.push('export default runtime.default;');
  await mkdir(`${packageDirectory}/dist/esm`, { recursive: true });
  await writeFile(`${packageDirectory}/dist/esm/${entry}.js`, `import runtime from '../commonjs/${entry}.js';\n${exports.join('\n')}\n`);
  await writeFile(`${packageDirectory}/dist/esm/${entry}.d.ts`, `export * from '../commonjs/${entry}.js';\n${hasDefault ? `export { default } from '../commonjs/${entry}.js';\n` : ''}`);
}

for (const name of ['flashwright', 'flashwright-test']) {
  const packageDirectory = `packages/${name}`;
  const destination = `${packageDirectory}/dist/commonjs`;
  await rm(`${packageDirectory}/dist`, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  execFileSync(process.execPath, [compiler, '--project', `${packageDirectory}/tsconfig.json`, '--outDir', destination, '--module', 'CommonJS', '--moduleResolution', 'Node'], { stdio: 'inherit' });
  await writeFile(`${destination}/package.json`, '{"type":"commonjs"}\n');
  if (name === 'flashwright') {
    await copyFile('packages/resident-runtime/serialization.cjs', `${destination}/serialization.cjs`);
    for (const source of ['serialization.d.cts', 'url-match.cjs', 'url-match.d.cts', 'runtime-version.d.cts']) {
      await copyFile(`${packageDirectory}/src/${source}`, `${destination}/${source}`);
    }
    await writeFile(`${destination}/runtime-version.cjs`, `exports.residentRuntimeSha256 = '${runtimeHash}';\n`);
  }
  await writeModuleFacade(packageDirectory, 'index');
  if (name === 'flashwright-test') await writeModuleFacade(packageDirectory, 'reporter');
  for (const notice of ['LICENSE.playwright', 'NOTICE.playwright', 'LICENSE.node-types']) await copyFile(`compatibility/upstream/${notice}`, `${packageDirectory}/dist/${notice}`);
}
