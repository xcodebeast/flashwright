import assert from 'node:assert/strict';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { backendCorpusInventory, normalizeBackendCorpusOptions, ordinaryJsonRecord,
  createBackendCorpusConfigurationData, analyzeBackendCorpusReport } from './backend-corpus-common.mjs';

export { backendCorpusInventory };

function candidateOptions(options) {
  assert.ok(ordinaryJsonRecord(options), 'Candidate options must be an ordinary object without accessors');
  const supported = ['candidateWorkspace', 'frontendDirectory', 'outputDirectory', 'jsonReportPath',
    'browserExecutablePath', 'backendURL', 'workers'];
  for (const name of Reflect.ownKeys(options))
    assert.ok(supported.includes(name), `Unsupported candidate option: ${String(name)}`);
  assert.ok(typeof options.candidateWorkspace === 'string' && isAbsolute(options.candidateWorkspace),
    'candidateWorkspace must be an explicit absolute path');
  return { ...normalizeBackendCorpusOptions(options, 'Candidate'), candidateWorkspace: resolve(options.candidateWorkspace) };
}

/** Missing exports cannot establish identity by comparing two undefined values. */
export function verifyBackendCorpusCandidateIdentity(frontendPackage, canonicalPackage) {
  for (const name of ['test', 'request', 'chromium']) {
    const canonical = canonicalPackage?.[name];
    const valid = name === 'test' ? typeof canonical === 'function'
      : canonical && typeof canonical[name === 'request' ? 'newContext' : 'launch'] === 'function';
    if (!valid) throw new Error(`Canonical @flashwright/test is missing a usable ${name} export`);
    if (frontendPackage?.[name] !== canonical)
      throw new Error(`Candidate @playwright/test ${name} identity differs from canonical @flashwright/test`);
  }
}

/** This is an identified development alias diagnosis, not packed installation or speed admission. */
export function createBackendCorpusCandidateConfigurationData(options) {
  const normalized = candidateOptions(options);
  const { candidateWorkspace, frontendDirectory, outputDirectory, jsonReportPath, backendURL, browserExecutablePath, workers } = normalized;
  return createBackendCorpusConfigurationData(normalized, {
    backendCorpusCandidate: { engine: 'flashwright', executionClass: 'development-alias-functional-diagnosis',
      sourceCommit: backendCorpusInventory.commit, referenceContractVersion: '1.60.0',
      declaredBrowserVersion: '148.0.7778.96', declaredBrowserDistribution: 'chrome-for-testing-full',
      candidateWorkspace, frontendDirectory, outputDirectory, jsonReportPath, backendURL, browserExecutablePath, workers,
      frontendPackage: '@playwright/test', canonicalPackage: '@flashwright/test',
      requiredIdenticalExports: ['test', 'request', 'chromium'],
      backendGuardPath: join(candidateWorkspace, 'benchmarks/native-backend-guard.mjs') },
  });
}

/** Resolve the frontend alias and workspace canonical package before installing the native backend guard. */
export function renderBackendCorpusCandidateConfiguration(options) {
  const normalized = candidateOptions(options);
  const configuration = createBackendCorpusCandidateConfigurationData(normalized);
  const guardURL = pathToFileURL(join(normalized.candidateWorkspace, 'benchmarks/native-backend-guard.mjs')).href;
  return `import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { forbidUpstreamBrowserBackend } from ${JSON.stringify(guardURL)};
if (resolve(process.cwd()) !== ${JSON.stringify(normalized.frontendDirectory)})
  throw new Error('Run the candidate from its frontend directory; root controls auth-file freshness');
const requireFrontendPackage = createRequire(${JSON.stringify(join(normalized.frontendDirectory, 'package.json'))});
const requireCandidatePackage = createRequire(${JSON.stringify(join(normalized.candidateWorkspace, 'package.json'))});
const frontendPackage = requireFrontendPackage('@playwright/test');
const canonicalPackage = requireCandidatePackage('@flashwright/test');
(${verifyBackendCorpusCandidateIdentity.toString()})(frontendPackage, canonicalPackage);
forbidUpstreamBrowserBackend();
const { defineConfig, devices } = frontendPackage;
const configuration = ${JSON.stringify(configuration, null, 2)};
configuration.projects[1].use = { ...devices['Desktop Chrome'], ...configuration.projects[1].use };
export default defineConfig(configuration);
`;
}

/** Candidate metadata is checked independently while every original report/result object remains retained. */
export function analyzeBackendCorpusCandidateReport(report, options) {
  const normalized = candidateOptions(options);
  const analysis = analyzeBackendCorpusReport(report, normalized, createBackendCorpusCandidateConfigurationData(normalized), {
    key: 'backendCorpusCandidate', rejectReference: true,
    mismatchMessage: 'Declared candidate metadata differs; metadata alone does not prove native execution',
  });
  return { ...analysis, engine: 'flashwright', executionClass: 'development-alias-functional-diagnosis',
    scope: `${analysis.scope} Candidate alias/canonical identities and installed backend guard require independent execution evidence. This development overlay does not establish packed adoption.` };
}
