import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, mkdtemp, copyFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { startFixtureServer } from '../benchmarks/fixture-server.mjs';
import { runnerFamilies, runnerFamilyTitles } from '../benchmarks/runner-family-contract.mjs';
import { runnerSpecifications } from '../benchmarks/runner-suite-contract.mjs';
const root = resolve(import.meta.dirname, '..'), tool = resolve(import.meta.filename);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function command(command, args, options) { const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] }); let stdout = '', stderr = ''; child.stdout.on('data', b => stdout += b); child.stderr.on('data', b => stderr += b); const exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); }); return { exit, stdout, stderr }; }
if (process.argv[2] === '--owner') {
    const folder = process.argv[3], p = JSON.parse(await readFile(join(folder, 'prepared.json')));
    let server;
    const start = performance.now();
    const report = { status: 'failed', failures: [] };
    try {
        server = await startFixtureServer(p.configuration.backendDelayMilliseconds);
        const child = await command(process.execPath, p.command, { cwd: folder, env: { ...process.env, FLASHWRIGHT_TEST_BASE_URL: server.origin, } });
        await writeFile(join(folder, 'stdout.txt'), child.stdout);
        await writeFile(join(folder, 'stderr.txt'), child.stderr);
        report.exit = child.exit;
        assert.deepEqual(child.exit, { code: p.family === 'failure' ? 1 : 0, signal: null });
        report.status = 'passed';
    }
    catch (error) {
        report.failures.push(error.stack ?? String(error));
    }
    finally {
        await server?.close();
        report.backend = server?.counts;
        report.completeMilliseconds = performance.now() - start;
        await writeFile(join(folder, 'owner.json'), JSON.stringify(report, null, 2));
    }
    if (report.status !== 'passed')
        process.exitCode = 1;
}
else {
    const directory = process.argv[2] ? resolve(process.argv[2]) : await mkdtemp(join(root, 'workbench/independent-controlled-'));
    if (process.argv[2])
        await mkdir(directory);
    assert(directory.startsWith(join(root, 'workbench') + '/'));
    const browser = process.env.FLASHWRIGHT_BROWSER_PATH;
    assert(browser, 'Set FLASHWRIGHT_BROWSER_PATH');
    const base = JSON.parse(await readFile(join(root, 'benchmarks/configurations/runner-suite.json'))), source = await readFile(join(root, 'benchmarks/runner-suite/workloads.spec.mjs'));
    const runs = [];
    for (const [familyIndex, family] of runnerFamilies.entries())
        for (const workers of [1, 4])
            for (const engine of familyIndex % 2 ? ['independent', 'playwright'] : ['playwright', 'independent']) {
                const name = `${family}-w${workers}-${engine}`, folder = join(directory, name);
                await mkdir(folder);
                const configuration = { ...base, workloads: [family], workers };
                const reportFile = join(folder, 'report.json');
                const config = { testDir: '.', testMatch: 'workloads.spec.mjs', workers, fullyParallel: workers === 4, retries: 0, repeatEach: 1, maxFailures: 0, forbidOnly: true, timeout: 30000, expect: { timeout: 5000 }, outputDir: join(folder, 'results'), reporter: [['json', { outputFile: reportFile }]], use: { headless: true, viewport: base.viewport, actionTimeout: 5000, navigationTimeout: 10000, trace: 'off', video: 'off', screenshot: 'off', launchOptions: { executablePath: browser } } };
                await writeFile(join(folder, 'workloads.spec.mjs'), source);
                await writeFile(join(folder, 'suite-configuration.json'), JSON.stringify({ configuration, launchIndex: 0 }));
                await writeFile(join(folder, 'adapter.mjs'), `${engine === 'independent' ? "import './guard.cjs';" : ''}export {test,expect} from '${engine === 'independent' ? '@flashwright/test/independent' : '@playwright/test'}';export const nativeBackendGuardActive=${engine === 'independent'};`);
                await writeFile(join(folder, 'config.cjs'), `const c=${JSON.stringify(config)};c.use.baseURL=process.env.FLASHWRIGHT_TEST_BASE_URL;module.exports=c;`);
                await writeFile(join(folder, 'guard.cjs'), `const Module=require('node:module');require('node:fs').appendFileSync(${JSON.stringify(join(folder, 'guarded-pids.txt'))},process.pid+'\\n');const old=Module._load;Module._load=function(id,...args){if(/dist[\\\\/]upstream|playwright-core[\\\\/]lib[\\\\/](?:coreBundle|server|client)|flashwright-upstream-runner/.test(id))throw Error('Forbidden upstream runtime: '+id);return Reflect.apply(old,this,[id,...args]);};`);
                const cli = engine === 'independent' ? join(root, 'packages/flashwright-test/cli.cjs') : join(root, 'node_modules/playwright/cli.js');
                const prepared = { family, engine, workers, configuration, command: [cli, 'test', ...(engine === 'independent' ? ['--runner=independent'] : []), '--config', join(folder, 'config.cjs')] };
                await writeFile(join(folder, 'prepared.json'), JSON.stringify(prepared, null, 2));
                const launched = await command('python3', ['-B', join(root, 'tools/watchdog.py'), '--timeout', '120', '--report', join(folder, 'resources.json'), '--', process.execPath, tool, '--owner', folder], { env: { ...process.env, FLASHWRIGHT_DRIVER_PATH: process.env.FLASHWRIGHT_DRIVER_PATH ?? join(root, 'target/release/flashwright-driver') } });
                await writeFile(join(folder, 'watchdog.stdout'), launched.stdout);
                await writeFile(join(folder, 'watchdog.stderr'), launched.stderr);
                assert.deepEqual(launched.exit, { code: 0, signal: null }, name + ' ' + launched.stderr);
                const report = JSON.parse(await readFile(reportFile)), owner = JSON.parse(await readFile(join(folder, 'owner.json'))), resources = JSON.parse(await readFile(join(folder, 'resources.json')));
                assert.equal(owner.status, 'passed');
                assert.deepEqual(owner.failures, []);
                assert.equal(resources.exitCode, 0);
                assert.equal(resources.timedOut, false);
                assert.deepEqual(resources.cleanupSignals, []);
                assert.deepEqual(resources.remainingObservedProcesses, []);
                const records = engine === 'independent' ? report.results.map(r => ({ ...r, title: report.plan.tests.find(t => t.id === r.id).title })) : runnerSpecifications(report.suites).map(s => ({ ...s.tests[0].results[0], title: s.title, annotations: s.tests[0].results[0].annotations ?? s.tests[0].annotations }));
                assert.deepEqual(records.map(r => r.title).sort(), runnerFamilyTitles(family).sort());
                assert.equal(records.length, 15);
                const pids = new Map(), slots = new Set();
                for (const r of records) {
                    assert.equal(r.status, family === 'failure' ? 'failed' : 'passed');
                    assert.equal(r.retry, 0);
                    assert.equal(r.errors.length, family === 'failure' ? 1 : 0);
                    const notes = r.annotations.filter(a => a.type === 'runner-suite-observation');
                    assert.equal(notes.length, 1);
                    const o = JSON.parse(notes[0].description);
                    assert.deepEqual(o.isolation, { localStorage: null, sessionStorage: null, cookies: '' });
                    assert.equal(o.contextReused, false);
                    assert.equal(o.title, r.title);
                    assert.equal(o.untrustedClicks, 0);
                    assert.equal(o.untrustedChanges, 0);
                    assert.equal(o.trustedClicks, ['interaction', 'backend'].includes(family) ? 1 : 0);
                    assert.equal(o.trustedChanges, family === 'backend' ? 1 : 0);
                    assert.equal(o.applicationCount, family === 'interaction' ? 1 : 0);
                    assert.deepEqual(o.viewport, base.viewport);
                    assert.equal(o.focused, true);
                    assert.equal(o.visibilityState, 'visible');
                    assert.equal(o.browserVersion, base.browserVersion);
                    assert.equal(o.nativeBackendGuardActive, engine === 'independent');
                    if (pids.has(r.workerIndex))
                        assert.equal(pids.get(r.workerIndex), o.workerProcess);
                    pids.set(r.workerIndex, o.workerProcess);
                    slots.add(r.parallelIndex);
                    if (family === 'failure') {
                        assert.match(r.errors[0].message, /#missing/);
                        const doc = await readFile(r.attachments.find(a => a.name === 'error-context').path, 'utf8');
                        assert.match(doc, /#missing/);
                        assert.match(doc, /Increment/);
                        assert.match(doc, /workloads\.spec\.mjs/);
                        assert.match(doc, /# Test source/);
                        assert.match(doc, />\s*\d+\s*\|/);
                        assert.match(doc, /\^/);
                    }
                }
                assert.equal(pids.size, family === 'failure' ? 15 : workers);
                assert.equal(slots.size, workers);
                assert.equal(owner.backend.documents, family === 'navigation' ? 30 : 15);
                assert.equal(owner.backend.backendRequests, family === 'backend' ? 15 : 0);
                if (engine === 'independent') {
                    assert.deepEqual(report.workerErrors, []);
                    assert.ok(report.workers.every(w => w.exitCode === 0 && !w.signal && !w.forcedTermination));
                    const guarded = (await readFile(join(folder, 'guarded-pids.txt'), 'utf8')).trim().split('\n').map(Number);
                    assert.ok([...pids.values()].every(pid => guarded.includes(pid)), 'Every actual worker must load the upstream guard');
                }
                assert.equal(sha(await readFile(join(folder, 'workloads.spec.mjs'))), sha(source));
                runs.push({ name, family, engine, workers, tests: records.length, intentionalFailures: family === 'failure' ? 15 : 0, completeMilliseconds: owner.completeMilliseconds, observedPeakRssBytes: resources.peakRssBytes, reportSha256: sha(await readFile(reportFile)), resourcesSha256: sha(await readFile(join(folder, 'resources.json'))) });
                console.log(name, 'passed');
            }
    await writeFile(join(directory, 'verified.json'), JSON.stringify({ status: 'passed', sourceSha256: sha(source), runs, limitations: ['One functional capture per cell, not comparative performance acceptance.', 'No final resource custody admission.'] }, null, 2));
    console.log(JSON.stringify({ status: 'passed', directory, runs: runs.length }));
}
