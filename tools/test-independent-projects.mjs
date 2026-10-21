import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
const root = resolve(import.meta.dirname, '..');
const directory = await mkdtemp(join(root, 'workbench/independent-projects-'));
const prefix = `import {test,expect} from '@flashwright/test/independent';import {readFileSync,writeFileSync,existsSync} from 'node:fs';`;
async function run(name, files, configuration, args = []) {
    const folder = join(directory, name);
    await mkdir(folder);
    for (const [path, source] of Object.entries(files))
        await writeFile(join(folder, path), prefix + source);
    const reportFile = join(folder, 'report.json'), config = join(folder, 'config.cjs');
    await writeFile(config, 'module.exports=' + JSON.stringify({ workers: 2, outputDir: './results', reporter: [['json', { outputFile: reportFile }]], ...configuration }));
    const child = spawnSync(process.execPath, [join(root, 'packages/flashwright-test/cli.cjs'), 'test', '--runner=independent', '--config', config, ...args], { cwd: folder, encoding: 'utf8', timeout: 30000 });
    await writeFile(join(folder, 'stdout.txt'), child.stdout ?? '');
    await writeFile(join(folder, 'stderr.txt'), child.stderr ?? '');
    assert.equal(child.signal, null, child.stderr);
    assert.equal(child.error, undefined);
    return { exit: child.status, report: JSON.parse(await readFile(reportFile, 'utf8')), folder };
}
const shared = `const custom=test.extend({marker:['default',{option:true}]});custom('shared title',async({marker},info)=>{expect(marker).toBe(info.project.name);expect(info.project.use.marker).toBe(marker);expect(info.titlePath.at(-1)).toBe('shared title');info.annotations.push({type:'project',description:marker});await info.attach('project',{body:marker});});`;
const identity = await run('identity', { 'shared.spec.ts': shared }, { metadata: { purpose: 'integration' }, projects: [{ name: 'first', use: { marker: 'first' } }, { name: 'second', use: { marker: 'second' } }] });
assert.equal(identity.exit, 0);
assert.deepEqual(identity.report.projects.map(p => [p.name, p.status, p.metadata]), [['first', 'passed', { purpose: 'integration' }], ['second', 'passed', { purpose: 'integration' }]]);
assert.equal(new Set(identity.report.results.map(r => r.id)).size, 2);
assert.equal(new Set(identity.report.workers.map(w => w.workerIndex)).size, 2);
for (const result of identity.report.results) {
    assert.equal(result.annotations[0].description, result.projectName);
    assert.equal(await readFile(result.attachments[0].path, 'utf8'), result.projectName);
}
const dependent = await run('dependency', {
    'seed.setup.ts': `test('seed state',()=>{writeFileSync('state.txt','ready')});`,
    'main.spec.ts': `test('chosen',()=>{expect(readFileSync('state.txt','utf8')).toBe('ready')});test('excluded',()=>{throw Error('must not run')});`,
    'other.spec.ts': `test('unselected',()=>{throw Error('must not run')});`,
}, { projects: [{ name: 'main', dependencies: ['seed'], testMatch: 'main.spec.ts' }, { name: 'seed', testMatch: '*.setup.ts' }, { name: 'other', testMatch: 'other.spec.ts' }] }, ['--project=main', '--grep=chosen', 'main.spec.ts']);
assert.equal(dependent.exit, 0);
assert.deepEqual(dependent.report.projects.map(p => [p.name, p.tests]), [['seed', 1], ['main', 1]]);
const failed = await run('failed-dependency', {
    'seed.setup.ts': `test('seed failure',()=>{throw Error('seed failure sentinel')});`,
    'main.spec.ts': `test('must not execute',()=>{writeFileSync('wrong.txt','executed')});`,
    'other.spec.ts': `test('unrelated',()=>{expect(true).toBe(true)});`,
}, { projects: [{ name: 'seed', testMatch: '*.setup.ts' }, { name: 'main', dependencies: ['seed'], testMatch: 'main.spec.ts' }, { name: 'other', testMatch: 'other.spec.ts' }] });
assert.equal(failed.exit, 1);
assert.deepEqual(failed.report.projects.map(p => [p.name, p.status]), [['seed', 'failed'], ['main', 'skipped'], ['other', 'passed']]);
assert.deepEqual(failed.report.projects[1].blockedBy, ['seed']);
await assert.rejects(readFile(join(failed.folder, 'wrong.txt')), { code: 'ENOENT' });
const retry = await run('dependency-retry', {
    'seed.setup.ts': `test('seed retry',({},info)=>{if(info.retry===0)throw Error('retry setup');writeFileSync('state.txt','ready')});`,
    'main.spec.ts': `test('dependent',()=>{expect(readFileSync('state.txt','utf8')).toBe('ready')});`,
}, { projects: [{ name: 'main', dependencies: ['seed'], testMatch: 'main.spec.ts' }, { name: 'seed', testMatch: '*.setup.ts', retries: 1 }] });
assert.equal(retry.exit, 0);
assert.deepEqual(retry.report.results.map(r => [r.projectName, r.retry, r.status]), [['seed', 0, 'failed'], ['seed', 1, 'passed'], ['main', 0, 'passed']]);
const defaultFiltered = await run('default-filtered', {
    'seed.setup.ts': `test('seed state',()=>{writeFileSync('state.txt','ready')});`,
    'main.spec.ts': `test('chosen',()=>{expect(readFileSync('state.txt','utf8')).toBe('ready')});`,
}, { projects: [{ name: 'seed', testMatch: '*.setup.ts' }, { name: 'main', dependencies: ['seed'], testMatch: 'main.spec.ts' }] }, ['--grep=chosen']);
assert.equal(defaultFiltered.exit, 0);
assert.deepEqual(defaultFiltered.report.results.map(r => r.projectName), ['seed', 'main']);
const noMatch = await run('no-matches', {
    'seed.setup.ts': `test('seed state',()=>{writeFileSync('must-not-exist.txt','wrong')});`,
    'main.spec.ts': `test('main',()=>{});`,
}, { projects: [{ name: 'seed', testMatch: '*.setup.ts' }, { name: 'main', dependencies: ['seed'], testMatch: 'main.spec.ts' }] }, ['--project=main', '--grep=nonexistent']);
assert.equal(noMatch.exit, 1);
assert.deepEqual(noMatch.report.results, []);
assert.match(noMatch.report.workerErrors[0].message, /No matching tests/);
await assert.rejects(readFile(join(noMatch.folder, 'must-not-exist.txt')), { code: 'ENOENT' });
for (const result of [identity, dependent, failed, retry, defaultFiltered]) {
    assert.deepEqual(result.report.workerErrors, []);
    assert.ok(result.report.workers.every(w => w.exitCode === 0 && !w.signal && !w.forcedTermination));
}
await writeFile(join(directory, 'verified.json'), JSON.stringify({ status: 'passed', runtime: process.versions.bun ? 'bun' : 'node', cases: 6, checks: ['project identity/options/annotations', 'selected dependency executes unfiltered', 'failed dependency skips descendants and preserves unrelated work', 'successful setup retry admits dependent', 'default selection promotes dependencies', 'no matching test suppresses setup effects'], reports: [identity, dependent, failed, retry, defaultFiltered, noMatch].map(r => ({ directory: r.folder, exit: r.exit, attempts: r.report.results.length })) }, null, 2));
console.log(JSON.stringify({ status: 'passed', directory, cases: 6 }));
