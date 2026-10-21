// Runs selected workload tests on the fork with protocol logging and prints a timeline.
// Usage: node bench/trace.mjs <workload> <grep> [start-marker]
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { startWorkloadServer, workloadSpec } from './workloads/server.mjs';

const [workload = 'noop', grep = 'noop (5|6)$', marker = ''] = process.argv.slice(2);
const project = resolve('workbench/trace-run');
mkdirSync(join(project, 'tests'), { recursive: true });
writeFileSync(join(project, 'package.json'), JSON.stringify({ type: 'module' }));
writeFileSync(join(project, 'adapter.mjs'), `export { test, expect, defineConfig } from ${JSON.stringify(resolve('packages/playwright-test/index.mjs'))};\n`);
writeFileSync(join(project, 'tests', `${workload}.spec.ts`), workloadSpec(workload, 15));
const server = await startWorkloadServer();
writeFileSync(join(project, 'runner.config.mjs'), `import { defineConfig } from './adapter.mjs'; export default defineConfig(${JSON.stringify({ testDir: './tests', workers: 1, use: { baseURL: server.url } })});\n`);
const log = join(project, 'protocol.log');
// The fixture server lives in this process, so the runner must not block the event loop.
const child = spawn(process.execPath, [resolve('packages/playwright-test/cli.js'), 'test', '--config', join(project, 'runner.config.mjs'), '-g', grep, '--reporter=line'],
    { cwd: project, env: { ...process.env, DEBUG: 'pw:protocol,pw:api', DEBUG_COLORS: '0' } });
let output = '';
child.stdout.on('data', chunk => output += chunk);
child.stderr.on('data', chunk => output += chunk);
await new Promise(f => child.on('close', f));
writeFileSync(log, output);
await server.close();
const timeline = spawnSync('python3', [resolve('bench/proto-timeline.py'), log, ...(marker ? [marker] : [])], { encoding: 'utf8' });
process.stdout.write(timeline.stdout);
