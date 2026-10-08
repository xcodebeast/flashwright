import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { performance } from 'node:perf_hooks';
const started = performance.now();
const spawn = childProcess.spawn;
let sequence = 0;
childProcess.spawn = function (...arguments_) {
  const identifier = ++sequence;
  console.error(JSON.stringify({ phase: 'spawn', identifier, elapsedMilliseconds: performance.now() - started }));
  const child = spawn.apply(this, arguments_);
  child.once('exit', (code, signal) => console.error(JSON.stringify({ phase: 'exit', identifier, code, signal, elapsedMilliseconds: performance.now() - started })));
  child.once('close', (code, signal) => console.error(JSON.stringify({ phase: 'close', identifier, code, signal, elapsedMilliseconds: performance.now() - started })));
  return child;
};
syncBuiltinESMExports();
