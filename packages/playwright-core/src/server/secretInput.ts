/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { ElementHandle } from './dom';
import { Page } from './page';

import type { SdkObject } from './instrumentation';
import type { Progress } from './progress';

// Flashwright: whether an action types into a password field, so that `playwright test --video`
// can leave the text out of its captions. Asked only for the actions that type text, and only
// while a video follows the actions.

const kElementMethods = new Set(['fill', 'type']);
const kKeyboardMethods = new Set(['keyboardType', 'keyboardInsertText']);

export async function isSecretInput(progress: Progress, sdkObject: SdkObject): Promise<boolean> {
  const method = progress.metadata.method;
  try {
    if (sdkObject instanceof ElementHandle && kElementMethods.has(method)) {
      const result = await progress.race(sdkObject.evaluateInUtility(([injected, node]) => {
        const element = injected.retarget(node, 'follow-label');
        return !!element && element.nodeName === 'INPUT' && ((element as HTMLInputElement).type.toLowerCase() === 'password' || /\b(current|new)-password\b/i.test(element.getAttribute('autocomplete') ?? ''));
      }, {}));
      return result === true;
    }
    if (sdkObject instanceof Page && kKeyboardMethods.has(method)) {
      // Only the focused element of the main frame and its shadow roots; typing inside a child frame is not checked.
      const utility = await progress.race(sdkObject.mainFrame().utilityContext());
      return await progress.race(utility.evaluate(() => {
        let element = document.activeElement;
        while (element?.shadowRoot?.activeElement)
          element = element.shadowRoot.activeElement;
        return !!element && element.nodeName === 'INPUT' && ((element as HTMLInputElement).type.toLowerCase() === 'password' || /\b(current|new)-password\b/i.test(element.getAttribute('autocomplete') ?? ''));
      }));
    }
  } catch {
  }
  return false;
}
