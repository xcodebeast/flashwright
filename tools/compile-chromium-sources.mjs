#!/usr/bin/env bun
import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';

const usage = 'bun tools/compile-chromium-sources.mjs [--jobs=N] [--single-pass-ninja=PATH] <chromium-source> <output-directory> <source-file> [source-file...]';
const argumentsList = process.argv.slice(2);
if (argumentsList.length === 1 && argumentsList[0] === '--help') {
  console.log(`${usage}\n\nCompile every object for the named C/C++/Objective-C sources before a full build.\nPaths are relative to the Chromium source checkout. No executables are linked.\nSuccessful objects are reused by the next ordinary Ninja build.\nDefaults to at most eight compiler jobs; all independent errors are collected.\n--single-pass-ninja selects Ninja 1.12.1 with tools/chromium/ninja-compile-sources.patch.\nIt resolves all source variants after regeneration in one graph load.`);
  process.exit(0);
}
let jobs = Math.min(8, availableParallelism());
let singlePassNinja;
const seenOptions = new Set();
while (argumentsList[0]?.startsWith('--')) {
  const argument = argumentsList.shift();
  const separator = argument.indexOf('=');
  const option = argument.slice(0, separator);
  const value = argument.slice(separator + 1);
  if (separator < 0 || !value || seenOptions.has(option)) throw new Error(usage);
  seenOptions.add(option);
  if (option === '--jobs') {
    if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))) {
      throw new Error('--jobs must be a positive integer.');
    }
    jobs = Number(value);
  } else if (option === '--single-pass-ninja') {
    singlePassNinja = realpathSync(value);
  } else {
    throw new Error(usage);
  }
}
if (argumentsList.length < 3) throw new Error(usage);
const sourceDirectory = realpathSync(argumentsList[0]);
const outputDirectory = realpathSync(resolve(sourceDirectory, argumentsList[1]));

function isInside(directory, path) {
  const name = relative(directory, path);
  return name !== '' && name !== '..' && !name.startsWith(`..${sep}`) && !isAbsolute(name);
}

if (!isInside(sourceDirectory, outputDirectory) || !existsSync(resolve(outputDirectory, 'build.ninja'))) {
  throw new Error('Configure an output directory inside the Chromium checkout first.');
}
const ninja = singlePassNinja ?? resolve(sourceDirectory, 'third_party/ninja', process.platform === 'win32' ? 'ninja.exe' : 'ninja');
if (!existsSync(ninja)) throw new Error('The checkout must provide its pinned Ninja executable.');
if (singlePassNinja) {
  // Check outside the output directory: even a dry run with an incompatible
  // Ninja can discard the existing build log before compiling anything.
  const version = spawnSync(ninja, ['--version'], {
    cwd: sourceDirectory, encoding: 'utf8', timeout: 5000, maxBuffer: 4096,
  });
  if (version.error) throw version.error;
  if (version.status !== 0 || version.stdout.trim() !== '1.12.1') {
    throw new Error('--single-pass-ninja requires patched Ninja 1.12.1; refusing to open build metadata with this executable.');
  }
}
const sources = [...new Set(argumentsList.slice(2).map(name => {
  const path = realpathSync(resolve(sourceDirectory, name));
  if (!isInside(sourceDirectory, path) || isInside(outputDirectory, path) ||
      !['.c', '.cc', '.cpp', '.cxx', '.m', '.mm'].includes(extname(path)) || /[\r\n]/.test(path)) {
    throw new Error(`Expected a C/C++/Objective-C source inside the checkout: ${name}`);
  }
  return relative(outputDirectory, path).split(sep).join('/');
}))];

function runNinja(argumentsList, capture = false) {
  const result = spawnSync(ninja, ['-C', outputDirectory, ...argumentsList], {
    cwd: sourceDirectory, stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
  return result.stdout;
}

// Refresh GN's manifest before querying: an edited BUILD.gn may add another
// compilation of the same source with different flags or a different toolchain.
if (singlePassNinja) {
  runNinja([`-j${jobs}`, '-k0', '--compile-sources', ...sources]);
  process.exit(0);
}
runNinja([`-j${jobs}`, 'build.ninja']);
const query = runNinja(['-t', 'query', ...sources], true);
const objectsBySource = new Map(sources.map(source => [source, new Set()]));
let currentSource;
let readingOutputs = false;
for (const line of query.split('\n')) {
  if (line && !line.startsWith(' ')) {
    currentSource = objectsBySource.get(line.slice(0, -1));
    readingOutputs = false;
  } else if (line.startsWith('  ') && !line.startsWith('    ')) {
    readingOutputs = line === '  outputs:';
  } else if (readingOutputs && currentSource && line.startsWith('    ')) {
    const output = line.slice(4);
    if (['.o', '.obj'].includes(extname(output))) currentSource.add(output);
  }
}
for (const [source, objects] of objectsBySource) {
  if (!objects.size) throw new Error(`No compiled objects in the selected graph for ${source}`);
}
const objects = [...new Set([...objectsBySource.values()].flatMap(outputs => [...outputs]))].sort();
console.log(`Compiling ${objects.length} objects from ${sources.length} sources with ${jobs} jobs.`);
runNinja([`-j${jobs}`, '-k0', ...objects]);
