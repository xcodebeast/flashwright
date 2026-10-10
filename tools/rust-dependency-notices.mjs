import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function containedPath(directory, path) {
  const result = relative(directory, resolve(directory, path));
  assert.ok(result && !isAbsolute(result) && !result.split(/[\\/]/).includes('..'), `License path must remain inside its source directory: ${path}`);
  return result;
}

/** Include resolved registry and vendored dependencies; missing notices require an exact reviewed supplement. */
export async function collectRustDependencyNotices(metadata, supplements, workspace = process.cwd()) {
  assert.equal(supplements.schemaVersion, 1);
  const resolved = new Set(metadata.resolve.nodes.map(node => node.id));
  const members = new Set(metadata.workspace_members);
  const dependencies = metadata.packages.filter(dependency => resolved.has(dependency.id) && !members.has(dependency.id));
  const notices = [];
  for (const dependency of dependencies) {
    const root = dirname(dependency.manifest_path);
    const names = (await readdir(root)).filter(name => /^(licen[cs]es?|copying|copyright|notice|unlicense)([-._]|$)/i.test(name)).sort();
    if (dependency.license_file && !names.includes(dependency.license_file)) names.push(dependency.license_file);
    const documents = names.map(name => ({ path: join(root, containedPath(root, name)), name: basename(name) }));
    let supplement;
    if (!documents.length) {
      const matches = supplements.dependencies.filter(entry => entry.name === dependency.name && entry.version === dependency.version);
      assert.equal(matches.length, 1, `Missing reviewed license text for ${dependency.name}@${dependency.version}`);
      supplement = matches[0];
      assert.equal(dependency.license, supplement.license);
      assert.equal(dependency.repository, supplement.repository);
      assert.equal(hash(await readFile(dependency.manifest_path)), supplement.manifestSha256, 'Supplement does not match published crate metadata');
      assert.deepEqual(JSON.parse(await readFile(join(root, '.cargo_vcs_info.json'), 'utf8')), supplement.vcs, 'Supplement does not match published crate revision');
      const path = join(workspace, containedPath(workspace, supplement.licensePath));
      assert.equal(hash(await readFile(path)), supplement.licenseSha256, 'Retained upstream license bytes changed');
      documents.push({ path, name: basename(path) });
    }
    assert.equal(new Set(documents.map(document => document.name)).size, documents.length, 'License destination names collide');
    notices.push({
      name: dependency.name, version: dependency.version, license: dependency.license,
      source: dependency.source ?? `path:${containedPath(workspace, root)}`,
      ...(supplement ? { supplement: { source: supplement.source, sha256: supplement.licenseSha256, revision: supplement.vcs.git.sha1 } } : {}),
      documents,
    });
  }
  return notices;
}
