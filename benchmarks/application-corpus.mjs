import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import typescript from 'typescript';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const defaultDirectory = resolve('compatibility/migration-projects/offline-todomvc');

export function applicationCorpusDirectory(name = 'todomvc') {
  assert.ok(['todomvc', 'svgomg'].includes(name), 'Unknown application corpus');
  return resolve(`compatibility/migration-projects/offline-${name}`);
}

export function applicationTestBodies(contents, path) {
  const source = typescript.createSourceFile(path, contents, typescript.ScriptTarget.Latest, true, typescript.ScriptKind.TS);
  assert.deepEqual(source.parseDiagnostics, [], `Invalid retained test syntax: ${path}`);
  const tests = [];
  function visit(node) {
    if (typescript.isCallExpression(node) && typescript.isIdentifier(node.expression) && node.expression.text === 'test') {
      const [title, callback] = node.arguments;
      assert.ok(typescript.isStringLiteral(title) && (typescript.isArrowFunction(callback) || typescript.isFunctionExpression(callback)), 'Corpus needs literal test names and explicit callbacks');
      tests.push({ title: title.text, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, sha256: hash(callback.body.getText(source)) });
    }
    typescript.forEachChild(node, visit);
  }
  visit(source);
  return tests;
}

export function applicationTestIdentities(corpus) {
  return corpus.manifest.files.filter(entry => ['test', 'seed'].includes(entry.role)).flatMap(entry =>
    applicationTestBodies(corpus.files.get(entry.path).toString('utf8'), entry.path).map(({ title, line }) => ({ file: entry.path.slice('tests/'.length), title, line })));
}

export function replaceExactlyOnce(contents, before, after) {
  assert.equal(contents.split(before).length, 2, `Expected exactly one adaptation target: ${before}`);
  return contents.replace(before, after);
}

/** Retained bytes stay untouched; the receipt distinguishes test bodies from fixture/app adaptations. */
export async function loadApplicationCorpus(directory = defaultDirectory) {
  const manifestBytes = await readFile(join(directory, 'provenance.json'));
  const manifest = JSON.parse(manifestBytes);
  const files = new Map();
  for (const entry of manifest.files) {
    assert.ok(!files.has(entry.path), `Duplicate corpus file: ${entry.path}`);
    assert.ok(!entry.path.split('/').includes('..') && !entry.path.startsWith('/'));
    const bytes = await readFile(join(directory, entry.path));
    assert.equal(bytes.length, entry.bytes, entry.path);
    assert.equal(hash(bytes), entry.sha256, entry.path);
    assert.deepEqual(entry.changes, [], 'Retained upstream bytes must remain unchanged');
    files.set(entry.path, bytes);
  }
  assert.equal(manifest.expectedTests, applicationTestIdentities({ manifest, files }).length);
  assert.equal(manifest.assertionTests, manifest.files.filter(entry => entry.role === 'test').reduce((count, entry) => count + applicationTestBodies(files.get(entry.path).toString('utf8'), entry.path).length, 0));
  const adaptedAssets = new Map();
  for (const adaptation of [manifest.adaptations.bundle, manifest.adaptations.html].filter(Boolean)) {
    let contents = files.get(adaptation.path).toString('utf8');
    for (const [before, after] of adaptation.replacements) contents = replaceExactlyOnce(contents, before, after);
    assert.equal(hash(contents), adaptation.servedSha256);
    adaptedAssets.set(adaptation.path, Buffer.from(contents));
  }
  const requestPaths = manifest.files.filter(entry => entry.role === 'asset').map(entry => entry.requestPath);
  assert.equal(new Set(requestPaths).size, requestPaths.length);
  assert.ok(requestPaths.includes(manifest.documentPath));
  assert.equal(manifest.httpExpectations.alwaysExact[manifest.documentPath], manifest.expectedTests);
  for (const policy of Object.values(manifest.httpExpectations)) for (const [path, count] of Object.entries(policy)) {
    assert.ok(requestPaths.includes(path), `HTTP policy refers to an undeclared asset: ${path}`);
    assert.ok(Number.isInteger(count) && count > 0);
  }
  return { manifest, files, adaptedAssets, manifestSha256: hash(manifestBytes) };
}

export function applicationGeneratedSources(corpus, adapterSpecifier) {
  const sources = [];
  for (const entry of corpus.manifest.files.filter(entry => ['test', 'seed', 'fixture'].includes(entry.role))) {
    let contents = corpus.files.get(entry.path).toString('utf8');
    const changes = [];
    const testBodies = applicationTestBodies(contents, entry.path);
    const adaptation = corpus.manifest.adaptations.fixture ?? corpus.manifest.adaptations.setup;
    if (entry.path === adaptation.path) {
      contents = replaceExactlyOnce(contents, adaptation.before, adaptation.after);
      assert.equal(contents.split("'@playwright/test'").length - 1, adaptation.packageImportCount);
      contents = contents.replaceAll("'@playwright/test'", JSON.stringify(adapterSpecifier));
      changes.push('package import adapter', 'setup URL from local HTTP server');
    }
    assert.deepEqual(applicationTestBodies(contents, entry.path), testBodies, 'Original test callback bodies and declaration lines must stay unchanged');
    if (!changes.length) assert.equal(hash(contents), entry.sha256, 'Unadapted test sources must stay unchanged');
    sources.push({ contents, record: { path: entry.path, role: entry.role, originalSha256: entry.sha256, generatedSha256: hash(contents), changes, testBodies } });
  }
  return sources;
}

export async function materializeApplicationTests(corpus, directory, adapterSpecifier) {
  const records = [];
  for (const { contents, record } of applicationGeneratedSources(corpus, adapterSpecifier)) {
    await mkdir(dirname(join(directory, record.path)), { recursive: true });
    await writeFile(join(directory, record.path), contents, { flag: 'wx' });
    records.push(record);
  }
  return records;
}

export async function startApplicationServer(corpus) {
  const requests = [];
  const assets = new Map(corpus.manifest.files.filter(entry => entry.role === 'asset').map(entry => [entry.requestPath, entry]));
  const server = createServer((request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname;
    const entry = assets.get(path);
    const status = request.method !== 'GET' ? 405 : path === '/favicon.ico' ? 204 : entry ? 200 : 404;
    requests.push({ method: request.method, path, status });
    if (status !== 200) { response.writeHead(status); response.end(); return; }
    const contents = corpus.adaptedAssets.get(entry.path) ?? corpus.files.get(entry.path);
    response.writeHead(200, {
      'Content-Type': { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
        '.json': 'application/json', '.map': 'application/json', '.woff2': 'font/woff2', '.png': 'image/png', '.svg': 'image/svg+xml' }[extname(entry.path)] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    response.end(contents);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { url: `http://127.0.0.1:${server.address().port}${corpus.manifest.documentPath}`, requests,
    close: () => new Promise((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); }) };
}
