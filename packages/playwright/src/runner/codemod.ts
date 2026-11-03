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

// Flashwright: `npx playwright codemod` rewrites the selector-based Page and Frame methods, which
// the docs discourage, to locators: page.click(selector, options) becomes
// page.locator(selector).click(options). Only calls whose method, argument count and selector
// argument match a Page or Frame method are rewritten; what cannot be rewritten safely (element
// handles, waitForNavigation, waitForTimeout, networkidle, a waitForSelector whose result is used)
// is listed with its location. Only the rewritten text changes; the rest of a file keeps its
// formatting.

/* eslint-disable no-restricted-properties */
// The command prints its diff and report to stdout.

import fs from 'fs';
import path from 'path';

import colors from 'colors/safe';
import * as diff from 'diff';

import type * as BabelBundle from '../transform/babelBundle';
import type { T } from '../transform/babelBundle';
const babel = new Proxy({}, { get: (_, name) => (require('../transform/babelBundle') as any)[name] }) as typeof BabelBundle;
const t = new Proxy({}, { get: (_, name) => (babel.types as any)[name] }) as typeof T;

// Page and Frame methods that take a selector first, with how many arguments they need at least
// and the Locator method that replaces them (the selector argument moves to locator()). Where the
// Page method's second argument is a value, the Locator method of the same name takes that value
// first and options second: `value` says how to tell the Page call apart.
type Spec = { minArgs: number, locatorMethod: string, value?: 'notOptions' | 'optionValues' | 'files' };
const kSelectorMethods: Record<string, Spec> = {
  check: { minArgs: 1, locatorMethod: 'check' },
  click: { minArgs: 1, locatorMethod: 'click' },
  dblclick: { minArgs: 1, locatorMethod: 'dblclick' },
  dispatchEvent: { minArgs: 2, locatorMethod: 'dispatchEvent', value: 'notOptions' },
  fill: { minArgs: 2, locatorMethod: 'fill', value: 'notOptions' },
  focus: { minArgs: 1, locatorMethod: 'focus' },
  getAttribute: { minArgs: 2, locatorMethod: 'getAttribute', value: 'notOptions' },
  hover: { minArgs: 1, locatorMethod: 'hover' },
  innerHTML: { minArgs: 1, locatorMethod: 'innerHTML' },
  innerText: { minArgs: 1, locatorMethod: 'innerText' },
  inputValue: { minArgs: 1, locatorMethod: 'inputValue' },
  isChecked: { minArgs: 1, locatorMethod: 'isChecked' },
  isDisabled: { minArgs: 1, locatorMethod: 'isDisabled' },
  isEditable: { minArgs: 1, locatorMethod: 'isEditable' },
  isEnabled: { minArgs: 1, locatorMethod: 'isEnabled' },
  isHidden: { minArgs: 1, locatorMethod: 'isHidden' },
  isVisible: { minArgs: 1, locatorMethod: 'isVisible' },
  press: { minArgs: 2, locatorMethod: 'press', value: 'notOptions' },
  selectOption: { minArgs: 2, locatorMethod: 'selectOption', value: 'optionValues' },
  setChecked: { minArgs: 2, locatorMethod: 'setChecked' },
  setInputFiles: { minArgs: 2, locatorMethod: 'setInputFiles', value: 'files' },
  tap: { minArgs: 1, locatorMethod: 'tap' },
  textContent: { minArgs: 1, locatorMethod: 'textContent' },
  type: { minArgs: 2, locatorMethod: 'pressSequentially', value: 'notOptions' },
  uncheck: { minArgs: 1, locatorMethod: 'uncheck' },
};

// Methods that return a Locator, so that `.type(text)` on their result is Locator.type.
const kLocatorReturning = new Set(['locator', 'getByRole', 'getByText', 'getByLabel', 'getByPlaceholder', 'getByAltText', 'getByTitle', 'getByTestId', 'first', 'last', 'nth', 'filter', 'and', 'or', 'describe']);

const kExtensions = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);
const kSkippedDirectories = new Set(['node_modules', 'playwright-report', 'test-results', 'blob-report', 'dist', 'build', 'out', 'coverage']);
const kMayMatch = /\b(check|click|dblclick|dispatchEvent|fill|focus|getAttribute|hover|innerHTML|innerText|inputValue|is(Checked|Disabled|Editable|Enabled|Hidden|Visible)|press|selectOption|setChecked|setInputFiles|tap|textContent|type|uncheck|dragAndDrop|\$eval|\$\$eval|\$\$?|waitForSelector|waitForNavigation|waitForTimeout|networkidle|elementHandles?)\b/;

export type CodemodOptions = { write: boolean, keepFirst: boolean };
type Edit = { start: number, end: number, text: string };
type Note = { file: string, line: number, column: number, message: string };

export async function runCodemod(paths: string[], options: CodemodOptions): Promise<number> {
  const files = collectFiles(paths.length ? paths : [process.cwd()]);
  const notes: Note[] = [];
  let changedFiles = 0;
  let rewrites = 0;
  for (const file of files) {
    const source = await fs.promises.readFile(file, 'utf8');
    if (!kMayMatch.test(source))
      continue;
    let result = source;
    let fileRewrites = 0;
    try {
      // Nested calls take one pass per level.
      for (let pass = 0; pass < 8; pass++) {
        const fileNotes: Note[] = [];
        const edits = transformSource(result, file, options, fileNotes);
        if (!edits.length) {
          notes.push(...fileNotes);
          break;
        }
        const next = applyEdits(result, edits);
        fileRewrites += countApplied(edits);
        result = next;
      }
    } catch (e) {
      notes.push({ file, line: 0, column: 0, message: `skipped, could not parse: ${(e as Error).message.split('\n')[0]}` });
      continue;
    }
    if (result === source)
      continue;
    changedFiles++;
    rewrites += fileRewrites;
    const relative = path.relative(process.cwd(), file);
    if (options.write)
      await fs.promises.writeFile(file, result);
    else
      process.stdout.write(colorize(diff.createPatch(relative.replace(/\\/g, '/'), source, result, undefined, undefined, { context: 2 })));
  }

  const out: string[] = [];
  if (rewrites) {
    out.push(`${options.write ? 'Rewrote' : 'Would rewrite'} ${rewrites} call${rewrites === 1 ? '' : 's'} in ${changedFiles} file${changedFiles === 1 ? '' : 's'}.`);
    if (!options.keepFirst)
      out.push('Locators are strict: where a selector matched several elements, page.click(selector) used the first one and the rewritten call fails instead. Add .first() where that was intended, or run with --keep-first to add it everywhere.');
    if (!options.write)
      out.push('Nothing was written. Run again with --write to apply.');
  } else {
    out.push('No selector-based calls to rewrite.');
  }
  if (notes.length) {
    out.push('', `${notes.length} call${notes.length === 1 ? '' : 's'} to change by hand:`);
    for (const note of notes)
      out.push(`  ${path.relative(process.cwd(), note.file)}:${note.line}:${note.column + 1}  ${note.message}`);
  }
  process.stdout.write(out.join('\n') + '\n');
  return 0;
}

export function transformSource(source: string, file: string, options: Pick<CodemodOptions, 'keepFirst'>, notes: Note[]): Edit[] {
  let ast;
  try {
    ast = babel.babelParse(source, file, true);
  } catch {
    ast = babel.babelParse(source, file, false);
  }
  const edits: Edit[] = [];
  const text = (node: T.Node) => source.substring(node.start!, node.end!);
  const note = (node: T.Node, message: string) => notes.push({ file, line: node.loc!.start.line, column: node.loc!.start.column, message });
  const first = options.keepFirst ? '.first()' : '';

  babel.traverse(ast, {
    CallExpression: callPath => {
      const node = callPath.node;
      const callee = node.callee;
      if (!t.isMemberExpression(callee) || callee.computed || !t.isIdentifier(callee.property))
        return;
      const method = callee.property.name;
      const args = node.arguments;
      const receiver = callee.object;
      const replaceCall = (replacement: string) => edits.push({ start: callee.property.start!, end: node.end!, text: replacement });
      const restText = (from: number) => args.length > from ? source.substring(args[from].start!, args[args.length - 1].end!) : '';

      // Locator.type(text) is deprecated in favor of pressSequentially(text).
      if (method === 'type' && args.length >= 1 && args.length <= 2 && isLocatorExpression(receiver)) {
        edits.push({ start: callee.property.start!, end: callee.property.end!, text: 'pressSequentially' });
        return;
      }

      const spec = kSelectorMethods[method];
      if (spec && args.length >= spec.minArgs && isSelector(args[0]) && !isLocatorExpression(receiver) && isPageValue(spec, args[1])) {
        replaceCall(`locator(${text(args[0])})${first}.${spec.locatorMethod}(${restText(1)})`);
        return;
      }
      if (method === 'dragAndDrop' && args.length >= 2 && isSelector(args[0]) && isSelector(args[1]) && isPlainReceiver(receiver)) {
        const options = args.length > 2 ? ', ' + restText(2) : '';
        replaceCall(`locator(${text(args[0])})${first}.dragTo(${text(receiver)}.locator(${text(args[1])})${first}${options})`);
        return;
      }
      if (method === 'waitForSelector' && args.length >= 1 && isSelector(args[0])) {
        if (resultIsUnused(callPath) && !hasProperty(args[1], 'strict')) {
          // waitForSelector waits for the first match, as locator().first() does.
          replaceCall(`locator(${text(args[0])}).first().waitFor(${restText(1)})`);
          return;
        }
        note(node, 'waitForSelector returns an ElementHandle here: use a locator and expect(locator) instead');
        return;
      }
      if ((method === '$eval' || method === '$$eval') && args.length >= 2 && isSelector(args[0])) {
        note(node, `${method} does not wait for the element: ${method === '$eval' ? 'locator(selector).evaluate(fn)' : 'locator(selector).evaluateAll(fn)'} does, or assert with expect(locator)`);
        return;
      }
      if ((method === '$' || method === '$$') && args.length === 1 && isSelector(args[0])) {
        note(node, `${method}() returns element handles: use locator(selector) instead`);
        return;
      }
      if ((method === 'elementHandle' || method === 'elementHandles') && args.length <= 1 && isLocatorExpression(receiver)) {
        note(node, `${method}() returns element handles, which are racy: act on the locator itself`);
        return;
      }
      if (method === 'waitForNavigation') {
        note(node, 'waitForNavigation is deprecated: await page.waitForURL(url) after the action, or expect(page).toHaveURL(url)');
        return;
      }
      if (method === 'waitForTimeout' && args.length === 1) {
        note(node, 'waitForTimeout makes tests slow and flaky: wait for what it stands for with expect(locator) or waitForResponse');
        return;
      }
      if (args.some(arg => t.isStringLiteral(arg) && arg.value === 'networkidle') || args.some(arg => hasPropertyValue(arg, 'waitUntil', 'networkidle'))) {
        note(node, `'networkidle' is discouraged and may never settle: wait for the content with expect(locator) instead`);
        return;
      }
    },
  });
  return edits;
}

// The second argument of the Page form is a value; that of the Locator form is an options object.
function isPageValue(spec: Spec, node: T.Node | undefined): boolean {
  if (!spec.value || !node || !t.isObjectExpression(node))
    return true;
  if (spec.value === 'notOptions')
    return false;
  const allowed = spec.value === 'optionValues' ? ['value', 'label', 'index'] : ['name', 'mimeType', 'buffer'];
  return node.properties.length > 0 && node.properties.every(p => t.isObjectProperty(p) && t.isIdentifier(p.key) && allowed.includes(p.key.name));
}

function isSelector(node: T.Node | undefined): boolean {
  return !!node && (t.isStringLiteral(node) || t.isTemplateLiteral(node));
}

// page.locator(...), page.getByRole(...).first() and the like.
function isLocatorExpression(node: T.Node): boolean {
  return t.isCallExpression(node) && t.isMemberExpression(node.callee) && t.isIdentifier(node.callee.property) && kLocatorReturning.has(node.callee.property.name);
}

// A receiver that can be written twice without running anything twice: page, this.page, a.b.c.
function isPlainReceiver(node: T.Node): boolean {
  if (t.isIdentifier(node) || t.isThisExpression(node))
    return true;
  return t.isMemberExpression(node) && !node.computed && isPlainReceiver(node.object);
}

function resultIsUnused(callPath: BabelBundle.NodePath<T.CallExpression>): boolean {
  let parent: BabelBundle.NodePath | null = callPath.parentPath;
  if (parent && t.isAwaitExpression(parent.node))
    parent = parent.parentPath;
  return !!parent && t.isExpressionStatement(parent.node);
}

function hasProperty(node: T.Node | undefined, name: string): boolean {
  return !!node && t.isObjectExpression(node) && node.properties.some(p => t.isObjectProperty(p) && t.isIdentifier(p.key) && p.key.name === name);
}

function hasPropertyValue(node: T.Node | undefined, name: string, value: string): boolean {
  return !!node && t.isObjectExpression(node) && node.properties.some(p => t.isObjectProperty(p) && t.isIdentifier(p.key) && p.key.name === name && t.isStringLiteral(p.value) && p.value.value === value);
}

// Applies the edits that contain no other edit, from the end so that offsets stay valid. An edit
// around a nested call copies that call's original text; the caller parses again and repeats.
function applyEdits(source: string, edits: Edit[]): string {
  edits = edits.filter(edit => !edits.some(other => other !== edit && edit.start <= other.start && other.end <= edit.end));
  edits.sort((a, b) => b.start - a.start);
  let result = source;
  for (const edit of edits)
    result = result.substring(0, edit.start) + edit.text + result.substring(edit.end);
  return result;
}

function countApplied(edits: Edit[]): number {
  return edits.filter(edit => !edits.some(other => other !== edit && edit.start <= other.start && other.end <= edit.end)).length;
}

function collectFiles(paths: string[]): string[] {
  const files: string[] = [];
  const visit = (entry: string) => {
    const stat = fs.statSync(entry, { throwIfNoEntry: false });
    if (!stat)
      return;
    if (stat.isFile()) {
      if (kExtensions.has(path.extname(entry)) && !entry.endsWith('.d.ts'))
        files.push(path.resolve(entry));
      return;
    }
    if (!stat.isDirectory())
      return;
    for (const name of fs.readdirSync(entry).sort()) {
      if (name.startsWith('.') || kSkippedDirectories.has(name))
        continue;
      visit(path.join(entry, name));
    }
  };
  paths.forEach(visit);
  return files;
}

function colorize(patch: string): string {
  if (!process.stdout.isTTY)
    return patch;
  return patch.split('\n').map(line => line.startsWith('+') && !line.startsWith('+++') ? colors.green(line) : line.startsWith('-') && !line.startsWith('---') ? colors.red(line) : line).join('\n');
}
