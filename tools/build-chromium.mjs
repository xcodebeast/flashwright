#!/usr/bin/env bun
import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { checkedChromiumNinja } from './chromium-build-common.mjs';

const usage = 'bun tools/build-chromium.mjs [--jobs=N] [--dry-run] <chromium-source> <output-directory> <target> [target...]';
const argumentsList = process.argv.slice(2);
if (argumentsList.length === 1 && argumentsList[0] === '--help') {
  console.log(`${usage}\n\nBuild and link explicit targets with the checkout's pinned Ninja 1.12.1.\nDefaults to at most eight compiler jobs. Serialize builds in each output directory.\n--dry-run lists pending work; Ninja may still update build metadata.`);
  process.exit(0);
}
let jobs = Math.min(8, availableParallelism());
let dryRun = false;
const seenOptions = new Set();
while (argumentsList[0]?.startsWith('--')) {
  const argument = argumentsList.shift();
  const option = argument.split('=')[0];
  if (seenOptions.has(option)) throw new Error(usage);
  seenOptions.add(option);
  if (argument === '--dry-run') dryRun = true;
  else if (/^--jobs=[1-9][0-9]*$/.test(argument) && Number.isSafeInteger(Number(argument.slice(7)))) jobs = Number(argument.slice(7));
  else throw new Error(usage);
}
if (argumentsList.length < 3) throw new Error(usage);
const sourceDirectory = realpathSync(argumentsList[0]);
const outputDirectory = realpathSync(resolve(sourceDirectory, argumentsList[1]));
const outputRelative = relative(sourceDirectory, outputDirectory);
if (!outputRelative || outputRelative === '..' || outputRelative.startsWith(`..${sep}`) || isAbsolute(outputRelative) ||
    !existsSync(resolve(outputDirectory, 'build.ninja'))) {
  throw new Error('Configure an output directory inside the Chromium checkout first.');
}
const targets = [...new Set(argumentsList.slice(2))];
if (targets.some(target => !target || target.startsWith('-') || /[\r\n\0]/.test(target))) throw new Error(usage);
const ninja = checkedChromiumNinja(sourceDirectory);
const result = spawnSync(ninja, ['-C', outputDirectory, `-j${jobs}`, ...(dryRun ? ['-n'] : []), '--', ...targets], {
  cwd: sourceDirectory, stdio: 'inherit',
});
if (result.error) throw result.error;
if (result.signal) process.kill(process.pid, result.signal);
else process.exit(result.status ?? 1);
