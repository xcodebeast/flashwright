import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

const referenceVersion = '1.60.0';
const sourcePath = 'node_modules/playwright-core/lib/server/deviceDescriptorsSource.json';
const original = await readFile(sourcePath, 'utf8');
assert.equal(JSON.parse(await readFile('node_modules/playwright-core/package.json', 'utf8')).version, referenceVersion);
const descriptors = JSON.parse(original);
for (const descriptor of Object.values(descriptors)) {
  assert.ok(['chromium', 'firefox', 'webkit'].includes(descriptor.defaultBrowserType));
  assert.equal(typeof descriptor.userAgent, 'string');
}
const generatedPath = 'packages/flashwright-core/src/device-descriptors.ts';
const generated = `// Generated from Playwright ${referenceVersion}; Apache-2.0 provenance is in compatibility/upstream/device-descriptors-provenance.json.\nexport interface DeviceDescriptor {\n  userAgent: string;\n  viewport: { width: number; height: number };\n  screen?: { width: number; height: number };\n  deviceScaleFactor: number;\n  isMobile: boolean;\n  hasTouch: boolean;\n  defaultBrowserType: 'chromium' | 'firefox' | 'webkit';\n}\n\nconst descriptors = ${JSON.stringify(descriptors, null, 2)} satisfies Record<string, DeviceDescriptor>;\n\n/** Pinned descriptors identify their intended backend; only Chromium is implemented. */\nexport const devices: typeof descriptors & Record<string, DeviceDescriptor> = descriptors;\n`;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const outputs = {
  [generatedPath]: generated,
  'compatibility/upstream/device-descriptors-provenance.json': JSON.stringify({
    referenceVersion, source: 'https://github.com/microsoft/playwright/blob/v1.60.0/packages/playwright-core/src/server/deviceDescriptorsSource.json',
    sourcePath, sourceSha256: hash(original), generatedPath, generatedSha256: hash(generated), descriptorCount: Object.keys(descriptors).length,
    changes: ['Preserve every descriptor value and intended browser backend unchanged.', 'Generate standalone TypeScript data and structural types; the browser library does not import the upstream driver or runner.'],
    license: 'Apache-2.0', licensePath: 'compatibility/upstream/LICENSE.playwright', noticePath: 'compatibility/upstream/NOTICE.playwright',
  }, null, 2) + '\n',
};
for (const [path, contents] of Object.entries(outputs)) {
  if (process.argv.includes('--check')) assert.equal(await readFile(path, 'utf8'), contents, `Pinned device descriptors differ: ${path}`);
  else await writeFile(path, contents);
}
console.log(`Verified ${Object.keys(descriptors).length} pinned device descriptors.`);
