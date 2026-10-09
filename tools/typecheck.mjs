import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
const compiler = createRequire(import.meta.url).resolve('typescript/bin/tsc');
for (const arguments_ of [[], ['--project', 'compatibility/migration-projects/tsconfig.json']]) {
  execFileSync(process.execPath, [compiler, '--noEmit', ...arguments_], { stdio: 'inherit' });
}
