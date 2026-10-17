#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const usage = 'bun tools/test-chromium-build-tools.mjs <chromium-source> [single-pass-ninja]';
if (process.argv[2] === '--help') {
  console.log(`${usage}\n\nExercise the build helpers with real GN, Ninja and Clang in a tiny private fixture.\nThe Chromium checkout is read only. Logs remain in workbench; successful fixture outputs are removed.`);
  process.exit(0);
}
if (![3, 4].includes(process.argv.length) || !['darwin', 'linux'].includes(process.platform)) throw new Error(usage);
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const chromium = realpathSync(process.argv[2]);
const singlePassNinja = process.argv[3] && realpathSync(process.argv[3]);
const gnHost = process.platform === 'darwin' ? 'mac' : 'linux64';
const executables = {
  gn: resolve(chromium, `buildtools/${gnHost}/gn`),
  ninja: resolve(chromium, 'third_party/ninja/ninja'),
  compiler: resolve(chromium, 'third_party/llvm-build/Release+Asserts/bin/clang++'),
};
for (const executable of Object.values(executables)) assert.ok(existsSync(executable), executable);
mkdirSync(resolve(repository, 'workbench'), { recursive: true });
const run = mkdtempSync(resolve(repository, 'workbench/chromium-build-tools-'));
const fixture = resolve(run, 'fixture with spaces');
const compileFixture = resolve(fixture, 'compile');
const graphFixture = resolve(fixture, 'graph');

function write(path, contents) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

function link(path, destination) {
  mkdirSync(dirname(path), { recursive: true });
  symlinkSync(destination, path);
}

function invokeCommand(label, executable, argumentsList, succeeds = true, cwd) {
  const result = spawnSync(executable, argumentsList, {
    cwd, encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024,
  });
  write(resolve(run, `${label}.stdout`), result.stdout ?? '');
  write(resolve(run, `${label}.stderr`), result.stderr ?? '');
  if (result.error) throw result.error;
  assert.equal(result.status === 0, succeeds, `${label}: ${result.stdout}\n${result.stderr}`);
  return `${result.stdout}\n${result.stderr}`;
}

function invoke(label, helper, argumentsList, succeeds = true) {
  return invokeCommand(label, process.execPath, [resolve(repository, 'tools', helper), ...argumentsList], succeeds);
}

function verifyCompilation() {
  const output = resolve(compileFixture, 'out/development');
  link(resolve(compileFixture, 'third_party/ninja/ninja'), executables.ninja);
  link(resolve(compileFixture, 'compiler'), executables.compiler);
  write(resolve(compileFixture, 'shared input.cc'), '#include "value.h"\nint value() { return VALUE + HEADER_VALUE; }\n');
  write(resolve(compileFixture, 'value.h'), '#define HEADER_VALUE 1\n');
  write(resolve(compileFixture, 'first.cc'), '#error first_independent_error\n');
  write(resolve(compileFixture, 'second.cc'), '#error second_independent_error\n');
  write(resolve(compileFixture, 'unused.cc'), 'int unused;\n');
  write(resolve(compileFixture, 'no-object.cc'), 'int no_object;\n');
  write(resolve(compileFixture, 'generated-input.cc'), '#include "out/development/generated.h"\nint generated() { return GENERATED_VALUE; }\n');
  write(resolve(compileFixture, 'generator-input.json'), '{"value":1}\n');
  write(resolve(compileFixture, 'generate.mjs'),
    `import { readFileSync, writeFileSync } from 'node:fs';\nwriteFileSync('generated.h', '#define GENERATED_VALUE ' + JSON.parse(readFileSync('../../generator-input.json')).value + '\\n');\n`);
  const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`;
  const manifest = `rule compile
  command = ../../compiler -DVALUE=$value -MMD -MF $out.d -c $in -o $out
  depfile = $out.d
  deps = gcc
rule link
  command = false
rule generate
  command = ${shellQuote(process.execPath).replaceAll('$', '$$')} ../../generate.mjs
  restat = 1
rule regenerate
  command = ${shellQuote(process.execPath).replaceAll('$', '$$')} ../../regenerate.mjs
  generator = 1
  restat = 1
build build.ninja: regenerate ../../definition.json
build first.o: compile ../../shared$ input.cc
  value = 1
build second$ variant.o: compile ../../shared$ input.cc
  value = 2
build error-first.o: compile ../../first.cc
build error-second.o: compile ../../second.cc
build generated.h: generate ../../generator-input.json
build generated.o: compile ../../generated-input.cc || generated.h
build non-object: phony ../../no-object.cc
build executable: link first.o second$ variant.o
`;
  // The second variant exists only after regeneration; querying too early misses it.
  write(resolve(output, 'build.ninja'), manifest
    .replace('build second$ variant.o: compile ../../shared$ input.cc\n  value = 2\n', '')
    .replace('first.o second$ variant.o', 'first.o'));
  write(resolve(compileFixture, 'regenerate.mjs'),
    `import { readFileSync, writeFileSync } from 'node:fs';\nwriteFileSync('build.ninja', JSON.parse(readFileSync('../../definition.json')).manifest);\n`);
  const define = contents => write(resolve(compileFixture, 'definition.json'), JSON.stringify({ manifest: contents }));
  define(manifest);
  utimesSync(resolve(output, 'build.ninja'), new Date(0), new Date(0));
  const argumentsList = ['--jobs=2', ...(singlePassNinja ? [`--single-pass-ninja=${singlePassNinja}`] : []), compileFixture, 'out/development'];
  const compile = (label, sources, succeeds) => invoke(label, 'compile-chromium-sources.mjs', [...argumentsList, ...sources], succeeds);
  assert.match(compile('compile-first', ['shared input.cc']), /Compiling 2 objects from 1 sources/);
  const objects = ['first.o', 'second variant.o'].map(name => resolve(output, name));
  assert.notDeepEqual(readFileSync(objects[0]), readFileSync(objects[1]));
  assert.equal(existsSync(resolve(output, 'executable')), false);
  const modified = objects.map(path => statSync(path, { bigint: true }).mtimeNs);
  const buildLog = resolve(output, '.ninja_log');
  const logBefore = readFileSync(buildLog);
  const logTimeBefore = statSync(buildLog, { bigint: true }).mtimeNs;
  for (const [label, version, status] of [['wrong-version', '1.13.2', 0], ['failed-version', '1.12.1', 1]]) {
    const override = resolve(compileFixture, `${label}-ninja`);
    const calls = resolve(compileFixture, `${label}-calls`);
    write(override, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${shellQuote(calls)}\nif [ "$#" = 1 ] && [ "$1" = --version ]; then\n  printf '%s\\n' '${version}'\n  exit ${status}\nfi\nrm -f ${shellQuote(buildLog)}\nexit 1\n`);
    chmodSync(override, 0o755);
    const rejected = invoke(`compile-${label}`, 'compile-chromium-sources.mjs',
      [`--single-pass-ninja=${override}`, compileFixture, 'out/development', 'shared input.cc'], false);
    assert.match(rejected, /refusing to open build metadata/);
    assert.equal(readFileSync(calls, 'utf8'), '--version\n');
    assert.deepEqual(readFileSync(buildLog), logBefore);
    assert.equal(statSync(buildLog, { bigint: true }).mtimeNs, logTimeBefore);
    assert.deepEqual(objects.map(path => statSync(path, { bigint: true }).mtimeNs), modified);
  }
  compile('compile-unchanged', ['shared input.cc', 'shared input.cc']);
  assert.deepEqual(objects.map(path => statSync(path, { bigint: true }).mtimeNs), modified);
  write(resolve(compileFixture, 'value.h'), '#define HEADER_VALUE 2\n');
  compile('compile-header-changed', ['shared input.cc']);
  assert.ok(objects.every((path, index) => statSync(path, { bigint: true }).mtimeNs > modified[index]));
  const expanded = manifest + 'build other$ toolchain/third.obj: compile ../../shared$ input.cc\n  value = 3\n';
  define(expanded);
  assert.match(compile('compile-variant-added', ['shared input.cc']), /Compiling 3 objects from 1 sources/);
  assert.ok(existsSync(resolve(output, 'other toolchain/third.obj')));
  const reduced = expanded.replace('build first.o: compile ../../shared$ input.cc\n  value = 1\n', '')
    .replace('link first.o second$ variant.o', 'link second$ variant.o');
  define(reduced);
  assert.match(compile('compile-variant-removed', ['shared input.cc']), /Compiling 2 objects from 1 sources/);
  const beforeFailure = objects.map(path => statSync(path, { bigint: true }).mtimeNs);
  write(resolve(compileFixture, 'definition.json'), 'invalid JSON');
  assert.match(compile('compile-regeneration-fails', ['shared input.cc'], false), /rebuilding 'build.ninja'/);
  assert.deepEqual(objects.map(path => statSync(path, { bigint: true }).mtimeNs), beforeFailure);
  define(reduced);
  compile('compile-regeneration-recovers', ['shared input.cc']);
  const activeObjects = [objects[1], resolve(output, 'other toolchain/third.obj')];
  const beforePartialFailure = activeObjects.map(path => statSync(path, { bigint: true }).mtimeNs);
  write(resolve(compileFixture, 'shared input.cc'), '#include "value.h"\nint value() { return VALUE + HEADER_VALUE + 1; }\n');
  const errors = compile('compile-errors', ['first.cc', 'second.cc', 'shared input.cc'], false);
  assert.match(errors, /first_independent_error/);
  assert.match(errors, /second_independent_error/);
  const afterPartialFailure = activeObjects.map(path => statSync(path, { bigint: true }).mtimeNs);
  assert.ok(afterPartialFailure.every((time, index) => time > beforePartialFailure[index]));
  const ordinary = (label, succeeds = true) => invokeCommand(label, executables.ninja,
    ['-C', output, '-j2', 'second variant.o', 'other toolchain/third.obj'], succeeds, compileFixture);
  assert.match(ordinary('compile-ordinary-reuse'), /no work to do/);
  assert.deepEqual(activeObjects.map(path => statSync(path, { bigint: true }).mtimeNs), afterPartialFailure);
  write(resolve(compileFixture, 'value.h'), '#define HEADER_VALUE 3\n');
  ordinary('compile-ordinary-header-change');
  assert.ok(activeObjects.every((path, index) => statSync(path, { bigint: true }).mtimeNs > afterPartialFailure[index]));
  compile('compile-generated-prerequisite', ['generated-input.cc']);
  const generatedObject = resolve(output, 'generated.o');
  const generatedModified = statSync(generatedObject, { bigint: true }).mtimeNs;
  write(resolve(compileFixture, 'generator-input.json'), 'invalid JSON');
  write(resolve(compileFixture, 'generated-input.cc'), '#include "out/development/generated.h"\nint generated() { return GENERATED_VALUE + 1; }\n');
  compile('compile-prerequisite-failure', ['generated-input.cc'], false);
  assert.equal(statSync(generatedObject, { bigint: true }).mtimeNs, generatedModified);
  assert.match(compile('compile-no-object', ['no-object.cc'], false), /No compiled objects/);
  assert.match(compile('compile-unselected', ['unused.cc'], false), /unknown target.*unused\.cc/);
  const outside = resolve(fixture, 'outside.cc');
  write(outside, 'int outside;\n');
  assert.match(compile('compile-outside', [outside], false), /source inside the checkout/);
}

function verifyConfiguration() {
  link(resolve(graphFixture, `buildtools/${gnHost}/gn`), executables.gn);
  write(resolve(graphFixture, '.gn'), 'buildconfig = "//build/config/BUILDCONFIG.gn"\n');
  write(resolve(graphFixture, 'build/config/BUILDCONFIG.gn'),
    'set_default_toolchain("//:toolchain")\n# flashwright_regular_archive_targets\n');
  const argumentsPath = resolve(graphFixture, 'out/development/args.gn');
  write(argumentsPath, '# Existing compiler configuration must survive.\n');
  write(resolve(graphFixture, 'empty.cc'), 'int value;\n');
  write(resolve(graphFixture, 'generate.py'), '');
  write(resolve(graphFixture, 'BUILD.gn'), `toolchain("toolchain") {
  tool("cxx") {
    command = "c++ -c {{source}} -o {{output}}"
    outputs = [ "{{source_out_dir}}/{{target_output_name}}.{{source_name_part}}.o" ]
  }
  tool("alink") {
    command = "ar rcs {{output}} {{inputs}}"
    outputs = [ "{{target_out_dir}}/{{target_output_name}}.a" ]
  }
  tool("link") {
    command = "c++ {{inputs}} -o {{output}}"
    outputs = [ "{{root_out_dir}}/{{target_output_name}}" ]
  }
  tool("stamp") { command = "touch {{output}}" }
  tool("copy") { command = "cp {{source}} {{output}}" }
}
static_library("runtime") { sources = [ "empty.cc" ] }
static_library("shared") { sources = [ "empty.cc" ] }
static_library("generator_support") { sources = [ "empty.cc" ] }
executable("generator") { deps = [ ":shared", ":generator_support" ] }
action("generated") {
  script = "generate.py"
  outputs = [ "$target_gen_dir/generated.h" ]
  deps = [ ":generator" ]
}
executable("application") { deps = [ ":runtime", ":shared", ":generated" ] }
executable("tests") { deps = [ ":runtime", ":shared" ] }
`);
  const argumentsBefore = readFileSync(argumentsPath);
  const options = process.platform === 'darwin' ? ['--regular-archives'] : [];
  const configure = (label, targets, succeeds) => invoke(label, 'configure-chromium-build.mjs',
    [...options, graphFixture, 'out/development', ...targets], succeeds);
  const generationCount = output => (output.match(/Done\. Made /g) ?? []).length;
  const first = configure('configure-first', ['//:application', '//:tests']);
  assert.equal(generationCount(first), process.platform === 'darwin' ? 2 : 1);
  const entryPoint = resolve(graphFixture, 'flashwright_development/BUILD.gn');
  const policyPath = resolve(graphFixture, 'flashwright_development/archives.gni');
  const observed = process.platform === 'darwin' ? policyPath : entryPoint;
  const contents = readFileSync(observed, 'utf8');
  const modified = statSync(observed, { bigint: true }).mtimeNs;
  if (process.platform === 'darwin') {
    assert.match(contents, /"\/\/:runtime"/);
    assert.doesNotMatch(contents, /"\/\/:(shared|generator_support)"/);
  }
  const unchanged = configure('configure-unchanged', ['//:application', '//:tests']);
  assert.equal(generationCount(unchanged), 1);
  assert.deepEqual(readFileSync(argumentsPath), argumentsBefore);
  assert.equal(statSync(observed, { bigint: true }).mtimeNs, modified);
  assert.match(configure('configure-reject', ['//:application', '//:missing'], false), /different targets/);
  assert.equal(readFileSync(observed, 'utf8'), contents);
  if (process.platform === 'darwin') {
    const definition = resolve(graphFixture, 'BUILD.gn');
    write(definition, readFileSync(definition, 'utf8')
      .replace('deps = [ ":runtime", ":shared" ]', 'deps = [ ":runtime", ":shared", ":additional_runtime" ]') +
      '\nstatic_library("additional_runtime") { sources = [ "empty.cc" ] }\n');
    const changed = configure('configure-dependencies-changed', ['//:application', '//:tests']);
    assert.equal(generationCount(changed), 2);
    const updatedPolicy = readFileSync(policyPath, 'utf8');
    assert.match(updatedPolicy, /"\/\/:additional_runtime"/);
    assert.doesNotMatch(updatedPolicy, /"\/\/:(shared|generator_support)"/);
    const repeated = configure('configure-updated-unchanged', ['//:application', '//:tests']);
    assert.equal(generationCount(repeated), 1);
    assert.deepEqual(readFileSync(argumentsPath), argumentsBefore);
  }
}

verifyCompilation();
verifyConfiguration();
const helperHashes = Object.fromEntries(['compile-chromium-sources.mjs', 'configure-chromium-build.mjs'].map(name =>
  [name, createHash('sha256').update(readFileSync(resolve(repository, 'tools', name))).digest('hex')]));
write(resolve(run, 'result.json'), JSON.stringify({
  status: 'passed', platform: process.platform, helperHashes,
  singlePassNinjaSha256: singlePassNinja && createHash('sha256').update(readFileSync(singlePassNinja)).digest('hex'),
  checks: ['regeneration-before-query', 'multiple-source-variants', 'paths-with-spaces', 'no-link',
    'incompatible-override-rejected-before-metadata-access', 'failed-version-query-rejected-before-metadata-access',
    'unchanged-object-reuse', 'independent-errors', 'unselected-and-outside-source-rejection',
    'discovered-header-dependencies', 'variant-added-after-warm-build', 'removed-variant-not-selected',
    'regeneration-failure-before-compilation', 'regeneration-recovery',
    'successful-objects-survive-partial-failure', 'ordinary-ninja-reuses-objects',
    'ordinary-ninja-discovers-header-change', 'generated-prerequisite',
    'prerequisite-failure-blocks-compilation', 'known-source-without-object-rejected',
    'preserved-args', 'stable-configuration', 'different-root-rejection',
    'single-generation-for-unchanged-policy',
    ...(process.platform === 'darwin' ? ['regeneration-for-changed-archive-dependencies'] : [])],
  archiveDependencyExclusions: process.platform === 'darwin' ? 'passed' : 'not-applicable',
}, null, 2) + '\n');
rmSync(fixture, { recursive: true });
console.log(`Build helper checks passed. Logs: ${relative(repository, run)}`);
