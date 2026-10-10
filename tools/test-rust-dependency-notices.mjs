import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { collectRustDependencyNotices } from './rust-dependency-notices.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture(context) {
  const workspace = await mkdtemp(join(tmpdir(), 'flashwright-notices-'));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  const crate = join(workspace, 'vendor/dependency');
  await mkdir(crate, { recursive: true });
  await writeFile(join(crate, 'Cargo.toml'), 'pinned package');
  const vcs = { git: { sha1: 'a'.repeat(40) }, path_in_vcs: 'dependency' };
  await writeFile(join(crate, '.cargo_vcs_info.json'), JSON.stringify(vcs));
  await writeFile(join(workspace, 'retained-license'), 'upstream license');
  const dependency = { id: 'dependency', name: 'dependency', version: '1.0.0', source: null, license: 'MIT', repository: 'https://example.test/dependency', manifest_path: join(crate, 'Cargo.toml') };
  const supplement = { name: dependency.name, version: dependency.version, license: dependency.license, repository: dependency.repository, manifestSha256: hash('pinned package'), vcs, licensePath: 'retained-license', licenseSha256: hash('upstream license'), source: 'https://example.test/dependency/pinned/LICENSE' };
  return { workspace, crate, dependency, supplement, metadata: { packages: [dependency], workspace_members: [], resolve: { nodes: [{ id: dependency.id }] } }, supplements: { schemaVersion: 1, dependencies: [supplement] } };
}
const collect = state => collectRustDependencyNotices(state.metadata, state.supplements, state.workspace);

test('vendored dependencies retain their own license while workspace and unresolved packages are excluded', async context => {
  const state = await fixture(context);
  await writeFile(join(state.crate, 'LICENSE'), 'vendored license');
  state.supplements.dependencies = [];
  state.metadata.packages.push({ id: 'workspace', manifest_path: '/must-not-read' }, { id: 'unresolved', manifest_path: '/must-not-read' });
  state.metadata.workspace_members.push('workspace');
  state.metadata.resolve.nodes.push({ id: 'workspace' });
  const notices = await collect(state);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].source, 'path:vendor/dependency');
  assert.deepEqual(notices[0].documents, [{ path: join(state.crate, 'LICENSE'), name: 'LICENSE' }]);
  assert.equal(notices[0].supplement, undefined);
});

test('missing crate notices use exact metadata, revision and retained upstream bytes', async context => {
  const state = await fixture(context);
  state.dependency.source = 'registry+https://example.test/registry';
  const [notice] = await collect(state);
  assert.equal(notice.source, state.dependency.source);
  assert.equal(notice.supplement.sha256, hash('upstream license'));
  assert.deepEqual(notice.documents, [{ path: join(state.workspace, 'retained-license'), name: 'retained-license' }]);
});

for (const [name, change] of [
  ['missing supplement', async state => { state.supplements.dependencies = []; }],
  ['duplicate supplement', async state => { state.supplements.dependencies.push(state.supplement); }],
  ['changed crate metadata', state => writeFile(join(state.crate, 'Cargo.toml'), 'changed package')],
  ['changed crate revision', state => writeFile(join(state.crate, '.cargo_vcs_info.json'), '{}')],
  ['changed retained license', state => writeFile(join(state.workspace, 'retained-license'), 'changed license')],
  ['changed license declaration', async state => { state.dependency.license = 'BSD-3-Clause'; }],
  ['changed repository', async state => { state.dependency.repository += '-other'; }],
  ['escaping retained path', async state => { state.supplement.licensePath = '../license'; }],
  ['escaping crate license path', async state => { state.dependency.license_file = '../LICENSE'; }],
]) test(`notice collection rejects ${name}`, async context => {
  const state = await fixture(context);
  await change(state);
  await assert.rejects(collect(state));
});
