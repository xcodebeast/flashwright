import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import ts from 'typescript';

const declarationPaths = [
  'playwright-core/types/types.d.ts',
  'playwright-core/types/structs.d.ts',
  'playwright/types/test.d.ts',
  'playwright/types/testReporter.d.ts',
];
const packages = ['playwright-core', 'playwright', '@playwright/test'];
const entries = [];
const sources = [];
const identities = new Map();

function addEntry(identity, kind, source, node, extra = {}) {
  const overload = (identities.get(identity) ?? 0) + 1;
  identities.set(identity, overload);
  const documentation = (node?.jsDoc ?? []).map(comment => comment.getText(source)).join('\n');
  entries.push({
    id: `${identity}#${overload}`, kind, reference: '1.60.0', backend: 'chromium',
    status: 'planned', milestone: 'M4', implementation: null, evidence: [],
    source: source.fileName,
    ...(node ? {
      line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
      signature: node.getText(source).replace(/\/\*\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ').trim(),
      defaults: documentation.split('\n').filter(line => /default|defaults|not specified|omitted/i.test(line)).map(line => line.replace(/^\s*\* ?/, '')),
    } : {}),
    ...extra,
  });
}

/** Preserve overloads and recursively inventory inline options and callback parameters. */
function visit(node, scope, source) {
  if (ts.isInterfaceDeclaration(node) || ts.isClassDeclaration(node) || ts.isTypeAliasDeclaration(node)) {
    const identity = `${scope}.${node.name?.text ?? '<anonymous>'}`;
    addEntry(identity, ts.SyntaxKind[node.kind], source, node, {
      heritage: node.heritageClauses?.map(clause => clause.getText(source)) ?? [],
    });
    if (ts.isTypeAliasDeclaration(node)) visit(node.type, identity, source);
    else node.members.forEach(member => visit(member, identity, source));
    return;
  }
  if (ts.isMethodSignature(node) || ts.isPropertySignature(node) || ts.isFunctionDeclaration(node)
      || ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isCallSignatureDeclaration(node)
      || ts.isConstructSignatureDeclaration(node) || ts.isIndexSignatureDeclaration(node)) {
    const name = node.name?.getText(source) ?? '<call>';
    const identity = `${scope}.${name}`;
    const kind = ts.isParameter(node) ? 'parameter' : ts.SyntaxKind[node.kind];
    const firstParameter = node.parameters?.[0];
    const event = firstParameter?.name.getText(source) === 'event' ? firstParameter.type?.getText(source) : undefined;
    addEntry(identity, kind, source, node, {
      optional: Boolean(node.questionToken), ...(event ? { event } : {}),
    });
    node.parameters?.forEach(parameter => visit(parameter, identity, source));
    if (node.type) visit(node.type, identity, source);
    return;
  }
  if (ts.isModuleDeclaration(node)) {
    addEntry(`${scope}.${node.name.getText(source)}`, 'namespace', source, node);
    if (node.body) visit(node.body, `${scope}.${node.name.getText(source)}`, source);
    return;
  }
  if (ts.isExportDeclaration(node) || ts.isExportAssignment(node)) {
    addEntry(`${scope}.export:${node.getText(source)}`, 'export', source, node);
    return;
  }
  ts.forEachChild(node, child => visit(child, scope, source));
}

for (const path of declarationPaths) {
  const text = await readFile(`node_modules/${path}`, 'utf8');
  sources.push({ path, sha256: createHash('sha256').update(text).digest('hex'), license: 'Apache-2.0' });
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  visit(source, path, source);
}
for (const name of packages) {
  const manifestPath = `node_modules/${name}/package.json`;
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (manifest.version !== '1.60.0') throw new Error(`${name}: expected pinned 1.60.0, received ${manifest.version}`);
  for (const [subpath, targets] of Object.entries(manifest.exports)) {
    addEntry(`${name}:${subpath}`, 'package-subpath', { fileName: manifestPath }, undefined, { targets });
  }
}
const inventory = {
  schemaVersion: 1, referenceVersion: '1.60.0', sources,
  scope: 'Pinned public browser/library, runner and reporter declarations, including helper types, nested options, callback parameters, overloads, event signatures, inheritance references and package subpaths. Protocol domain declarations and private deep imports are outside the public compatibility contract.',
  defaultsPolicy: 'Default excerpts are extracted from pinned declaration documentation. An absent excerpt means unspecified here, never an inferred default. Each implemented capability must additionally record its verified runtime defaults.',
  entries,
};
const serialized = JSON.stringify(inventory, null, 2) + '\n';
const destination = 'compatibility/capabilities.json';
if (process.argv.includes('--check')) {
  if (await readFile(destination, 'utf8') !== serialized) throw new Error('Capability inventory differs from pinned declarations. Run npm run inventory and review changes.');
} else {
  await writeFile(destination, serialized);
}
console.log(`${entries.length} classified declaration/subpath entries from ${sources.length} pinned sources.`);
