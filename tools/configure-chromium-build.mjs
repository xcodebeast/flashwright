#!/usr/bin/env bun
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

const usage = 'bun tools/configure-chromium-build.mjs [--regular-archives] <chromium-source> <output-directory> <GN-target> [GN-target...]';
const argumentsList = process.argv.slice(2);
if (argumentsList.length === 1 && argumentsList[0] === '--help') {
  console.log(`${usage}\n\nGenerate a focused build graph for the selected targets and all their dependencies.\nThe output directory must already contain args.gn. Compiler settings stay unchanged.\n--regular-archives requires tools/chromium/macos-regular-archives.patch and macOS/lld.\nIt selects executable libraries while preserving build-tool dependencies as thin archives.`);
  process.exit(0);
}
const regularArchives = argumentsList[0] === '--regular-archives';
if (regularArchives) argumentsList.shift();
if (argumentsList.length < 3) throw new Error(usage);

const sourceDirectory = realpathSync(argumentsList[0]);
const outputDirectory = realpathSync(resolve(sourceDirectory, argumentsList[1]));
const relativeOutput = relative(sourceDirectory, outputDirectory);
if (!relativeOutput || relativeOutput === '..' || relativeOutput.startsWith(`..${sep}`) || isAbsolute(relativeOutput)) {
  throw new Error('The output directory must be inside the Chromium source checkout.');
}
if (!existsSync(resolve(outputDirectory, 'args.gn'))) {
  throw new Error('Create args.gn with the intended compiler configuration before generating the graph.');
}

const targets = [...new Set(argumentsList.slice(2))];
for (const target of targets) {
  if (!/^\/\/[A-Za-z0-9_./-]*:[A-Za-z0-9_.-]+$/.test(target)) {
    throw new Error(`Expected an explicit GN target such as //headless:headless_shell: ${target}`);
  }
}
const executable = resolve(sourceDirectory, 'buildtools', process.platform === 'darwin' ? 'mac' : 'linux64', 'gn');
if (!['darwin', 'linux'].includes(process.platform) || !existsSync(executable)) {
  throw new Error('The checkout must provide its pinned GN executable for this host.');
}
if (regularArchives && (process.platform !== 'darwin' ||
    !readFileSync(resolve(sourceDirectory, 'build/config/BUILDCONFIG.gn'), 'utf8').includes('flashwright_regular_archive_targets'))) {
  throw new Error('Regular archives require macOS and the supplied macos-regular-archives.patch applied to Chromium.');
}

const entryPoint = resolve(sourceDirectory, 'flashwright_development/BUILD.gn');
const contents = [
  '# Private development entry point. Browser capabilities remain defined upstream.',
  'group("all") {',
  '  testonly = true',
  '  deps = [',
  ...targets.map((target) => `    "${target}",`),
  '  ]',
  '}',
  '',
].join('\n');

// Refuse to overwrite another configuration; automatic GN regeneration uses this file.
if (existsSync(entryPoint) && readFileSync(entryPoint, 'utf8') !== contents) {
  throw new Error(`The development entry point already contains different targets: ${entryPoint}`);
}
if (!existsSync(entryPoint)) {
  mkdirSync(dirname(entryPoint), { recursive: true });
  writeFileSync(entryPoint, contents, { flag: 'wx' });
}

const graphArguments = [
  `--root=${sourceDirectory}`,
  '--root-target=//flashwright_development',
  '--root-pattern=//flashwright_development:all',
];

function runGn(command, capture = false) {
  const result = spawnSync(executable, [...command, ...graphArguments], {
    cwd: sourceDirectory, stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`GN ${command[0]} failed with status ${result.status}`);
  return result.stdout;
}

function collectDependencies(startingTargets, graph) {
  const visited = new Set();
  const pending = [...startingTargets];
  while (pending.length) {
    const target = pending.pop();
    if (visited.has(target)) continue;
    visited.add(target);
    const entry = graph[target];
    if (!entry) throw new Error(`Missing dependency information for ${target}`);
    pending.push(...entry.deps);
  }
  return visited;
}

runGn(['gen', outputDirectory]);
if (regularArchives) {
  const graph = JSON.parse(runGn(['desc', outputDirectory, '*', 'deps', '--format=json'], true));
  const listTargets = (type) => runGn(['ls', outputDirectory, '*', `--type=${type}`], true).trim().split('\n').filter(Boolean);
  const executables = listTargets('executable');
  for (const target of targets) {
    if (!executables.includes(target)) throw new Error(`Regular archives require explicit executable targets: ${target}`);
  }
  const selectedDependencies = collectDependencies(targets, graph);
  // Relinking generators can rewrite thousands of generated headers even when code is unchanged.
  const generatorDependencies = collectDependencies(executables.filter(target => !targets.includes(target)), graph);
  const archives = listTargets('static_library').filter(target =>
    !target.includes('(') && selectedDependencies.has(target) && !generatorDependencies.has(target)).sort();
  const policyPath = resolve(sourceDirectory, 'flashwright_development/archives.gni');
  const policy = [
    '# Generated from the selected graph. Build-tool dependencies remain thin archives.',
    'flashwright_regular_archive_targets = [',
    ...archives.map(target => `  "${target}",`),
    ']', '',
  ].join('\n');
  if (!existsSync(policyPath) || readFileSync(policyPath, 'utf8') !== policy) {
    writeFileSync(policyPath, policy);
    runGn(['gen', outputDirectory]);
  }
  console.log(`Selected ${archives.length} regular archives; preserved dependencies of ${executables.length - targets.length} build executables.`);
}
