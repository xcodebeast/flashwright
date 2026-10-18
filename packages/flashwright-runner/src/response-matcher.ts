import { failure } from '@flashwright/core';
import { runnerIntegration } from '@flashwright/core/runner-integration';
import type { ExpectMatcherState, MatcherReturnType } from 'flashwright-upstream-runner/test';
import { upstreamRequire } from './upstream-runtime.js';

const { iso } = upstreamRequire('playwright-core/lib/coreBundle') as { iso: { isTextualMimeType(value: string): boolean } };

/** Immutable status is checked once. Read body diagnostics only for a failing assertion. */
export async function toBeOK(this: ExpectMatcherState, actual: unknown): Promise<MatcherReturnType> {
  if (!runnerIntegration.isAPIResponse(14, actual)) throw failure('InvalidArgumentError', 'expect.toBeOK', 'expected a Flashwright APIResponse');
  const pass = actual.ok();
  let text: string | undefined;
  if (pass === this.isNot) {
    const contentType = actual.headers()['content-type'];
    if (contentType && iso.isTextualMimeType(contentType)) text = (await actual.text()).substring(0, 1000);
  }
  return {
    name: 'toBeOK', pass,
    message: () => [
      this.utils.matcherHint('toBeOK', 'response', '', { isNot: this.isNot, promise: this.promise }),
      `URL: ${actual.url()}`,
      `Received status: ${actual.status()} ${actual.statusText()}`,
      ...(text === undefined ? [] : ['Response text:', text]),
    ].join('\n'),
  };
}
