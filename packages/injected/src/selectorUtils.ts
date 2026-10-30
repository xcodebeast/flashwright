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

import { normalizeWhiteSpace } from '@isomorphic/stringUtils';

import { getElementLabelElements } from './domUtils';
import { getAriaLabelledByElements } from './roleUtils';

import type { AttributeSelectorPart } from '@isomorphic/selectorParser';

export function matchesComponentAttribute(obj: any, attr: AttributeSelectorPart) {
  for (const token of attr.jsonPath) {
    if (obj !== undefined && obj !== null)
      obj = obj[token];
  }
  return matchesAttributePart(obj, attr);
}

export function matchesAttributePart(value: any, attr: AttributeSelectorPart) {
  const objValue = typeof value === 'string' && !attr.caseSensitive ? value.toUpperCase() : value;
  const attrValue = typeof attr.value === 'string' && !attr.caseSensitive ? attr.value.toUpperCase() : attr.value;

  if (attr.op === '<truthy>')
    return !!objValue;
  if (attr.op === '=') {
    if (attrValue instanceof RegExp) {
      attrValue.lastIndex = 0;
      return typeof objValue === 'string' && !!objValue.match(attrValue);
    }
    return objValue === attrValue;
  }
  if (typeof objValue !== 'string' || typeof attrValue !== 'string')
    return false;
  if (attr.op === '*=')
    return objValue.includes(attrValue);
  if (attr.op === '^=')
    return objValue.startsWith(attrValue);
  if (attr.op === '$=')
    return objValue.endsWith(attrValue);
  if (attr.op === '|=')
    return objValue === attrValue || objValue.startsWith(attrValue + '-');
  if (attr.op === '~=')
    return objValue.split(' ').includes(attrValue);
  return false;
}

export function shouldSkipForTextMatching(element: Element | ShadowRoot) {
  const document = element.ownerDocument;
  return element.nodeName === 'SCRIPT' || element.nodeName === 'NOSCRIPT' || element.nodeName === 'STYLE' || document.head && document.head.contains(element);
}

export type ElementText = { full: string, normalized: string, immediate: string[] };
export type TextMatcher = (text: ElementText) => boolean;

// Flashwright: the first time the text of an element is needed, the texts of all the elements below
// it are built, while a query looks at the normalized text of only a few of them: the text is
// normalized on first use. Whether an element is skipped follows from its parent, without looking
// for each element in the document's head.
class ElementTextData implements ElementText {
  full = '';
  immediate: string[] = [];
  private _normalized: string | undefined;

  get normalized(): string {
    if (this._normalized === undefined)
      this._normalized = this.full ? normalizeWhiteSpace(this.full) : '';
    return this._normalized;
  }
}

const kSkippedForTextMatching = new Set(['SCRIPT', 'NOSCRIPT', 'STYLE']);

export function elementText(cache: Map<Element | ShadowRoot, ElementText>, root: Element | ShadowRoot): ElementText {
  return computeElementText(cache, root, undefined);
}

function computeElementText(cache: Map<Element | ShadowRoot, ElementText>, root: Element | ShadowRoot, skipped: boolean | undefined): ElementText {
  let value = cache.get(root);
  if (value === undefined) {
    const data = new ElementTextData();
    value = data;
    if (!(skipped ?? shouldSkipForTextMatching(root))) {
      let currentImmediate = '';
      if ((root instanceof HTMLInputElement) && (root.type === 'submit' || root.type === 'button' || root.type === 'reset')) {
        value = { full: root.value, normalized: normalizeWhiteSpace(root.value), immediate: [root.value] };
      } else {
        // The root is not in the head: a child is when it is the head.
        const head = root.ownerDocument.head;
        for (let child = root.firstChild; child; child = child.nextSibling) {
          if (child.nodeType === Node.TEXT_NODE) {
            data.full += child.nodeValue || '';
            currentImmediate += child.nodeValue || '';
          } else if (child.nodeType === Node.COMMENT_NODE) {
            continue;
          } else {
            if (currentImmediate)
              data.immediate.push(currentImmediate);
            currentImmediate = '';
            if (child.nodeType === Node.ELEMENT_NODE)
              data.full += computeElementText(cache, child as Element, kSkippedForTextMatching.has(child.nodeName) || child === head).full;
          }
        }
        if (currentImmediate)
          data.immediate.push(currentImmediate);
        if ((root as Element).shadowRoot)
          data.full += computeElementText(cache, (root as Element).shadowRoot!, false).full;
      }
    }
    cache.set(root, value);
  }
  return value;
}

export function elementMatchesText(cache: Map<Element | ShadowRoot, ElementText>, element: Element, matcher: TextMatcher): 'none' | 'self' | 'selfAndChildren' {
  // A custom engine may have moved the element since its text was cached.
  if (shouldSkipForTextMatching(element))
    return 'none';
  if (!matcher(elementText(cache, element)))
    return 'none';
  for (let child = element.firstChild; child; child = child.nextSibling) {
    if (child.nodeType === Node.ELEMENT_NODE && matcher(elementText(cache, child as Element)))
      return 'selfAndChildren';
  }
  if (element.shadowRoot && matcher(elementText(cache, element.shadowRoot)))
    return 'selfAndChildren';
  return 'self';
}

export function getElementLabels(textCache: Map<Element | ShadowRoot, ElementText>, element: Element, options?: { skipRefsInsideElement?: boolean }): ElementText[] {
  let labels = getAriaLabelledByElements(element);
  if (labels) {
    if (options?.skipRefsInsideElement)
      labels = labels.filter(label => label !== element && !element.contains(label));
    return labels.map(label => elementText(textCache, label));
  }
  const ariaLabel = element.getAttribute('aria-label');
  if (ariaLabel !== null && !!ariaLabel.trim())
    return [{ full: ariaLabel, normalized: normalizeWhiteSpace(ariaLabel), immediate: [ariaLabel] }];

  // https://html.spec.whatwg.org/multipage/forms.html#category-label
  const isNonHiddenInput = element.nodeName === 'INPUT' && (element as HTMLInputElement).type !== 'hidden';
  if (['BUTTON', 'METER', 'OUTPUT', 'PROGRESS', 'SELECT', 'TEXTAREA'].includes(element.nodeName) || isNonHiddenInput) {
    const labels = getElementLabelElements(element);
    if (labels)
      return [...labels].map(label => elementText(textCache, label));
  }
  return [];
}
