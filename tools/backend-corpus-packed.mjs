import assert from 'node:assert/strict';
import { join } from 'node:path';
import { backendCorpusInventory, normalizeBackendCorpusOptions, ordinaryJsonRecord,
  createBackendCorpusConfigurationData, analyzeBackendCorpusReport } from './backend-corpus-common.mjs';
import { verifyBackendCorpusCandidateIdentity } from './backend-corpus-candidate.mjs';

function packedOptions(options) {
  assert.ok(ordinaryJsonRecord(options), 'Packed corpus options must be an ordinary object');
  const supported = ['frontendDirectory', 'outputDirectory', 'jsonReportPath',
    'browserExecutablePath', 'backendURL', 'workers'];
  for (const name of Reflect.ownKeys(options))
    assert.ok(supported.includes(name), `Unsupported packed corpus option: ${String(name)}`);
  return normalizeBackendCorpusOptions(options, 'Packed candidate');
}

export function createBackendCorpusPackedConfigurationData(options) {
  const normalized = packedOptions(options);
  return createBackendCorpusConfigurationData(normalized, {
    backendCorpusPacked: {
      engine: 'flashwright', executionClass: 'packed-alias-functional-admission',
      sourceCommit: backendCorpusInventory.commit, referenceContractVersion: '1.60.0',
      declaredBrowserVersion: '148.0.7778.96', declaredBrowserDistribution: 'chrome-for-testing-full',
      ...normalized, frontendPackage: '@playwright/test', canonicalPackage: '@flashwright/test',
      requiredIdenticalExports: ['test', 'request', 'chromium'],
    },
  });
}

/** Resolve and guard the installed runner instance; no workspace package enters this configuration. */
export function renderBackendCorpusPackedConfiguration(options) {
  const normalized = packedOptions(options);
  return `import { createRequire } from 'node:module';
import { realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
if (resolve(process.cwd()) !== ${JSON.stringify(normalized.frontendDirectory)})
  throw new Error('Run the packed candidate from its frontend directory');
if (process.env.FLASHWRIGHT_DRIVER_PATH)
  throw new Error('Packed corpus cannot use a host driver override');
const requireConsumer = createRequire(${JSON.stringify(join(normalized.frontendDirectory, 'package.json'))});
const installedRoot = join(realpathSync(${JSON.stringify(normalized.frontendDirectory)}), 'node_modules');
function installedPath(specifier) {
  const resolved = realpathSync(requireConsumer.resolve(specifier));
  const local = relative(installedRoot, resolved);
  if (!local || local === '..' || local.startsWith('../') || isAbsolute(local))
    throw new Error('Packed corpus package resolved outside consumer node_modules: ' + specifier);
  return resolved;
}
const frontendPath = installedPath('@playwright/test');
const canonicalPath = installedPath('@flashwright/test');
const runnerDirectory = dirname(installedPath('@flashwright/runner/package.json'));
const upstreamPath = installedPath(join(runnerDirectory, 'dist/upstream/test.js'));
const frontendPackage = requireConsumer(frontendPath);
const canonicalPackage = requireConsumer(canonicalPath);
(${verifyBackendCorpusCandidateIdentity.toString()})(frontendPackage, canonicalPackage);
const upstream = requireConsumer(upstreamPath);
for (const browser of [upstream.chromium, upstream.firefox, upstream.webkit]) {
  for (const method of ['launch', 'launchPersistentContext', 'connect', 'connectOverCDP'])
    browser[method] = async () => { throw new Error('Forbidden upstream browser backend entered'); };
}
upstream.request.newContext = async () => { throw new Error('Forbidden upstream request backend entered'); };
const { defineConfig, devices } = frontendPackage;
const configuration = ${JSON.stringify(createBackendCorpusPackedConfigurationData(normalized), null, 2)};
configuration.projects[1].use = { ...devices['Desktop Chrome'], ...configuration.projects[1].use };
export default defineConfig(configuration);
`;
}

/** Original outcomes remain independent of installation and process-ledger validation. */
export function analyzeBackendCorpusPackedReport(report, options) {
  const normalized = packedOptions(options);
  const analysis = analyzeBackendCorpusReport(report, normalized, createBackendCorpusPackedConfigurationData(normalized), {
    key: 'backendCorpusPacked', rejectReference: true,
    mismatchMessage: 'Declared packed metadata differs; metadata alone does not prove packed execution',
  });
  return { ...analysis, engine: 'flashwright', executionClass: 'packed-alias-functional-admission',
    scope: `${analysis.scope} Installed dependency integrity, actual driver execution and cleanup require independent evidence. This report does not establish comparative performance or release acceptance.` };
}
