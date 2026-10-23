#!/usr/bin/env node
// Packs Flashwright's three npm packages from a built checkout, without touching the repository's
// own package.json files (the upstream test suites expect Playwright's names):
//
//   flashwright-core   packages/playwright-core
//   flashwright        packages/playwright       (depends on playwright-core = npm:flashwright-core)
//   flashwright-test   packages/playwright-test  (depends on playwright = npm:flashwright)
//
// The dependencies are npm aliases, so a project replaces @playwright/test with
//   npm i -D @playwright/test@npm:flashwright-test@<version>
// and its imports, `npx playwright` and the internal `playwright-core/...` requires stay the same.
//
// Usage: node utils/flashwright/pack.mjs [--version <version>] [--out <dir>] [--dry-run-publish]
// Run `npm run build` first. Nothing is published; --dry-run-publish runs `npm publish --dry-run`.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..', '..');
const argValue = name => {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
};
const upstreamVersion = JSON.parse(fs.readFileSync(path.join(root, 'packages/playwright-core/package.json'), 'utf8')).version;
const version = argValue('--version') ?? `${upstreamVersion}-flashwright.1`;
const out = path.resolve(argValue('--out') ?? path.join(root, 'workbench/npm'));
const dryRunPublish = process.argv.includes('--dry-run-publish');

const repository = { type: 'git', url: 'git+https://github.com/xcodebeast/flashwright.git' };
const homepage = 'https://github.com/xcodebeast/flashwright';
const packages = [
  { dir: 'playwright-core', name: 'flashwright-core', dependencies: {} },
  { dir: 'playwright', name: 'flashwright', dependencies: { 'playwright-core': `npm:flashwright-core@${version}` } },
  { dir: 'playwright-test', name: 'flashwright-test', dependencies: { 'playwright': `npm:flashwright@${version}` } },
];

const readme = name => `# ${name}

Part of [Flashwright](${homepage}), a faster [Playwright](https://playwright.dev): a fork of Playwright ${upstreamVersion} with the same API, test runner and browsers, at least 2× faster on every scenario of its benchmark (2.74× on average).

![Playwright and Flashwright running the same 24 tests side by side](https://raw.githubusercontent.com/xcodebeast/flashwright/main/docs/media/race.gif)

Replace \`@playwright/test\` and keep your imports and \`npx playwright\` commands:

\`\`\`bash
npm i -D @playwright/test@npm:flashwright-test
npx playwright install chromium
\`\`\`

Without the test runner, \`playwright\` is \`flashwright\` and \`playwright-core\` is \`flashwright-core\`. See the [project page](${homepage}) for benchmarks, speed options and the differences from Playwright.

Flashwright is an independent fork and is not affiliated with Microsoft. Apache-2.0, like Playwright.
`;

// Incremental builds leave older hashed trace viewer bundles next to the current ones.
const viewerAssets = path.join(root, 'packages/playwright-core/lib/vite/traceViewer/assets');
if (fs.existsSync(viewerAssets) && fs.readdirSync(viewerAssets).filter(name => name.startsWith('codeMirrorModule-')).length > 1) {
  console.error('packages/playwright-core/lib has outputs of earlier builds; run `npm run clean && npm run build` first.');
  process.exit(1);
}

fs.rmSync(out, { recursive: true, force: true });
const staging = path.join(out, 'staging');
fs.mkdirSync(staging, { recursive: true });

const tarballs = [];
for (const pkg of packages) {
  // Pack exactly what upstream packs (its .npmignore applies), then rename the unpacked copy.
  const packed = execFileSync('npm', ['pack', '--silent', '--pack-destination', staging], { cwd: path.join(root, 'packages', pkg.dir), encoding: 'utf8' }).trim().split('\n').pop();
  const unpacked = path.join(staging, pkg.name);
  fs.mkdirSync(unpacked, { recursive: true });
  execFileSync('tar', ['-xzf', path.join(staging, packed), '-C', unpacked, '--strip-components=1']);
  fs.rmSync(path.join(staging, packed));

  const manifestPath = path.join(unpacked, 'package.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.name = pkg.name;
  manifest.version = version;
  manifest.description = `Flashwright: a faster drop-in replacement for Playwright (fork of Playwright ${upstreamVersion})`;
  manifest.repository = repository;
  manifest.homepage = homepage;
  manifest.bugs = { url: `${homepage}/issues` };
  manifest.keywords = ['playwright', 'flashwright', 'e2e', 'testing', 'browser', 'automation', 'test-runner', 'fast'];
  if (manifest.dependencies)
    manifest.dependencies = { ...manifest.dependencies, ...pkg.dependencies };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  fs.writeFileSync(path.join(unpacked, 'README.md'), readme(pkg.name));
  // Playwright's releases ship its license and notice in every package; so does Flashwright.
  for (const file of ['LICENSE', 'NOTICE'])
    fs.copyFileSync(path.join(root, file), path.join(unpacked, file));

  const tarball = execFileSync('npm', ['pack', '--silent', '--pack-destination', out], { cwd: unpacked, encoding: 'utf8' }).trim().split('\n').pop();
  tarballs.push(path.join(out, tarball));
  console.log(`${pkg.name}@${version}  ${path.join(out, tarball)}`);
  if (dryRunPublish)
    execFileSync('npm', ['publish', path.join(out, tarball), '--dry-run', '--tag', 'latest'], { stdio: 'inherit' });
}
fs.writeFileSync(path.join(out, 'tarballs.json'), JSON.stringify({ version, tarballs: Object.fromEntries(packages.map((pkg, i) => [pkg.name, tarballs[i]])) }, null, 2));
