const { join } = require('node:path');
const modules = process.env.FLASHWRIGHT_PUBLIC_BOUNDARY_MODULES;
const { test: base } = require(join(modules, 'index.js'));
const scenario = process.env.FLASHWRIGHT_PUBLIC_BOUNDARY_CASE;
const delayedArtifacts = scenario.startsWith('slow-');
const test = base.extend({ boundaryFixture: [async ({}, use) => {
  if (!delayedArtifacts && scenario !== 'video') console.log('UNEXPECTED_PUBLIC_FIXTURE');
  await use();
}, { scope: 'worker', auto: true }] });
test.beforeAll(() => { if (!delayedArtifacts) console.log('UNEXPECTED_PUBLIC_HOOK'); });

if (scenario === 'slow-readiness') {
  const { RunnerArtifactCoordinator } = require(join(modules, 'runner-artifact-coordinator.js'));
  const originalReady = RunnerArtifactCoordinator.prototype.ready;
  RunnerArtifactCoordinator.prototype.ready = async function() {
    await new Promise(resolve => setTimeout(resolve, 700));
    await Reflect.apply(originalReady, this, []);
  };
  test('passing test survives slow artifact readiness', async () => {
    console.log('ORIGINAL_TEST_BODY_REACHED');
  });
} else if (scenario === 'slow-disposal') {
  const { RunnerArtifactCoordinator } = require(join(modules, 'runner-artifact-coordinator.js'));
  const originalDispose = RunnerArtifactCoordinator.prototype.dispose;
  RunnerArtifactCoordinator.prototype.dispose = async function() {
    await new Promise(resolve => setTimeout(resolve, 700));
    await Reflect.apply(originalDispose, this, []);
    console.log('ORIGINAL_ARTIFACT_DISPOSAL_SETTLED');
  };
  test('original failure survives slow artifact disposal', async () => {
    throw new Error('original boundary failure');
  });
} else {
  test('invalid artifact policy never reaches the test body', async () => {
    console.log('UNEXPECTED_PUBLIC_TEST_BODY');
  });
}
