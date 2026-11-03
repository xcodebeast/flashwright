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

import { asLocator } from '@isomorphic/locatorGenerators';
import { parseAttributeSelector, stringifySelector } from '@isomorphic/selectorParser';
import { normalizeWhiteSpace } from '@isomorphic/stringUtils';

import { beginAriaCaches, endAriaCaches, getElementAccessibleNameText } from './roleUtils';

import type { Language } from '@isomorphic/locatorGenerators';
import type { ParsedSelector, ParsedSelectorPart } from '@isomorphic/selectorParser';
import type { InjectedScript } from './injectedScript';

// Flashwright: when a locator never matched, say what the page has instead. Runs once, after the
// action or assertion has failed, so it only adds lines to the call log and costs nothing before.

const kMaxCandidates = 3;
const kMaxScanned = 3000;

export function explainNoMatch(injected: InjectedScript, language: Language, selector: ParsedSelector, root: Node): string[] {
  const parts = selector.parts;
  if (!parts.length || selector.capture !== undefined)
    return [];
  const locator = (parts: ParsedSelectorPart[]) => asLocator(language, stringifySelector({ parts }));
  const lines: string[] = [];

  // The longest start of the chain that still matches tells which step loses the element.
  let scopes: Node[] = [root];
  let failing = 0;
  for (let k = parts.length - 1; k >= 1; --k) {
    const elements = injected.querySelectorAll({ parts: parts.slice(0, k) }, root);
    if (elements.length) {
      scopes = elements;
      failing = k;
      break;
    }
  }
  const part = parts[failing];
  if (failing > 0) {
    const prefix = locator(parts.slice(0, failing));
    const count = `${scopes.length} element${scopes.length === 1 ? '' : 's'}`;
    if (part.name === 'nth')
      lines.push(`${prefix} matches ${count}, none at index ${part.body}`);
    else if (part.name === 'visible')
      lines.push(`${prefix} matches ${count}, none of ${scopes.length === 1 ? 'it' : 'them'} ${part.body === 'true' ? 'visible' : 'hidden'}`);
    else
      lines.push(`${prefix} matches ${count}, but ${locator([part])} inside ${scopes.length === 1 ? 'it' : 'them'} matches none`);
  }

  let candidatesFound = false;
  beginAriaCaches();
  try {
    const query = (body: string, name = part.name) => {
      const result = new Set<Element>();
      for (const scope of scopes) {
        for (const element of injected.querySelectorAll({ parts: [{ name, body, source: `${name}=${body}` }] }, scope))
          result.add(element);
      }
      return [...result];
    };
    const described = new Set<Element>();
    const describe = (elements: Element[], label: string) => {
      elements = elements.filter(e => !described.has(e));
      if (!elements.length)
        return;
      elements.forEach(e => described.add(e));
      candidatesFound = true;
      const shown = elements.slice(0, kMaxCandidates).map(e => asLocator(language, injected.generateSelectorSimple(e)));
      lines.push(`${label}: ${shown.join(', ')}${elements.length > shown.length ? `, and ${elements.length - shown.length} more` : ''}`);
    };

    if (part.name === 'internal:role' && typeof part.body === 'string') {
      const parsed = parseAttributeSelector(part.body, true);
      const includesHidden = parsed.attributes.some(a => a.name === 'include-hidden');
      if (!includesHidden) {
        const hidden = query(part.body + '[include-hidden=true]');
        if (hidden.length)
          lines.push(`${hidden.length === 1 ? 'a hidden element matches' : `${hidden.length} hidden elements match`}: ${hidden.slice(0, 2).map(e => injected.previewNode(e)).join(', ')}`);
      }
      const nameAttribute = parsed.attributes.find(a => a.name === 'name');
      if (nameAttribute && typeof nameAttribute.value === 'string') {
        const sameRole = query(parsed.name + (includesHidden ? '[include-hidden=true]' : ''));
        const ranked = rank(String(nameAttribute.value), sameRole, e => getElementAccessibleNameText(e, includesHidden));
        if (ranked.length)
          describe(ranked, `similar ${parsed.name}s`);
        else if (sameRole.length)
          describe(sameRole, `${parsed.name}s on the page`);
        else
          lines.push(`no ${parsed.name} ${failing ? `inside ${scopes.length === 1 ? 'it' : 'them'}` : 'on the page'}`);
      }
    } else if (part.name === 'internal:text' || part.name === 'internal:label' || part.name === 'internal:attr' || part.name === 'internal:testid') {
      const target = textTarget(part);
      if (target) {
        if (target.exact) {
          const loose = query(target.looseBody);
          if (loose.length)
            describe(loose, 'matches without exact');
        }
        const candidates = collectCandidates(injected, part.name, target.attribute, scopes);
        const ranked = rank(target.text, candidates.map(c => c.element), e => candidates.find(c => c.element === e)!.value);
        if (ranked.length)
          describe(ranked, 'similar elements');
      }
    }
  } catch {
    // An explanation is best effort; the failure is reported either way.
  } finally {
    endAriaCaches();
  }

  if (failing === 0 && !candidatesFound) {
    const document = root.nodeType === 9 /* Node.DOCUMENT_NODE */ ? root as Document : root.ownerDocument;
    if (document?.querySelector('iframe'))
      lines.push(`the page has iframes; elements inside them need frameLocator()`);
  }
  return lines;
}

function textTarget(part: ParsedSelectorPart): { text: string, exact: boolean, looseBody: string, attribute?: string } | undefined {
  if (typeof part.body !== 'string')
    return;
  if (part.name === 'internal:text' || part.name === 'internal:label') {
    const match = part.body.match(/^"((?:[^"\\]|\\.)*)"([is]?)$/);
    if (!match)
      return;
    const text = JSON.parse('"' + match[1] + '"') as string;
    return { text, exact: match[2] === 's', looseBody: `"${match[1]}"i` };
  }
  const parsed = parseAttributeSelector(part.body, true);
  const attribute = parsed.attributes[0];
  if (!attribute || typeof attribute.value !== 'string')
    return;
  return { text: attribute.value, exact: attribute.caseSensitive && attribute.op === '=', looseBody: `[${attribute.name}=${JSON.stringify(attribute.value)}i]`, attribute: attribute.name };
}

function collectCandidates(injected: InjectedScript, engine: string, attribute: string | undefined, scopes: Node[]): { element: Element, value: string }[] {
  const result: { element: Element, value: string }[] = [];
  let scanned = 0;
  for (const scope of scopes) {
    const document = scope.ownerDocument ?? scope as Document;
    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_ELEMENT);
    for (let node = walker.nextNode(); node && scanned < kMaxScanned; node = walker.nextNode(), ++scanned) {
      const element = node as Element;
      let value: string | null = null;
      if (engine === 'internal:text') {
        // Elements with their own text, so that a match is the element that holds it.
        if ([...element.childNodes].some(child => child.nodeType === 3 /* Node.TEXT_NODE */ && child.nodeValue!.trim()) && !['SCRIPT', 'STYLE', 'NOSCRIPT'].includes(element.nodeName))
          value = (element as HTMLElement).innerText ?? element.textContent;
      } else if (engine === 'internal:label') {
        if (['INPUT', 'TEXTAREA', 'SELECT'].includes(element.nodeName) || element.getAttribute('role') === 'textbox')
          value = getElementAccessibleNameText(element, false);
      } else if (attribute) {
        value = element.getAttribute(attribute);
      }
      if (value && normalizeWhiteSpace(value))
        result.push({ element, value: normalizeWhiteSpace(value) });
    }
  }
  return result;
}

function rank(target: string, elements: Element[], valueOf: (e: Element) => string): Element[] {
  const wanted = normalizeWhiteSpace(target).toLowerCase();
  if (!wanted)
    return [];
  const scored = elements.map(element => {
    const value = normalizeWhiteSpace(valueOf(element)).toLowerCase();
    if (!value || value.length > 200)
      return { element, score: 0 };
    const compactValue = compact(value);
    const compactWanted = compact(wanted);
    let score = value.includes(wanted) || wanted.includes(value) ? 1 : dice(wanted, value);
    if (score < 0.9 && compactValue && compactWanted && (compactValue.includes(compactWanted) || compactWanted.includes(compactValue)))
      score = 0.9;
    return { element, score };
  }).filter(s => s.score >= 0.4);
  scored.sort((a, b) => b.score - a.score);
  return scored.map(s => s.element);
}

function compact(text: string): string {
  return text.replace(/[^\p{L}\p{N}]/gu, '');
}

// Similarity of two strings by their shared pairs of letters, from 0 to 1.
function dice(a: string, b: string): number {
  if (a.length < 2 || b.length < 2)
    return a === b ? 1 : 0;
  const pairs = new Map<string, number>();
  for (let i = 0; i < a.length - 1; ++i) {
    const pair = a.substring(i, i + 2);
    pairs.set(pair, (pairs.get(pair) ?? 0) + 1);
  }
  let shared = 0;
  for (let i = 0; i < b.length - 1; ++i) {
    const pair = b.substring(i, i + 2);
    const count = pairs.get(pair) ?? 0;
    if (count > 0) {
      pairs.set(pair, count - 1);
      ++shared;
    }
  }
  return 2 * shared / (a.length + b.length - 2);
}
