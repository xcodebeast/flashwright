import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, symlink, rm, access } from 'node:fs/promises';
import path from 'node:path';
import { availableParallelism } from 'node:os';
import { resolveIndependentConfig, resolveIndependentProjects, discoverIndependentTests } from '../packages/flashwright-runner/dist/commonjs/independent/config.js';

const workbench = path.resolve('workbench');
await mkdir(workbench, { recursive: true });

async function fixture(body) {
  const root = await mkdtemp(path.join(workbench, 'independent-config-'));
  const configFile = path.join(root, 'flashwright.config.ts');
  const put = async file => { await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), 'throw new Error("test modules must never load during discovery");'); };
  try { await body({ root, configFile, put }); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test('single-project defaults and overrides resolve paths without creating outputs', async () => fixture(async ({ root, configFile }) => {
  const config = resolveIndependentConfig({}, configFile);
  assert.equal(config.testDir, root);
  assert.equal(config.outputDir, path.join(root, 'test-results'));
  assert.equal(config.timeout, 30000);
  assert.equal(config.expect.timeout, 5000);
  assert.equal(config.workers, Math.max(1, Math.floor(availableParallelism() / 2)));
  assert.equal(config.retries, 0);
  assert.equal(config.fullyParallel, false);
  assert.equal(config.forbidOnly, false);
  assert.deepEqual(config.reporter, [{ name: 'list', options: {} }]);
  const configured = resolveIndependentConfig({ testDir: 'tests', outputDir: 'artifacts', workers: 2, retries: 1, timeout: 0, expect: { timeout: 0 }, fullyParallel: true, forbidOnly: true, use: { custom: { value: 1 } }, reporter: [['dot'], ['json', { outputFile: 'reports/results.json' }]] }, configFile, { workers: 3, retries: 2, grep: 'title.*', files: ['selected.spec.ts'] });
  assert.equal(configured.testDir, path.join(root, 'tests'));
  assert.equal(configured.outputDir, path.join(root, 'artifacts'));
  assert.equal(configured.reporter[1].options.outputFile, path.join(root, 'reports/results.json'));
  assert.equal(configured.workers, 3);
  assert.equal(configured.retries, 2);
  assert.equal(configured.timeout, 0);
  assert.equal(configured.expect.timeout, 0);
  assert.equal(configured.grep, 'title.*');
  assert.deepEqual(configured.files, [path.resolve('selected.spec.ts')]);
  assert.deepEqual(configured.use.custom, { value: 1 });
  await assert.rejects(access(configured.outputDir), { code: 'ENOENT' });
}));

test('unsupported settings reject before discovery or test imports', async () => fixture(async ({ root, configFile, put }) => {
  await put('never.spec.ts');
  for (const input of [{ projects: [] }, { globalSetup: './setup.ts' }, { globalTeardown: './cleanup.ts' }, { webServer: {} }, { grep: /title/ }, { shard: { current: 1, total: 2 } }, { expect: { toHaveScreenshot: {} } }, { reporter: 'html' }, { reporter: [['json', { open: true }]] }, { reporter: [['line', { outputFile: 'ignored.json' }]] }]) {
    assert.throws(() => resolveIndependentConfig(input, configFile), error => error.name === 'UnsupportedFeatureError' && error.details.referenceVersion === '1.60.0');
  }
  assert.throws(() => resolveIndependentConfig({}, configFile, { shard: 1 }), { name: 'UnsupportedFeatureError' });
  assert.equal(resolveIndependentConfig({ projects: undefined }, configFile).testDir, root);
  await assert.rejects(access(path.join(root, 'test-results')), { code: 'ENOENT' });
}));

test('invalid config values and overrides fail with typed argument errors', () => {
  for (const input of [null, [], 'config', { workers: 0 }, { workers: '50%' }, { workers: 1.5 }, { retries: -1 }, { timeout: NaN }, { timeout: Infinity }, { timeout: -1 }, { fullyParallel: 1 }, { forbidOnly: 'false' }, { use: [] }, { expect: null }, { expect: { timeout: -1 } }, { testDir: '' }, { outputDir: 1 }, { testMatch: [1] }, { testIgnore: {} }, { testMatch: '[broken' }, { reporter: [] }, { reporter: [[42]] }, { reporter: [['json', null]] }, { reporter: [['json', { outputFile: '' }]] }]) {
    assert.throws(() => resolveIndependentConfig(input, '/unused/config.ts'), { name: 'InvalidArgumentError' });
  }
  for (const overrides of [{ workers: 0 }, { retries: -1 }, { grep: 1 }, { files: 'file.ts' }, { files: [1] }]) assert.throws(() => resolveIndependentConfig({}, '/unused/config.ts', overrides), { name: 'InvalidArgumentError' });
  assert.throws(() => resolveIndependentConfig({ testMatch: '**/!(slow).ts' }, '/unused/config.ts'), { name: 'UnsupportedFeatureError' });
  // A CLI override cannot conceal a malformed supplied config field.
  assert.throws(() => resolveIndependentConfig({ workers: 0 }, '/unused/config.ts', { workers: 1 }), { name: 'InvalidArgumentError' });
});

test('default discovery is recursive, sorted and excludes infrastructure, outputs and directory symlinks', async () => fixture(async ({ root, configFile, put }) => {
  const sourceFiles = ['a.test.js', 'nested/b.spec.tsx', 'nested/c.spec.mts', 'nested/d.test.cjsx', 'z.spec.ts'];
  for (const file of [...sourceFiles, 'helper.ts', 'a.spec.txt', 'a.tests.ts', 'node_modules/n.spec.ts', '.git/g.spec.ts', 'workbench/w.spec.ts', 'test-results/out.spec.ts', 'test-results/nested/out.spec.ts']) await put(file);
  await symlink(path.join(root, 'nested'), path.join(root, 'linked'), 'dir');
  await symlink(root, path.join(root, 'nested', 'cycle'), 'dir');
  await symlink(path.join(root, 'z.spec.ts'), path.join(root, 'file-link.spec.ts'), 'file');
  await symlink(path.join(root, 'missing'), path.join(root, 'broken-link.spec.ts'), 'file');
  const expected = [...sourceFiles, 'file-link.spec.ts'].sort();
  assert.deepEqual(await discoverIndependentTests(resolveIndependentConfig({}, configFile)), expected.map(file => path.join(root, file)));
  assert.deepEqual(await discoverIndependentTests(resolveIndependentConfig({ testDir: 'missing' }, configFile)), []);
}));

test('glob matching covers globstar, alternatives, extglobs, classes and literal dots', async () => fixture(async ({ root, configFile, put }) => {
  for (const file of ['a.spec.ts', 'a.test.js', 'nested/b.spec.mts', 'nested/c.test.tsx', 'nested/helper.ts', 'nested/aXspecXts', '.hidden.spec.ts']) await put(file);
  const discover = async pattern => (await discoverIndependentTests(resolveIndependentConfig({ testMatch: pattern }, configFile))).map(file => path.relative(root, file));
  assert.deepEqual(await discover('**/*.{spec,test}.{ts,js}'), ['.hidden.spec.ts', 'a.spec.ts', 'a.test.js']);
  assert.deepEqual(await discover('**/*.@(spec|test).?(c|m)[jt]s?(x)'), ['.hidden.spec.ts', 'a.spec.ts', 'a.test.js', 'nested/b.spec.mts', 'nested/c.test.tsx']);
  assert.deepEqual(await discover('nested/?.spec.[cm]ts'), ['nested/b.spec.mts']);
  assert.deepEqual(await discover('*.spec.ts'), ['.hidden.spec.ts', 'a.spec.ts']);
  assert.deepEqual(await discover(path.join(root, 'a.spec.ts')), ['a.spec.ts']);
  assert.deepEqual(await discover(['**/*.mts', '**/*.tsx']), ['nested/b.spec.mts', 'nested/c.test.tsx']);
}));

test('regex/glob ignores are repeatable and explicit paths select files or subtrees', async () => fixture(async ({ root, configFile, put }) => {
  for (const file of ['a.spec.ts', 'nested/b.spec.ts', 'nested/c.spec.ts', 'reports/hidden.spec.ts']) await put(file);
  const pattern = /\.spec\.ts$/g;
  pattern.lastIndex = 100;
  const config = resolveIndependentConfig({ testMatch: pattern, testIgnore: ['**/c.spec.ts', /a\.spec\.ts$/g], outputDir: 'reports' }, configFile);
  const expected = [path.join(root, 'nested/b.spec.ts')];
  assert.deepEqual(await discoverIndependentTests(config), expected);
  assert.deepEqual(await discoverIndependentTests(config), expected);
  assert.equal(pattern.lastIndex, 100);
  const select = files => discoverIndependentTests(resolveIndependentConfig({ outputDir: 'reports' }, configFile, { files, grep: 'a title absent from file names' }));
  assert.deepEqual(await select([path.join(root, 'nested')]), [path.join(root, 'nested/b.spec.ts'), path.join(root, 'nested/c.spec.ts')]);
  assert.deepEqual(await select([path.join(root, 'a.spec.ts'), path.join(root, 'a.spec.ts')]), [path.join(root, 'a.spec.ts')]);
  assert.deepEqual(await select([path.join(root, 'nest')]), []);
  assert.deepEqual(await select([path.join(root, 'missing.spec.ts')]), []);
}));

test('project planner preserves unnamed defaults and admits only default repeat/failure limits', () => {
  const input = { testDir: 'tests', use: { custom: true }, repeatEach: 1, maxFailures: 0, metadata: { campaign: 'host fixture', nested: { value: 1 } } };
  const overrides = { workers: 2, retries: 1, files: ['selected.spec.ts'], grep: 'selected title' };
  assert.deepEqual(resolveIndependentProjects(input, '/unused/config.ts', overrides), [{ name: '', dependencies: [], config: resolveIndependentConfig(input, '/unused/config.ts', overrides) }]);
  assert.deepEqual(resolveIndependentConfig(input, '/unused/config.ts').metadata, input.metadata);
  for (const input of [{ repeatEach: 2 }, { maxFailures: 1 }]) assert.throws(() => resolveIndependentProjects(input, '/unused/config.ts'), { name: 'UnsupportedFeatureError' });
  for (const input of [{ repeatEach: 0 }, { repeatEach: '1' }, { maxFailures: -1 }, { metadata: [] }, { metadata: null }]) assert.throws(() => resolveIndependentProjects(input, '/unused/config.ts'), { name: 'InvalidArgumentError' });
  assert.throws(() => resolveIndependentProjects({}, '/unused/config.ts', { project: ['named'] }), /unknown project/);
});

test('named projects inherit root defaults with shallow use/expect merges and stable dependency ordering', async () => fixture(async ({ root, configFile }) => {
  const input = {
    testDir: 'shared', testMatch: '**/*.test.ts', testIgnore: '**/ignored/**', timeout: 1000, retries: 1, fullyParallel: false, outputDir: 'artifacts',
    workers: 3, reporter: 'dot', forbidOnly: true, expect: { timeout: 123 }, metadata: { run: 'fixture' },
    use: { baseURL: 'http://root.test', nested: { root: true }, custom: 7 },
    projects: [
      { name: 'app', dependencies: ['setup'], testDir: 'app', testMatch: /app\.spec\.ts$/, testIgnore: [], timeout: 2500, retries: 2, fullyParallel: true, outputDir: 'app-artifacts', use: { baseURL: 'http://app.test', nested: { app: true } }, expect: { timeout: 0 } },
      { name: 'independent', expect: {}, use: {} },
      { name: 'setup', dependencies: [], timeout: undefined },
    ],
  };
  const projects = resolveIndependentProjects(input, configFile);
  assert.deepEqual(projects.map(project => project.name), ['independent', 'setup', 'app']);
  const [independent, setup, app] = projects;
  assert.equal(independent.config.testDir, path.join(root, 'shared'));
  assert.equal(independent.config.timeout, 1000);
  assert.equal(independent.config.expect.timeout, 123);
  assert.deepEqual(independent.config.use, input.use);
  assert.equal(setup.config.timeout, 1000);
  assert.deepEqual(app.dependencies, ['setup']);
  assert.equal(app.config.testDir, path.join(root, 'app'));
  assert.equal(app.config.outputDir, path.join(root, 'app-artifacts'));
  assert.deepEqual(app.config.testMatch, [/app\.spec\.ts$/]);
  assert.deepEqual(app.config.testIgnore, []);
  assert.equal(app.config.timeout, 2500);
  assert.equal(app.config.retries, 2);
  assert.equal(app.config.fullyParallel, true);
  assert.equal(app.config.expect.timeout, 0);
  assert.deepEqual(app.config.use, { baseURL: 'http://app.test', nested: { app: true }, custom: 7 });
  for (const project of projects) {
    assert.equal(project.config.workers, 3);
    assert.equal(project.config.forbidOnly, true);
    assert.deepEqual(project.config.reporter, [{ name: 'dot', options: {} }]);
    assert.deepEqual(project.config.metadata, { run: 'fixture' });
  }
  assert.deepEqual(input.use.nested, { root: true });
  await assert.rejects(access(path.join(root, 'artifacts')), { code: 'ENOENT' });
  await assert.rejects(access(path.join(root, 'app-artifacts')), { code: 'ENOENT' });
}));

test('project selection includes transitive dependencies and promotes selected dependencies to unfiltered execution', async () => fixture(async ({ root, configFile, put }) => {
  for (const file of ['app/selected.spec.ts', 'app/other.spec.ts', 'auth/login.spec.ts', 'seed/initialize.spec.ts']) await put(file);
  const input = { projects: [
    { name: 'app', testDir: 'app', dependencies: ['auth'] },
    { name: 'auth', testDir: 'auth', dependencies: ['seed'] },
    { name: 'unrelated' },
    { name: 'seed', testDir: 'seed' },
  ] };
  const selectedFile = path.join(root, 'app/selected.spec.ts');
  const overrides = { project: ['app'], files: [selectedFile], grep: 'selected title', workers: 2, retries: 3 };
  const projects = resolveIndependentProjects(input, configFile, overrides);
  assert.deepEqual(projects.map(project => project.name), ['seed', 'auth', 'app']);
  for (const project of projects.slice(0, 2)) {
    assert.deepEqual(project.config.files, []);
    assert.equal(project.config.grep, undefined);
    assert.equal((await discoverIndependentTests(project.config)).length, 1);
  }
  assert.deepEqual(projects[2].config.files, [selectedFile]);
  assert.equal(projects[2].config.grep, 'selected title');
  assert.deepEqual(await discoverIndependentTests(projects[2].config), [selectedFile]);
  for (const project of projects) { assert.equal(project.config.workers, 2); assert.equal(project.config.retries, 3); }
  const both = resolveIndependentProjects(input, configFile, { ...overrides, project: ['app', 'auth', 'app'] });
  assert.deepEqual(both.map(project => project.name), ['seed', 'auth', 'app']);
  assert.deepEqual(both[1].config.files, []);
  assert.equal(both[1].config.grep, undefined);
  const all = resolveIndependentProjects(input, configFile, { files: [selectedFile], grep: 'all selected' });
  assert.deepEqual(all.map(project => project.name), ['unrelated', 'seed', 'auth', 'app']);
  assert.deepEqual(all.map(project => [project.name, project.config.files, project.config.grep]), [
    ['unrelated', [selectedFile], 'all selected'], ['seed', [], undefined], ['auth', [], undefined], ['app', [selectedFile], 'all selected'],
  ]);
  const setupAndMain = resolveIndependentProjects({ projects: [{ name: 'setup' }, { name: 'main', dependencies: ['setup'] }] }, configFile, {
    project: ['setup', 'main'], files: [selectedFile], grep: 'main title',
  });
  assert.deepEqual(setupAndMain.map(project => [project.name, project.config.files, project.config.grep]), [
    ['setup', [], undefined], ['main', [selectedFile], 'main title'],
  ]);
}));

test('invalid project names, dependency graphs and selections reject before effects', () => {
  const invalidProjects = [
    null, {}, [], [null], [{}], [{ name: '' }], [{ name: '   ' }], [{ name: 1 }], [{ name: 'same' }, { name: 'same' }],
    [{ name: 'app', dependencies: 'setup' }], [{ name: 'app', dependencies: [1] }], [{ name: 'app', dependencies: [''] }],
    [{ name: 'app', dependencies: ['missing'] }], [{ name: 'self', dependencies: ['self'] }],
    [{ name: 'a', dependencies: ['b'] }, { name: 'b', dependencies: ['a'] }],
    [{ name: 'a', dependencies: ['b'] }, { name: 'b', dependencies: ['c'] }, { name: 'c', dependencies: ['a'] }],
    [{ name: 'app', use: [] }], [{ name: 'app', expect: null }], [{ name: 'app', timeout: -1 }],
  ];
  for (const projects of invalidProjects) assert.throws(() => resolveIndependentProjects({ projects }, '/unused/config.ts'), { name: 'InvalidArgumentError' });
  for (const project of ['app', [1], [''], ['   '], ['missing']]) assert.throws(() => resolveIndependentProjects({ projects: [{ name: 'app' }] }, '/unused/config.ts', { project }), { name: 'InvalidArgumentError' });
  assert.throws(() => resolveIndependentProjects({ workers: 0, projects: [{ name: 'app' }] }, '/unused/config.ts', { workers: 1 }), { name: 'InvalidArgumentError' });
});

test('unsupported project settings reject even on unselected projects', () => {
  for (const settings of [{ workers: 1 }, { reporter: 'dot' }, { forbidOnly: true }, { projects: [] }, { metadata: {} }, { teardown: 'cleanup' }, { globalSetup: './setup.ts' }, { repeatEach: 1 }, { maxFailures: 0 }, { expect: { toHaveScreenshot: {} } }]) {
    const projects = [{ name: 'selected' }, { name: 'unselected', ...settings }];
    assert.throws(() => resolveIndependentProjects({ projects }, '/unused/config.ts', { project: ['selected'] }), { name: 'UnsupportedFeatureError' });
  }
  assert.throws(() => resolveIndependentConfig({ projects: [{ name: 'app' }] }, '/unused/config.ts'), { name: 'UnsupportedFeatureError' });
});
