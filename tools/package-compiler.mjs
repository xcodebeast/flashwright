import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const typescript = createRequire(import.meta.url)('typescript');
const inputMethods = ['readFile', 'fileExists', 'directoryExists', 'getDirectories', 'readDirectory', 'realpath'];
const inputValue = (method, value) => method === 'readFile' && value !== undefined
  ? createHash('sha256').update(value).digest('hex') : value ?? null;

/** Replay the compiler's reads and resolution lookups without parsing its source graph again. */
export function verifyCompilerInputs(inputs, configurationPath) {
  assert.ok(Array.isArray(inputs) && inputs.length > 0);
  assert.ok(inputs.some(operation => operation.method === 'readFile' && resolve(operation.arguments[0]) === configurationPath));
  for (const operation of inputs) {
    assert.ok(inputMethods.includes(operation.method) && Array.isArray(operation.arguments));
    const value = typescript.sys[operation.method](...operation.arguments.map(value => value === null ? undefined : value));
    assert.deepEqual(inputValue(operation.method, value), operation.value, `Compiler input changed: ${operation.method} ${operation.arguments[0]}`);
  }
}

/** Run the pinned full compiler and retain the exact inputs it consumed, including missing lookups. */
export function compilePackage(configurationPath, destination, filesystem = typescript.sys) {
  const observations = new Map();
  let inconsistentRead = false;
  let exitCode;
  const system = { ...filesystem, exit: code => { exitCode = code; } };
  for (const method of inputMethods) {
    system[method] = (...argumentsList) => {
      const value = filesystem[method](...argumentsList);
      const operation = { method, arguments: argumentsList.map(value => value ?? null), value: inputValue(method, value) };
      const key = JSON.stringify([method, operation.arguments]);
      if (observations.has(key) && JSON.stringify(observations.get(key)) !== JSON.stringify(operation)) inconsistentRead = true;
      observations.set(key, operation);
      return value;
    };
  }
  // Output directory creation must not become an input lookup that invalidates its own build.
  system.writeFile = (path, contents, byteOrderMark) => {
    mkdirSync(dirname(path), { recursive: true });
    filesystem.writeFile(path, contents, byteOrderMark);
  };
  assert.equal(typeof typescript.executeCommandLine, 'function', 'Pinned TypeScript command-line entry point is unavailable');
  typescript.executeCommandLine(system, () => {}, ['--project', configurationPath,
    '--outDir', destination, '--module', 'CommonJS', '--moduleResolution', 'Node', '--incremental', 'false']);
  assert.equal(exitCode, 0, 'Package compiler failed');
  assert.ok(!inconsistentRead, 'Compiler inputs changed during compilation');
  const inputs = [...observations].sort(([left], [right]) => left.localeCompare(right)).map(([, operation]) => operation);
  verifyCompilerInputs(inputs, configurationPath);
  return inputs;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.equal(process.argv.length, 5, 'Usage: package-compiler.mjs <configuration> <output> <input-receipt>');
  const inputs = compilePackage(resolve(process.argv[2]), resolve(process.argv[3]));
  writeFileSync(process.argv[4], JSON.stringify(inputs));
}
