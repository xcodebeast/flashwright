import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, join, resolve } from 'node:path';
import { verifyCompilerInputs } from './package-compiler.mjs';

const require = createRequire(import.meta.url);
const compiler = require.resolve('typescript/bin/tsc');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

/** Include every output, so removed, edited or unexpected artifacts invalidate reuse. */
function outputInventory(directory, prefix = '') {
  const files = {};
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    const name = prefix + entry.name;
    if (entry.isDirectory()) Object.assign(files, outputInventory(join(directory, entry.name), name + '/'));
    else {
      assert.ok(entry.isFile(), `Build output must be a regular file: ${name}`);
      files[name] = digest(readFileSync(join(directory, entry.name)));
    }
  }
  return files;
}

/** Reuse complete packages; changed packages use the original compiler with no partial emit state. */
export async function preparePackageBuild(packageDirectory, { clean = false } = {}) {
  const destination = resolve(packageDirectory, 'dist');
  const stateDirectory = resolve('workbench/package-build-state', basename(packageDirectory));
  const receiptPath = join(stateDirectory, 'outputs.json');
  const configurationPath = resolve(packageDirectory, 'tsconfig.json');
  const buildTools = {};
  for (const file of [compiler, require.resolve('typescript/lib/tsc.js'), require.resolve('typescript/lib/_tsc.js'), require.resolve('typescript'),
    'tools/build-packages.mjs', 'tools/build-runner-runtime.mjs', 'tools/incremental-package-build.mjs', 'tools/package-compiler.mjs']) {
    buildTools[file] = digest(await readFile(file));
  }
  const buildIdentity = digest(JSON.stringify({ buildTools, runtime: process.execPath, node: process.version, bun: process.versions.bun }));
  let reusable = false;
  let compilerInputs;
  let inputIdentity;
  if (!clean) {
    try {
      const previous = JSON.parse(await readFile(receiptPath, 'utf8'));
      assert.equal(previous.buildIdentity, buildIdentity);
      assert.equal(digest(JSON.stringify(previous.compilerInputs)), previous.inputIdentity);
      verifyCompilerInputs(previous.compilerInputs, configurationPath);
      assert.deepEqual(previous.outputs, outputInventory(destination));
      compilerInputs = previous.compilerInputs;
      inputIdentity = previous.inputIdentity;
      reusable = true;
    } catch {
      // A missing or interrupted build has no reusable output contract.
    }
  }
  await rm(receiptPath, { force: true });
  if (!reusable) {
    await rm(destination, { recursive: true, force: true });
    await rm(stateDirectory, { recursive: true, force: true });
  }
  await mkdir(stateDirectory, { recursive: true });
  await mkdir(join(destination, 'commonjs'), { recursive: true });
  return {
    async compile() {
      if (reusable) return;
      const tracePath = join(stateDirectory, 'compiler-inputs.json');
      execFileSync(process.execPath, ['tools/package-compiler.mjs', configurationPath,
        join(destination, 'commonjs'), tracePath], { stdio: 'inherit' });
      compilerInputs = JSON.parse(await readFile(tracePath, 'utf8'));
      inputIdentity = digest(JSON.stringify(compilerInputs));
      await rm(tracePath);
    },
    async complete() {
      // Keep the emitting compiler's observations: a later edit must invalidate the next build.
      await writeFile(receiptPath, JSON.stringify({ buildIdentity, inputIdentity, compilerInputs, outputs: outputInventory(destination) }));
    },
  };
}
