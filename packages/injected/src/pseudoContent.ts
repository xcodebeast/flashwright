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

// Flashwright: computing the style of an element's ::before or ::after pseudo-element is costly,
// and an accessible name asks for both, for every element it visits: on a page of 8,500 elements,
// that was a third of a role query with a name. Only an element that a rule giving one of them a
// `content` can match has pseudo-element content, apart from <q>'s built-in quotes. The rules are
// collected once per evaluation, from the style sheets of the element's document or shadow root,
// and an element is checked against them first. Anything the collection cannot follow, like a
// cross-origin style sheet, nested rules or shadow-tree selectors, keeps the full lookup, and so do
// the elements that styles the collection cannot see can reach: the shadow tree of a host, also a
// closed one, styles the host (:host::before) and what is slotted into it (::slotted(*)::before).
// Only the utility world, where page scripts cannot change what style sheets look like, and only a
// browser launched without extensions, which can add styles no style sheet lists, take the shortcut.

import { getGlobalOptions } from './domUtils';

// What a document or shadow root's style sheets can give content to: every element, or the
// elements that have one of the ids, classes or tags that the targeted selectors end with, or that
// match one of the selectors without any (`generic`).
type Matcher = { all: true } | { all: false, ids: Set<string>, classes: Set<string>, tags: Set<string>, generic: string | undefined };

let cacheMatchers: Map<Document | ShadowRoot, Matcher> | undefined;
let cacheAnimatedPseudoElements: Map<Document | ShadowRoot, Set<Element>> | undefined;
let cachesCounter = 0;

export function beginPseudoContentCaches() {
  ++cachesCounter;
  cacheMatchers ??= new Map();
  cacheAnimatedPseudoElements ??= new Map();
}

export function endPseudoContentCaches() {
  if (!--cachesCounter) {
    cacheMatchers = undefined;
    cacheAnimatedPseudoElements = undefined;
  }
}

// https://dom.spec.whatwg.org/#valid-shadow-host-name
const kShadowHostNames = new Set(['article', 'aside', 'blockquote', 'body', 'div', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'main', 'nav', 'p', 'section', 'span']);

function mayBeShadowHost(element: Element) {
  return kShadowHostNames.has(element.localName) || element.localName.includes('-');
}

export function mayHavePseudoContent(element: Element): boolean {
  // Only Chromium's built-in styles were checked: of all elements, they give content to <q>'s.
  const options = getGlobalOptions();
  if (options.browserNameForWorkarounds !== 'chromium' || !options.isUtilityWorld || !options.noExtensionStyles || !cacheMatchers)
    return true;
  if (element.localName === 'q')
    return true;
  const parent = element.parentElement;
  if (mayBeShadowHost(element) || (parent && mayBeShadowHost(parent)))
    return true;
  const root = element.getRootNode();
  const isShadowRoot = root.nodeType === 11 /* Node.DOCUMENT_FRAGMENT_NODE */ && !!(root as ShadowRoot).host;
  if (root.nodeType !== 9 /* Node.DOCUMENT_NODE */ && !isShadowRoot)
    return true;
  // Class and id selectors ignore case in quirks mode.
  if ((root.nodeType === 9 ? root as Document : root.ownerDocument!).compatMode === 'BackCompat')
    return true;
  // An animation or transition can keep a pseudo-element after the rules that gave it content no
  // longer match.
  if (animatedPseudoElements(root as Document | ShadowRoot).has(element))
    return true;
  // An element of a shadow tree also gets the ::part() rules of the trees around it.
  if (isShadowRoot && (element.getAttribute('part') !== null || element.getAttribute('exportparts') !== null))
    return true;
  return matches(element, root as Document | ShadowRoot);
}

function animatedPseudoElements(root: Document | ShadowRoot): Set<Element> {
  let elements = cacheAnimatedPseudoElements!.get(root);
  if (!elements) {
    elements = new Set();
    for (const animation of root.getAnimations()) {
      const effect = animation.effect as KeyframeEffect | null;
      if (effect?.pseudoElement && effect.target)
        elements.add(effect.target);
    }
    cacheAnimatedPseudoElements!.set(root, elements);
  }
  return elements;
}

function matches(element: Element, root: Document | ShadowRoot): boolean {
  const matcher = matcherFor(root);
  if (matcher.all)
    return true;
  if (matcher.ids.size && matcher.ids.has(element.id))
    return true;
  if (matcher.classes.size) {
    for (const name of element.classList) {
      if (matcher.classes.has(name))
        return true;
    }
  }
  if (matcher.tags.size && matcher.tags.has(element.localName.toLowerCase()))
    return true;
  return !!matcher.generic && element.matches(matcher.generic);
}

function matcherFor(root: Document | ShadowRoot): Matcher {
  let matcher = cacheMatchers!.get(root);
  if (!matcher) {
    matcher = collect(root);
    cacheMatchers!.set(root, matcher);
  }
  return matcher;
}

function collect(root: Document | ShadowRoot): Matcher {
  const selectors: string[] = [];
  let all = false;
  const visitRules = (rules: CSSRuleList) => {
    for (let i = 0; i < rules.length && !all; i++) {
      const rule = rules[i] as any;
      if (rule.styleSheet !== undefined) {
        // @import
        visitSheet(rule.styleSheet);
      } else if (typeof rule.selectorText === 'string') {
        // A style rule. Nested rules would need their parents' selectors.
        if (rule.cssRules?.length) {
          all = true;
        } else if (rule.style?.getPropertyValue('content')) {
          const elementSelectors = selectorsWithoutPseudoContent(rule.selectorText);
          if (elementSelectors)
            selectors.push(...elementSelectors);
          else
            all = true;
        }
      } else if (typeof rule.keyText === 'string') {
        // A keyframe: an animation can change the content.
        if (rule.style?.getPropertyValue('content'))
          all = true;
      } else if (rule.start !== undefined || rule.end !== undefined) {
        // @scope: its selectors are relative to the scope.
        all = true;
      } else if (rule.cssRules) {
        // @media, @supports, @layer, @container, @keyframes...
        visitRules(rule.cssRules);
      }
    }
  };
  const visitSheet = (sheet: CSSStyleSheet | null) => {
    if (!sheet)
      return;
    try {
      visitRules(sheet.cssRules);
    } catch {
      // A cross-origin style sheet cannot be read.
      all = true;
    }
  };
  for (const sheet of root.styleSheets)
    visitSheet(sheet);
  for (const sheet of root.adoptedStyleSheets || [])
    visitSheet(sheet);
  if (all)
    return { all: true };
  const matcher = { all: false as const, ids: new Set<string>(), classes: new Set<string>(), tags: new Set<string>(), generic: undefined as string | undefined };
  const generic: string[] = [];
  for (const selector of selectors) {
    const key = rightmostKey(selector);
    if (!key)
      generic.push(selector);
    else if (key.startsWith('#'))
      matcher.ids.add(key.slice(1));
    else if (key.startsWith('.'))
      matcher.classes.add(key.slice(1));
    else
      matcher.tags.add(key);
  }
  if (generic.length) {
    matcher.generic = generic.join(',');
    try {
      root.querySelector(matcher.generic);
    } catch {
      return { all: true };
    }
  }
  return matcher;
}

// An id ('#name'), class ('.name') or tag that every element the selector matches has, taken from
// its last compound selector, or undefined.
function rightmostKey(selector: string): string | undefined {
  // What is inside parentheses or brackets, like :not(.x) or [title="a b"], says nothing for sure.
  const stripped = stripGroups(selector);
  if (stripped === undefined)
    return;
  let start = 0;
  for (let i = 0; i < stripped.length; i++) {
    if (stripped[i] === '\\')
      i = skipEscape(stripped, i) - 1;
    else if (/[ \t\n\r\f>+~]/.test(stripped[i]))
      start = i + 1;
  }
  const compound = stripped.slice(start);
  let tag: string | undefined;
  let className: string | undefined;
  for (let i = 0; i < compound.length;) {
    const c = compound[i];
    if (c === '|')
      return;
    if (c === '#') {
      const end = identEnd(compound, i + 1);
      return '#' + cssUnescape(compound.slice(i + 1, end));
    }
    if (c === '.') {
      const end = identEnd(compound, i + 1);
      className ??= cssUnescape(compound.slice(i + 1, end));
      i = end;
    } else if (c === ':') {
      i = identEnd(compound, compound[i + 1] === ':' ? i + 2 : i + 1);
    } else if (c === '*') {
      i++;
    } else {
      const end = identEnd(compound, i);
      if (end === i)
        return;
      if (i === 0)
        tag = cssUnescape(compound.slice(i, end)).toLowerCase();
      i = end;
    }
  }
  if (className)
    return '.' + className;
  return tag;
}

function identEnd(text: string, i: number): number {
  while (i < text.length) {
    if (text[i] === '\\')
      i = skipEscape(text, i);
    else if (/[ \t\n\r\f#.:,>+~*|"'()[\]]/.test(text[i]))
      break;
    else
      i++;
  }
  return i;
}

// The index after the escape that starts at `i`: a backslash and up to six hex digits with one
// optional whitespace, or a backslash and any other character.
function skipEscape(text: string, i: number): number {
  const hex = /^[0-9a-fA-F]{1,6}[ \t\n\r\f]?/.exec(text.slice(i + 1, i + 8));
  return i + 1 + (hex ? hex[0].length : 1);
}

// The selector with what is inside parentheses, brackets and quotes removed, escapes kept.
function stripGroups(selector: string): string | undefined {
  let result = '';
  let depth = 0;
  let quote = '';
  for (let i = 0; i < selector.length; i++) {
    const c = selector[i];
    if (quote) {
      if (c === '\\')
        i++;
      else if (c === quote)
        quote = '';
      continue;
    }
    if (c === '\\') {
      const end = skipEscape(selector, i);
      if (!depth)
        result += selector.slice(i, end);
      i = end - 1;
    } else if (c === '"' || c === '\'') {
      quote = c;
    } else if (c === '(' || c === '[') {
      depth++;
    } else if (c === ')' || c === ']') {
      depth--;
      if (depth < 0)
        return;
    } else if (!depth) {
      result += c;
    }
  }
  return depth ? undefined : result;
}

function cssUnescape(value: string): string {
  return value.replace(/\\([0-9a-fA-F]{1,6}[ \t\n\r\f]?|[^])/g, (match, escaped: string) => {
    if (!/^[0-9a-fA-F]/.test(escaped))
      return escaped;
    const codePoint = parseInt(escaped, 16);
    return String.fromCodePoint(!codePoint || codePoint > 0x10FFFF || (codePoint >= 0xD800 && codePoint <= 0xDFFF) ? 0xFFFD : codePoint);
  });
}

// The selectors of the elements whose ::before or ::after a rule's selector list targets, or
// undefined when they cannot be told apart. Selectors of the element itself (`content` on an
// element replaces its content) are left out: only pseudo-element lookups use this.
function selectorsWithoutPseudoContent(selectorText: string): string[] | undefined {
  const result: string[] = [];
  for (const selector of splitSelectorList(selectorText)) {
    if (/:host|::?slotted|::?part|:scope|&/i.test(selector))
      return;
    const match = /^(.*?)(::?)(before|after)[ \t\n\r\f]*$/i.exec(selector);
    if (!match) {
      if (/::?(before|after)\b/i.test(selector))
        return;
      continue;
    }
    const element = trimCSSWhitespace(match[1]);
    // `.a\::before` is the ::before of class "a:": an escape cut in two cannot be told apart here.
    if (/(^|[^\\])(\\\\)*\\$/.test(match[1]))
      return;
    result.push(!element || /[ \t\n\r\f>+~]$/.test(element) ? element + '*' : element);
  }
  return result;
}

function splitSelectorList(selectorText: string): string[] {
  const result: string[] = [];
  let depth = 0;
  let quote = '';
  let start = 0;
  for (let i = 0; i < selectorText.length; i++) {
    const c = selectorText[i];
    if (quote) {
      if (c === '\\')
        i++;
      else if (c === quote)
        quote = '';
    } else if (c === '"' || c === '\'') {
      quote = c;
    } else if (c === '\\') {
      i++;
    } else if (c === '(' || c === '[') {
      depth++;
    } else if (c === ')' || c === ']') {
      depth--;
    } else if (c === ',' && !depth) {
      result.push(trimCSSWhitespace(selectorText.slice(start, i)));
      start = i + 1;
    }
  }
  result.push(trimCSSWhitespace(selectorText.slice(start)));
  return result;
}

// CSS whitespace is space, tab, line feed, carriage return and form feed: JavaScript's \s and trim()
// also take other spaces, like the non-breaking one, that are valid in a CSS identifier.
function trimCSSWhitespace(text: string): string {
  return text.replace(/^[ \t\n\r\f]+|[ \t\n\r\f]+$/g, '');
}
