#!/usr/bin/env node
// Publishes the next Flashwright version of the three npm packages from a clean checkout of main:
//
//   1. checks that main is clean and pushed, and that npm is logged in,
//   2. picks the next version: <upstream version>-flashwright.<n + 1>, from what npm already has,
//   3. builds from scratch, packs (pack.mjs) and runs bench/consumer-test.mjs on the tarballs,
//   4. asks for confirmation, publishes flashwright-core, flashwright and flashwright-test in that
//      order as `latest`, then tags the commit v<version> and pushes the tag.
//
// Usage: npm run release -- [--dry-run] [--version <version>] [--skip-build] [--skip-check] [--yes] [--otp <code>]
// --dry-run does everything up to the publish, which it runs with `npm publish --dry-run`.
// Re-running after a failed publish continues: packages already on npm at that version are skipped.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';

const root = path.resolve(import.meta.dirname, '..', '..');
const argValue = name => {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
};
const flag = name => process.argv.includes(name);
const dryRun = flag('--dry-run');
const otp = argValue('--otp');
const packages = ['flashwright-core', 'flashwright', 'flashwright-test'];

const run = (command, args, options = {}) => execFileSync(command, args, { cwd: root, stdio: 'inherit', ...options });
const read = (command, args) => execFileSync(command, args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const fail = message => {
  console.error(`\n${message}`);
  process.exit(1);
};
const step = message => console.log(`\n== ${message}`);

step('Checking the repository and npm');
if (read('git', ['branch', '--show-current']) !== 'main')
  fail('Release from main.');
if (read('git', ['status', '--porcelain', '--untracked-files=no']))
  fail('Commit or stash your changes first: the packages are built from the working tree.');
run('git', ['fetch', '--quiet', 'origin', 'main']);
if (read('git', ['rev-parse', 'HEAD']) !== read('git', ['rev-parse', 'origin/main']))
  fail('main and origin/main differ: push or pull first, so that the published code is on GitHub.');
let user;
try {
  user = read('npm', ['whoami']);
} catch {
  if (!dryRun)
    fail('Not logged in to npm: run `npm login` first.');
}

const upstreamVersion = JSON.parse(fs.readFileSync(path.join(root, 'packages/playwright-core/package.json'), 'utf8')).version;
const published = name => {
  try {
    const versions = JSON.parse(read('npm', ['view', name, 'versions', '--json']));
    return Array.isArray(versions) ? versions : [versions];
  } catch {
    return [];
  }
};
const publishedVersions = Object.fromEntries(packages.map(name => [name, published(name)]));
let version = argValue('--version');
if (!version) {
  const pattern = new RegExp(`^${upstreamVersion.replace(/\./g, '\\.')}-flashwright\\.(\\d+)$`);
  const numbers = Object.values(publishedVersions).flat().map(v => pattern.exec(v)?.[1]).filter(Boolean).map(Number);
  version = `${upstreamVersion}-flashwright.${Math.max(0, ...numbers) + 1}`;
}
const toPublish = packages.filter(name => !publishedVersions[name].includes(version));
if (!toPublish.length)
  fail(`${version} is already published for all three packages.`);
const tag = `v${version}`;
console.log(`Version ${version}${user ? `, npm user ${user}` : ''}`);

if (!flag('--skip-build')) {
  step('Building from scratch');
  run('npm', ['run', 'clean']);
  run('npm', ['run', 'build']);
}

step('Packing');
run(process.execPath, [path.join(root, 'utils/flashwright/pack.mjs'), '--version', version]);
const { tarballs } = JSON.parse(fs.readFileSync(path.join(root, 'workbench/npm/tarballs.json'), 'utf8'));

if (!flag('--skip-check')) {
  step('Installing the tarballs into a fresh project and running the TodoMVC suite');
  run(process.execPath, [path.join(root, 'bench/consumer-test.mjs'), '--npm']);
}

if (!dryRun && !flag('--yes')) {
  if (!process.stdin.isTTY)
    fail('Pass --yes to publish without a terminal.');
  const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await prompt.question(`\nPublish ${toPublish.map(name => `${name}@${version}`).join(', ')} to npm as latest, then tag and push ${tag}? [y/N] `);
  prompt.close();
  if (!/^y(es)?$/i.test(answer.trim()))
    fail('Nothing was published.');
}

step(dryRun ? 'Publishing (dry run)' : 'Publishing');
// Each package depends on the one before it at this exact version.
for (const name of toPublish)
  run('npm', ['publish', tarballs[name], '--tag', 'latest', '--access', 'public', ...(otp ? ['--otp', otp] : []), ...(dryRun ? ['--dry-run'] : [])]);
if (dryRun) {
  console.log(`\nDry run done: ${version} would be published. Run without --dry-run to publish.`);
  process.exit(0);
}

step(`Tagging ${tag}`);
if (!read('git', ['tag', '--list', tag]))
  run('git', ['tag', '-a', tag, '-m', `Flashwright ${version}`]);
run('git', ['push', 'origin', tag]);

console.log(`\nPublished ${version}. Check the registry install with: node bench/consumer-test.mjs --registry`);
