import { backendCorpusInventory, normalizeBackendCorpusOptions, createBackendCorpusConfigurationData,
  analyzeBackendCorpusReport } from './backend-corpus-common.mjs';
import { join } from 'node:path';

export const backendCorpusReferenceInventory = backendCorpusInventory;

/** Build reference policy data; root owns services, output freshness and the relative auth file. */
export function createBackendCorpusReferenceConfigurationData(options) {
  const normalized = normalizeBackendCorpusOptions(options);
  const { frontendDirectory, backendURL, workers } = normalized;
  return createBackendCorpusConfigurationData(normalized, {
    backendCorpusReference: { sourceCommit: backendCorpusInventory.commit, playwrightVersion: '1.60.0',
      declaredBrowserVersion: '148.0.7778.96', declaredBrowserDistribution: 'chrome-for-testing-full',
      frontendDirectory, backendURL, workers },
  });
}

/** Render a config outside the app without resolving a different Playwright installation or changing cwd. */
export function renderBackendCorpusReferenceConfiguration(options) {
  const normalized = normalizeBackendCorpusOptions(options);
  const configuration = createBackendCorpusReferenceConfigurationData(normalized);
  return `import { createRequire } from 'node:module';
import { resolve } from 'node:path';
if (resolve(process.cwd()) !== ${JSON.stringify(normalized.frontendDirectory)})
  throw new Error('Run the reference from the original frontend directory; root controls auth-file freshness');
const requireReferencePackage = createRequire(${JSON.stringify(join(normalized.frontendDirectory, 'package.json'))});
if (requireReferencePackage('@playwright/test/package.json').version !== '1.60.0')
  throw new Error('The reference requires the pinned Playwright 1.60.0 installation');
const { defineConfig, devices } = requireReferencePackage('@playwright/test');
const configuration = ${JSON.stringify(configuration, null, 2)};
configuration.projects[1].use = { ...devices['Desktop Chrome'], ...configuration.projects[1].use };
export default defineConfig(configuration);
`;
}

/** Preserve the reference API and its original outcome/metadata diagnostics. */
export function analyzeBackendCorpusReferenceReport(report, options) {
  return analyzeBackendCorpusReport(report, options, createBackendCorpusReferenceConfigurationData(options), {
    key: 'backendCorpusReference',
    mismatchMessage: 'Declared reference metadata differs; metadata alone does not prove browser execution',
  });
}
