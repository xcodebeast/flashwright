import { runnerGlobals, upstreamRequire } from './upstream-runtime.js';
import { runnerIntegration } from '@flashwright/core/runner-integration';
import type { TestInfo } from 'flashwright-upstream-runner/test';

type ActionObserver = Parameters<typeof runnerIntegration.installActionObserver>[1];
type ActionMetadata = Parameters<ActionObserver['begin']>[0];
interface PinnedStep {
  stepId: string;
  category: string;
  title: string;
  shortTitle?: string;
  complete(result: { error?: unknown }): void;
}
interface PinnedTestInfo extends TestInfo {
  _addStep(data: {
    location?: ActionMetadata['stack'][number] | undefined;
    category: 'pw:api';
    title: string;
    apiName: string;
    params: ActionMetadata['parameters'];
    group?: string | undefined;
  }): PinnedStep;
}

const { utils, iso } = upstreamRequire('playwright-core/lib/coreBundle') as {
  utils: { currentZone(): { data(name: 'stepZone'): PinnedStep | undefined } };
  iso: {
    renderTitleForCall(call: { type: string; method: string; params: ActionMetadata['parameters'] }): string;
    asLocatorDescription(language: 'javascript', selector: string): string;
    getActionGroup(call: { type: string; method: string }): string | undefined;
  };
};

/** Pinned 1.60.0 step association; public expect wrappers retain their existing completion owner. */
export function installTraceSteps(testInfo: TestInfo): () => void {
  return runnerIntegration.installActionObserver(2, {
    begin(metadata) {
      if (runnerGlobals.currentTestInfo() !== testInfo) return undefined;
      const parent = utils.currentZone().data('stepZone');
      if (parent?.category === 'expect' && ['locator._expect', 'frame._expect'].includes(metadata.apiName)) {
        return { stepId: parent.stepId, title: parent.shortTitle ?? parent.title, complete() {} };
      }
      const selector = typeof metadata.parameters.selector === 'string' ? iso.asLocatorDescription('javascript', metadata.parameters.selector) : undefined;
      const title = iso.renderTitleForCall({ type: metadata.className, method: metadata.method, params: metadata.parameters }) + (selector ? ` ${selector}` : '');
      const step = (testInfo as PinnedTestInfo)._addStep({
        location: metadata.stack[0], category: 'pw:api', title, apiName: metadata.apiName,
        params: metadata.parameters, group: iso.getActionGroup({ type: metadata.className, method: metadata.method }),
      });
      return { stepId: step.stepId, title, complete: error => step.complete({ error }) };
    },
  });
}
