import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { verifyBunWebViewSample } from '../benchmarks/bun-webview-sampling-contract.mjs';
import { bunWebViewPin, bunWebViewNativeLaunchPolicy, bunWebViewOptions, bunWebViewDraftClassifications } from '../benchmarks/bun-webview-workloads.mjs';

const configuration = JSON.parse(await readFile(new URL('../benchmarks/configurations/baseline.json', import.meta.url), 'utf8'));
function fixture() {
  const iterations = configuration.warmupIterations + configuration.measuredIterations;
  const samples = count => Array.from({ length: count }, (_, iteration) => ({ iteration, milliseconds: 1 }));
  return {
    schemaVersion: 1, engine: 'bun-webview', classification: 'linux-native-chrome-library-observation', status: 'completed-native-observations',
    configuration, runtime: { ...bunWebViewPin, sha256: 'a'.repeat(64) },
    browser: { version: configuration.browserVersion, distribution: 'chromium-headless-shell', executablePath: '/test/chrome-headless-shell', sha256: 'b'.repeat(64) },
    options: bunWebViewOptions('/test/chrome-headless-shell', configuration.viewport), nativeLaunchPolicy: bunWebViewNativeLaunchPolicy,
    classifications: bunWebViewDraftClassifications(), equivalentWorkAdmission: false, resourceAdmission: false, performanceAccepted: false,
    selectedInputsUnchanged: true, failures: [],
    sampling: { launchIndex: 0, reportPersistence: 'after-completion', isolationProbe: 'separate-admission', protocolLogging: 'off' },
    workloads: configuration.workloads.map(name => ({
      name, samples: samples(configuration.measuredIterations), warmupSamples: samples(configuration.warmupIterations), failures: [],
      preparationMilliseconds: 1, observationMilliseconds: 1, closeRequestMilliseconds: 1, completeMilliseconds: iterations + 5,
      observations: name === 'setup' ? { freshViews: iterations, freshContexts: null, isolation: 'unadmitted-shared-default-browser-context' } : {
        viewport: configuration.viewport, untrustedClicks: 0, untrustedChanges: 0,
        applicationCount: name === 'interaction' ? iterations : 0,
        trustedClicks: ['interaction', 'backend'].includes(name) ? iterations : 0,
        trustedChanges: name === 'backend' ? iterations : 0,
        expectedFailures: name === 'failure' ? Array.from({ length: iterations }, () => ({ operation: 'click', selector: '#missing', timeout: configuration.expectedFailureTimeoutMilliseconds, message: "timeout waiting for '#missing' to be actionable", stack: 'native timeout stack' })) : [],
      },
    })),
    createdViews: iterations + 6, backend: { documents: iterations * 2 + 6, backendRequests: iterations, otherRequests: 0 },
    cleanupRequestMilliseconds: 2, completeHostMilliseconds: 200,
  };
}

test('native timing outcomes remain separate from equivalence and performance acceptance', () => {
  assert.deepEqual(verifyBunWebViewSample(fixture(), configuration), {
    status: 'verified-native-sampling-outcomes', equivalentWorkAdmission: false, resourceAdmission: false, performanceAccepted: false,
  });
});

for (const [name, corrupt] of Object.entries({
  'omitted workload': r => r.workloads.pop(),
  'omitted sample': r => r.workloads[0].samples.pop(),
  'repeated iteration': r => r.workloads[0].samples[1].iteration = 0,
  'invalid duration': r => r.workloads[0].samples[0].milliseconds = NaN,
  'overlapping duration': r => r.workloads[0].completeMilliseconds = 1,
  'unexpected failure': r => r.failures.push('browser closed'),
  'wrong native failure': r => r.workloads.at(-1).observations.expectedFailures[0].message = 'WebView closed',
  'missing backend request': r => r.backend.backendRequests--,
  'untrusted input': r => r.workloads[1].observations.untrustedClicks++,
  'missing application change': r => r.workloads[1].observations.applicationCount--,
  'fake fresh context': r => r.workloads[4].observations.freshContexts = 15,
  'missing created view': r => r.createdViews--,
  'changed source': r => r.selectedInputsUnchanged = false,
  'wrong launch order': r => r.sampling.launchIndex = 1,
  'claimed equivalence': r => r.equivalentWorkAdmission = true,
  'claimed performance': r => r.performanceAccepted = true,
})) test(`sampling rejects ${name}`, () => {
  const report = structuredClone(fixture()); corrupt(report);
  assert.throws(() => verifyBunWebViewSample(report, configuration));
});
