import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { realpathSync } from 'node:fs';

assert.ok(process.argv.slice(2).every(argument => argument === '--release'), 'Usage: bun tools/build-driver.mjs [--release]');
assert.ok(!process.env.RUSTFLAGS || process.env.CARGO_ENCODED_RUSTFLAGS, 'Use CARGO_ENCODED_RUSTFLAGS for extra compiler flags so path remapping can preserve exact arguments');
const flags = process.env.CARGO_ENCODED_RUSTFLAGS?.split('\x1f').filter(Boolean) ?? [];
// Cargo dependencies and panic locations must not embed a developer's home directory.
for (const [source, destination] of [[homedir(), '/build-home'], [process.cwd(), '/flashwright']]) {
  for (const path of new Set([source, realpathSync(source)])) flags.push(`--remap-path-prefix=${path}=${destination}`);
}
// Native dependency debug records and Darwin linker object paths bypass Rust remapping.
// Keep ordinary symbols and remapped panic locations, but omit private debugger metadata.
flags.push('-Cstrip=debuginfo');
const child = spawn('cargo', ['build', '--workspace', '--locked', ...process.argv.slice(2)], {
  stdio: 'inherit', env: { ...process.env, CARGO_ENCODED_RUSTFLAGS: flags.join('\x1f') },
});
child.on('error', error => { throw error; });
child.on('close', code => { process.exitCode = code ?? 1; });
