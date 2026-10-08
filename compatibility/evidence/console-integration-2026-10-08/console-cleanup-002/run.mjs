import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { sourceManifest } from '../../tools/source-manifest.mjs';
const directory = '.cache/console-cleanup-002';
const hash = value => createHash('sha256').update(value).digest('hex');
const report = { sources: await sourceManifest(), driverSha256: hash(await readFile(process.env.FLASHWRIGHT_DRIVER_PATH)), checks: [], status: 'running' };
const commands = [
 ['python3', '-m', 'unittest', 'tools.test_watchdog', '-v'],
 ['python3', 'tools/run-python-tests.py', '--start-directory', 'compatibility/m1', '--pattern', 'test_lifecycle.py'],
 ['python3', 'tools/run-python-tests.py', '--start-directory', 'compatibility/m1', '--pattern', 'watchdog_lifecycle.py'],
];
for (const [index, command] of commands.entries()) {
 const chunks = [];
 const child = spawn('python3', ['tools/watchdog.py', '--timeout', '150', '--report-directory', `${directory}/resources`, '--', ...command], { stdio: ['ignore', 'pipe', 'pipe'] });
 for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { process.stdout.write(chunk); chunks.push(chunk); });
 const code = await new Promise(resolve => child.on('close', resolve));
 const contents = Buffer.concat(chunks); const log = `${index + 1}.log`;
 await writeFile(`${directory}/${log}`, contents);
 report.checks.push({ command, code, log, sha256: hash(contents) });
 if (code !== 0) break;
}
report.sourceChanged = JSON.stringify(report.sources) !== JSON.stringify(await sourceManifest());
report.status = report.checks.length === commands.length && report.checks.every(check => check.code === 0) && !report.sourceChanged ? 'passed' : 'failed';
await writeFile(`${directory}/report.json`, JSON.stringify(report, null, 2) + '\n');
process.exitCode = report.status === 'passed' ? 0 : 1;
