import { spawn } from 'node:child_process';

const child = spawn('python3', ['tools/watchdog.py', '--timeout', '120', '--report-directory', 'compatibility/evidence/resources', '--', process.execPath, 'compatibility/m2/condition-registry.mjs'], { stdio: 'inherit', env: process.env });
child.on('error', error => { throw error; });
child.on('close', code => { process.exitCode = code ?? 1; });
