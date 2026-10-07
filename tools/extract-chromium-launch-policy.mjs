import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const distributionPath = 'node_modules/playwright-core/lib/coreBundle.js';
const distribution = await readFile(distributionPath, 'utf8');
assert.equal(JSON.parse(await readFile('node_modules/playwright-core/package.json', 'utf8')).version, '1.60.0');
const parsed = ts.createSourceFile(distributionPath, distribution, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const assignments = new Map();
let defaultMethods;
function visit(node) {
  if (ts.isBinaryExpression(node) && ts.isIdentifier(node.left)) {
    if (['disabledFeatures', 'chromiumSwitches'].includes(node.left.text)) assignments.set(node.left.text, node.right.getText(parsed));
    if (node.left.text === 'Chromium' && ts.isClassExpression(node.right)) {
      defaultMethods = node.right.members.filter(member => ['defaultArgs', '_innerDefaultArgs'].includes(member.name?.getText(parsed))).map(member => member.getText(parsed));
    }
  }
  ts.forEachChild(node, visit);
}
visit(parsed);
assert.equal(assignments.size, 2);
assert.equal(defaultMethods?.length, 2);
const retainedSource = `${[...assignments].map(([name, expression]) => `const ${name} = ${expression};`).join('\n')}\nclass ChromiumDefaults {\n${defaultMethods.join('\n')}\n}\n`;
const policy = {};
for (const headless of [false, true]) {
  // Evaluate only inspected argument construction, with no caller environment overrides or browser backend.
  policy[headless ? 'headless' : 'headed'] = await runInNewContext(`${retainedSource}\nnew ChromiumDefaults().defaultArgs({ headless: ${headless} }, false, '__FLASHWRIGHT_PROFILE__');`, { process: { env: {} } }, { timeout: 1000 });
  assert.equal(policy[headless ? 'headless' : 'headed'].filter(argument => argument === '--user-data-dir=__FLASHWRIGHT_PROFILE__').length, 1);
}
const destination = 'crates/flashwright-browser/src/chromium-launch-policy.json';
const retainedExtract = 'compatibility/upstream/chromium-launch-policy.source.js';
const hash = value => createHash('sha256').update(value).digest('hex');
const generated = JSON.stringify(policy, null, 2) + '\n';
const outputs = {
  [destination]: generated,
  [retainedExtract]: retainedSource,
  'compatibility/upstream/chromium-launch-policy-provenance.json': JSON.stringify({
    referenceVersion: '1.60.0', source: 'https://github.com/microsoft/playwright/tree/v1.60.0/packages/playwright-core/src/server/chromium',
    referenceFiles: ['chromiumSwitches.ts', 'chromium.ts'], distributionPath, distributionSha256: hash(distribution),
    retainedExtract, extractSha256: hash(retainedSource), destination, generatedSha256: hash(generated),
    extraction: 'Retain the pinned disabled-feature list, switch builder and CDP Chromium default-argument methods; evaluate only default headed/headless, ephemeral, no-proxy, default-sandbox options with no environment overrides.',
    changes: ['Use the resulting immutable argument lists for the native browser backend; the guardian substitutes its owned profile path in the retained position'],
    license: 'Apache-2.0', licensePath: 'compatibility/upstream/LICENSE.playwright', noticePath: 'compatibility/upstream/NOTICE.playwright',
  }, null, 2) + '\n',
};
for (const [path, content] of Object.entries(outputs)) {
  if (process.argv.includes('--check')) assert.equal(await readFile(path, 'utf8'), content, `Pinned Chromium launch policy differs: ${path}`);
  else await writeFile(path, content);
}
console.log(`Verified pinned Chromium launch policy: ${policy.headed.length} headed and ${policy.headless.length} headless arguments.`);
