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

import { codeFrameColumns as babelCodeFrameColumns } from '@babel/code-frame';
import * as babel from '@babel/core';
import traverseFunction from '@babel/traverse';

import type { FileResult, InputOptions, NodePath, PluginAPI, PluginItem, PluginObject } from '@babel/core';
import type { ImportDeclaration, TSExportAssignment } from '@babel/types';

type SourceLocation = { line: number, column?: number };

// Babel 8 counts code frame columns from 0; our callers count them from 1, like Babel 7 did.
export function codeFrameColumns(rawLines: string, location: { start: SourceLocation, end?: SourceLocation }, options?: Parameters<typeof babelCodeFrameColumns>[2]): string {
  const fromZero = (position: SourceLocation | undefined) => position && (typeof position.column === 'number' ? { ...position, column: Math.max(position.column - 1, 0) } : position);
  return babelCodeFrameColumns(rawLines, { start: fromZero(location.start), end: fromZero(location.end) } as Parameters<typeof babelCodeFrameColumns>[1], options);
}

export { declare } from '@babel/helper-plugin-utils';
export { types } from '@babel/core';
export const traverse = traverseFunction;

export type { NodePath, PluginObject as PluginObj, PluginAPI as BabelAPI, types as T } from '@babel/core';

export type BabelPlugin = [string, any?];
export type JsxOptions = {
  jsx: string;
  jsxFactory?: string;
  jsxFragmentFactory?: string;
  jsxImportSource?: string;
};
export type BabelTransformFunction = (code: string, filename: string, isModule: boolean, pluginsSuffix: BabelPlugin[], jsx?: JsxOptions) => FileResult | null;

const nodeMajorVersion = +process.versions.node.split('.')[0];

function jsxPlugin(jsx: JsxOptions | undefined): [any, any] {
  if (jsx?.jsx === 'react') {
    return [require('@babel/plugin-transform-react-jsx'), {
      throwIfNamespace: false,
      runtime: 'classic',
      pragma: jsx.jsxFactory,
      pragmaFrag: jsx.jsxFragmentFactory,
    }];
  }
  const plugin = jsx?.jsx === 'react-jsxdev' ? require('@babel/plugin-transform-react-jsx/lib/development') : require('@babel/plugin-transform-react-jsx');
  return [plugin, {
    throwIfNamespace: false,
    runtime: 'automatic',
    importSource: jsx?.jsxImportSource,
    // Babel 8 only passes the source location to jsxDEV when asked, Babel 7 always did.
    sourceSelf: true,
  }];
}

// Removing a node leaves its identifiers in the bindings' references, which decide whether an import is kept.
function forgetReferences(path: NodePath) {
  path.traverse({
    Identifier(identifier) {
      const binding = identifier.scope.getBinding(identifier.node.name);
      if (!binding || !binding.referencePaths.includes(identifier))
        return;
      binding.referencePaths = binding.referencePaths.filter(reference => reference !== identifier);
      binding.references = binding.referencePaths.length;
      binding.referenced = binding.references > 0;
    }
  });
}

function babelTransformOptions(isTypeScript: boolean, isModule: boolean, pluginsEpilogue: [string, any?][], jsx: JsxOptions | undefined, withJsx: boolean): InputOptions {
  const plugins: any[] = [];

  if (isTypeScript) {
    plugins.push(
        // Strip "declare" class fields before these plugins run:
        // - plugin-proposal-decorators
        // - plugin-transform-class-properties
        // - plugin-transform-private-methods
        // See https://github.com/microsoft/playwright/issues/38586
        [
          (): PluginObject => ({
            name: 'strip-declare-class-fields',
            visitor: {
              // Babel 8 transforms class features when it enters a class, before this plugin's
              // Class visitor would run, so remove the fields when entering the program.
              Program(program) {
                program.traverse({
                  // Same for `interface X extends ns.Type`; the interface itself goes away with the types.
                  TSInterfaceDeclaration(path) {
                    if (path.node.extends) {
                      for (const heritage of path.get('extends') as NodePath[])
                        forgetReferences(heritage);
                    }
                  },
                  Class(path) {
                    // `implements` is types only. Babel 8 counts `implements ns.Type` as a use of `ns`
                    // and keeps its import, which Babel 7 removed with the other type-only imports.
                    if (path.node.implements) {
                      for (const clause of path.get('implements') as NodePath[]) {
                        forgetReferences(clause);
                        clause.remove();
                      }
                    }
                    for (const member of path.get('body.body')) {
                      if (member.isClassProperty() && member.node.declare)
                        member.remove();
                      // Babel 8 also rejects `field!: Type` before the TypeScript plugin runs; the `!` only matters to types.
                      else if (member.isClassProperty() && member.node.definite)
                        member.node.definite = false;
                    }
                  }
                });
              }
            }
          })
        ],
        [require('@babel/plugin-proposal-decorators'), { version: '2023-11' }],
        [require('@babel/plugin-transform-class-properties')],
        [require('@babel/plugin-transform-class-static-block')],
        [require('@babel/plugin-transform-numeric-separator')],
        [require('@babel/plugin-transform-logical-assignment-operators')],
        [require('@babel/plugin-transform-nullish-coalescing-operator')],
        [require('@babel/plugin-transform-optional-chaining')],
        [require('@babel/plugin-transform-private-methods')],
        [require('@babel/plugin-transform-export-namespace-from')],
        [
          // From https://github.com/G-Rath/babel-plugin-replace-ts-export-assignment/blob/8dfdca32c8aa428574b0cae341444fc5822f2dc6/src/index.ts
          (
            { template }: PluginAPI
          ): PluginObject => ({
            name: 'replace-ts-export-assignment',
            visitor: {
              TSExportAssignment(path: NodePath<TSExportAssignment>) {
                path.replaceWith(template.statement('module.exports = ASSIGNMENT;')({
                  ASSIGNMENT: path.node.expression
                }));
              }
            }
          })
        ]
    );

    if (nodeMajorVersion < 24)
      plugins.push([require('@babel/plugin-transform-explicit-resource-management')]);
  }

  // Support JSX/TSX at all times, regardless of the file extension.
  if (withJsx)
    plugins.push(jsxPlugin(jsx));

  if (!isModule) {
    plugins.push([require('@babel/plugin-transform-modules-commonjs')]);
    // Note: we used to include '@babel/plugin-transform-dynamic-import' to convert async imports
    // into require(), so that pirates can intercept them. With the ESM loader enabled by default,
    // there is no need for this.
    plugins.push([
      (): PluginObject => ({
        name: 'css-to-identity-obj-proxy',
        visitor: {
          ImportDeclaration(path: NodePath<ImportDeclaration>) {
            if (path.node.source.value.match(/\.(css|less|scss)$/))
              path.remove();
          }
        }
      })
    ]);
  }

  return {
    browserslistConfigFile: false,
    babelrc: false,
    configFile: false,
    assumptions: {
      // Without this, babel defines a top level function that
      // breaks playwright evaluates.
      setPublicClassFields: true,
    },
    presets: isTypeScript ? [
      [require('@babel/preset-typescript'), { onlyRemoveTypeImports: false }],
    ] : [],
    plugins: [
      ...plugins,
      ...pluginsEpilogue.map(([name, options]): PluginItem => [require(name), options]),
    ],
    compact: false,
    // Babel 8 writes non-ASCII characters as they are; keep escaping them like Babel 7 did.
    generatorOpts: { jsescOption: { minimal: false } },
    sourceMaps: 'both',
  };
}

let isTransforming = false;

function isTypeScript(filename: string) {
  return filename.endsWith('.ts') || filename.endsWith('.tsx') || filename.endsWith('.mts') || filename.endsWith('.cts');
}

// Flashwright: Babel 8 rejects two things Babel 7 accepted, so a file that fails to parse is retried:
// - import assertions (`import x from './x.json' assert { type: 'json' }`), which Node also dropped: the
//   keyword the parser stopped at is rewritten to `with`, padded to the same length so that positions in
//   source maps and errors stay where they were;
// - generic arrow functions (`<T>(x: T) => x`) in .ts files, which read as JSX: retried without JSX.
// Files that parse the first time are compiled exactly as before.
function withParseFallbacks<T>(code: string, filename: string, run: (code: string, withJsx: boolean) => T): T {
  let withJsx = true;
  let firstError: unknown;
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      return run(code, withJsx);
    } catch (error: any) {
      if (error?.code !== 'BABEL_PARSE_ERROR')
        throw error;
      firstError ??= error;
      const assertion = importAssertionAt(code, error.pos);
      if (assertion !== undefined) {
        code = code.slice(0, assertion) + 'with  ' + code.slice(assertion + 'assert'.length);
        continue;
      }
      if (withJsx && /\.[mc]?ts$/.test(filename)) {
        withJsx = false;
        continue;
      }
      throw firstError;
    }
  }
  throw firstError;
}

function importAssertionAt(code: string, errorPosition: number | undefined): number | undefined {
  if (errorPosition === undefined)
    return;
  const match = /^\s*assert\s*\{/.exec(code.slice(errorPosition, errorPosition + 200));
  if (!match)
    return;
  const before = code.slice(Math.max(0, errorPosition - 500), errorPosition);
  if (!/\b(import|export)\b[^;]*['"]\s*$/.test(before))
    return;
  return errorPosition + match[0].indexOf('assert');
}

export function babelTransform(code: string, filename: string, isModule: boolean, pluginsEpilogue: [string, any?][], jsx?: JsxOptions): FileResult | null {
  if (isTransforming)
    return null;

  // Prevent reentry while requiring plugins lazily.
  isTransforming = true;
  try {
    return withParseFallbacks(code, filename, (code, withJsx) => {
      const options = babelTransformOptions(isTypeScript(filename), isModule, pluginsEpilogue, jsx, withJsx);
      return babel.transformSync(code, { filename, ...options });
    });
  } finally {
    isTransforming = false;
  }
}

export function babelParse(code: string, filename: string, isModule: boolean): NonNullable<ReturnType<typeof babel.parseSync>> {
  return withParseFallbacks(code, filename, (code, withJsx) => {
    const options = babelTransformOptions(isTypeScript(filename), isModule, [], undefined, withJsx);
    return babel.parseSync(code, { filename, ...options })!;
  });
}
