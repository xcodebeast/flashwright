import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { startResidentLoadFixture } from './resident-load-fixture.mjs';
import { readEngineConfiguration } from '../tools/engine-configuration.mjs';
import { loadExecutionBudget } from './resident-load-contract.mjs';
import { forbidUpstreamBrowserBackend } from './native-backend-guard.mjs';

const configuration = JSON.parse(await readFile(new URL('./configurations/resident-load.json', import.meta.url), 'utf8'));
const [mode, workload, count, group, executionPurpose = 'comparison'] = process.argv.slice(2);
assert.ok(['comparison', 'functional-conformance'].includes(executionPurpose));
const budget = loadExecutionBudget(configuration, executionPurpose === 'functional-conformance');
const scenario = { workload, conditionCount: Number(count) };
assert.ok(['playwright', 'flashwright-off', 'flashwright-on'].includes(mode));
assert.ok(configuration.workloads.includes(workload));
assert.ok(configuration.conditionCounts.includes(scenario.conditionCount));
const engine = mode === 'playwright' ? 'playwright' : 'flashwright';
let chromium;
let expect;
if (engine === 'flashwright') {
  forbidUpstreamBrowserBackend();
  ({ chromium } = await import('flashwright'));
  ({ expect } = await import('@flashwright/test'));
} else ({ chromium, expect } = await import('@playwright/test'));

const started = performance.now();
const fixture = await startResidentLoadFixture(configuration, scenario);
const result = { schemaVersion: 2, executionPurpose, assertionTimeoutMilliseconds: budget.assertionTimeoutMilliseconds,
  mode, engine, scenario, launchGroup: Number(group), engineConfiguration: readEngineConfiguration(),
  assertionsStarted: 0, assertionsCompleted: 0, failures: [] };
let browser;
try {
  const launchStarted = performance.now();
  browser = await chromium.launch({ executablePath: process.env.FLASHWRIGHT_BROWSER_PATH, headless: configuration.headless });
  result.launchMilliseconds = performance.now() - launchStarted;
  result.browserVersion = browser.version();
  const context = await browser.newContext({ viewport: configuration.viewport });
  const page = await context.newPage();
  await page.goto(fixture.origin + '/fixture');
  const property = workload === 'property-only';
  const assertValue = (locator, expected) => property ? expect(locator).toHaveValue(expected, { timeout: budget.assertionTimeoutMilliseconds })
    : expect(locator).toHaveText(expected, { timeout: budget.assertionTimeoutMilliseconds });
  await assertValue(page.locator('.probe').nth(configuration.elementCount - 1), 'before');
  result.warmupAssertions = 1;
  result.preparationMilliseconds = performance.now() - started;
  const operationStarted = performance.now();
  await page.evaluate(() => window.beginLoad());
  const assertions = [];
  for (let index = 0; index < scenario.conditionCount; index++) {
    result.assertionsStarted++;
    const locator = page.locator('.probe').nth(configuration.elementCount - scenario.conditionCount + index);
    assertions.push(assertValue(locator, 'after').then(() => { result.assertionsCompleted++; }));
  }
  const outcomes = await Promise.allSettled(assertions);
  result.operationMilliseconds = performance.now() - operationStarted;
  for (const outcome of outcomes) if (outcome.status === 'rejected') result.failures.push(String(outcome.reason?.stack ?? outcome.reason));
  result.observations = await page.evaluate(({ property, conditionCount }) => {
    const elements = [...document.querySelectorAll('.probe')];
    const values = elements.map(element => property ? element.value : element.textContent);
    return { ...window.observations, observedAt: performance.now(), elementCount: elements.length,
      afterCount: values.filter(value => value === 'after').length, beforeCount: values.filter(value => value === 'before').length,
      targetValues: values.slice(-conditionCount) };
  }, { property, conditionCount: scenario.conditionCount });
  // This private read is solely for separately labeled diagnostic runs. Ordinary
  // resource samples disable counters and never execute an extra assertion here.
  if (process.env.FLASHWRIGHT_LOAD_DIAGNOSTICS === '1') {
    assert.equal(mode, 'flashwright-on');
    assert.equal(result.engineConfiguration.conditionInstrumentation, true);
    const request = JSON.stringify({ selector: `css=.probe >> nth=${configuration.elementCount - 1}`, expectedText: [{ string: 'after', normalizeWhiteSpace: !property }] });
    const observation = await browser.client.request('assertion.run', { page: page.identifier, frame: page.mainFrame().snapshot.identifier,
      expression: property ? 'to.have.value' : 'to.have.text', isNot: false,
      request: Array.from({ length: request.length }, (_, index) => request.charCodeAt(index)) }, budget.assertionTimeoutMilliseconds);
    result.conditionMetrics = observation.conditionMetrics;
    result.diagnosticScope = 'Counters enabled throughout; final immediate audit adds one predicate evaluation. Timing/resources are diagnostic, not production comparison samples.';
  }
  await context.close();
} catch (error) { result.failures.push(String(error.stack ?? error)); }
finally {
  const cleanupStarted = performance.now();
  try { await browser?.close(); } catch (error) { result.failures.push(String(error.stack ?? error)); }
  try { await fixture.close(); } catch (error) { result.failures.push(String(error.stack ?? error)); }
  result.cleanupMilliseconds = performance.now() - cleanupStarted;
  result.completeMilliseconds = performance.now() - started;
  result.backend = fixture.counts;
  process.stdout.write(JSON.stringify(result) + '\n');
  process.exitCode = result.failures.length ? 1 : 0;
}
