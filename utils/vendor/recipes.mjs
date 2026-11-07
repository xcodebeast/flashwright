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

// Flashwright: the hard forks in vendor/, see vendor.mjs and vendor/README.md.
//
// Each recipe pins an upstream package and lists:
// - entries: the modules Flashwright imports; only files reachable from them are kept;
// - types: the same for TypeScript declarations;
// - patches: exact replacements, file -> [from, to][], that cut the parts Flashwright does not use;
// - inline: helper packages (name -> version) copied into deps/ instead of staying dependencies;
// - files: other files to copy as they are;
// - aliases: import specifier -> path in the fork for the build (esbuild maps subpaths too);
// - typeAliases: the same for TypeScript, mirrored in tsconfig.json "paths".

const removeLine = line => [line + '\n', ''];

export const recipes = {
  'zod': {
    package: 'zod',
    version: '4.6.7',
    entries: ['index.js'],
    types: ['index.d.ts'],
    patches: {
      // Only English messages, no JSON Schema import, no schema compiler.
      'v4/classic/external.js': [
        removeLine('export * as locales from "../locales/index.js";'),
        removeLine('export { fromJSONSchema } from "./from-json-schema.js";'),
        [' NEVER, INVALID, toZod, compile, withParser, ZodCompileAsyncError, ZodCompileUnsupportedError, getDiscriminatedOption,', ' NEVER, toZod, getDiscriminatedOption,'],
      ],
      'v4/classic/external.d.ts': [
        removeLine('export * as locales from "../locales/index.js";'),
        removeLine('export { fromJSONSchema } from "./from-json-schema.js";'),
        [' NEVER, INVALID, toZod, compile, withParser, ZodCompileAsyncError, ZodCompileUnsupportedError, getDiscriminatedOption,', ' NEVER, toZod, getDiscriminatedOption,'],
      ],
      'v4/core/index.js': [
        removeLine('export * as locales from "../locales/index.js";'),
        removeLine('export * from "./compile.js";'),
      ],
      'v4/core/index.d.ts': [
        removeLine('export * as locales from "../locales/index.js";'),
        removeLine('export * from "./compile.js";'),
      ],
    },
    aliases: {
      'zod': '.',
    },
    typeAliases: {
      'zod': 'index.d.ts',
      'zod/v4': 'index.d.ts',
      'zod/v4/core': 'v4/core/index.d.ts',
    },
  },
  '@modelcontextprotocol/sdk': {
    package: '@modelcontextprotocol/sdk',
    version: '1.32.2',
    dir: 'mcp-sdk',
    // The server side over stdio, SSE and streamable HTTP. Tests use the upstream client.
    entries: ['dist/esm/server/index.js', 'dist/esm/server/stdio.js', 'dist/esm/server/sse.js', 'dist/esm/server/streamableHttp.js', 'dist/esm/types.js'],
    types: ['dist/esm/server/index.d.ts', 'dist/esm/server/stdio.d.ts', 'dist/esm/server/sse.d.ts', 'dist/esm/server/streamableHttp.d.ts', 'dist/esm/types.d.ts', 'dist/esm/shared/transport.d.ts'],
    patches: {
      // No JSON Schema validator: it only checks elicitation answers, which Flashwright never asks for.
      'dist/esm/server/index.js': [
        removeLine(`import { AjvJsonSchemaValidator } from '../validation/ajv-provider.js';`),
        ['this._jsonSchemaValidator = options?.jsonSchemaValidator ?? new AjvJsonSchemaValidator();', 'this._jsonSchemaValidator = options?.jsonSchemaValidator ?? noJsonSchemaValidator;'],
        ['export class Server extends Protocol {', `const noJsonSchemaValidator = {
    getValidator() {
        throw new Error('Flashwright does not include a JSON Schema validator');
    }
};
export class Server extends Protocol {`],
      ],
      // Zod 4 only: Flashwright's schemas are all Zod 4.
      'dist/esm/server/zod-compat.js': [
        removeLine(`import * as z3rt from 'zod/v3';`),
        [`import * as z4mini from 'zod/v4-mini';`, `import * as z4mini from 'zod';`],
        ['return z3rt.object(shape);', `throw new Error('Flashwright only supports Zod 4 schemas');`],
      ],
      'dist/esm/server/zod-json-schema-compat.js': [
        [`import * as z4mini from 'zod/v4-mini';`, `import * as z4mini from 'zod';`],
        removeLine(`import { zodToJsonSchema } from 'zod-to-json-schema';`),
        [`    return zodToJsonSchema(schema, {
        strictUnions: opts?.strictUnions ?? true,
        pipeStrategy: opts?.pipeStrategy ?? 'input'
    });`, `    throw new Error('Flashwright only supports Zod 4 schemas');`],
      ],
      'dist/esm/types.js': [
        [`from 'zod/v4';`, `from 'zod';`],
      ],
      'dist/esm/server/zod-compat.d.ts': [
        removeLine(`import type * as z3 from 'zod/v3';`),
        ['export type AnySchema = z3.ZodTypeAny | z4.$ZodType;', 'export type AnySchema = z4.$ZodType;'],
        ['export type AnyObjectSchema = z3.AnyZodObject | z4.$ZodObject | AnySchema;', 'export type AnyObjectSchema = z4.$ZodObject | AnySchema;'],
        ['export type SchemaOutput<S> = S extends z3.ZodTypeAny ? z3.infer<S> : S extends z4.$ZodType ? z4.output<S> : never;', 'export type SchemaOutput<S> = S extends z4.$ZodType ? z4.output<S> : never;'],
        ['export type SchemaInput<S> = S extends z3.ZodTypeAny ? z3.input<S> : S extends z4.$ZodType ? z4.input<S> : never;', 'export type SchemaInput<S> = S extends z4.$ZodType ? z4.input<S> : never;'],
      ],
    },
    inline: {
      '@hono/node-server': '2.1.6',
      'content-type': '1.0.5',
    },
    inlinePatches: {
      // Only the request listener; the WebSocket helper needs all of Hono.
      '@hono/node-server': {
        'dist/index.mjs': [
          removeLine('import { defineWebSocketHelper } from "hono/ws";'),
          ['const upgradeWebSocket = defineWebSocketHelper(', 'const upgradeWebSocket = undefined && ('],
        ],
      },
    },
    aliases: {
      '@modelcontextprotocol/sdk': 'dist/esm',
    },
    typeAliases: {
      '@modelcontextprotocol/sdk/*': 'dist/esm/*',
    },
  },
  '@zip.js/zip.js': {
    package: '@zip.js/zip.js',
    version: '2.24.0',
    dir: 'zip.js',
    // Reading and writing in the page itself, with the browser's compression streams. The writer is
    // imported on its own, so that the HTML report and the trace viewer, which only read, leave it out.
    entries: ['lib/zip-core.js', 'lib/zip-core-writer.js'],
    types: ['index.d.ts'],
    patches: {
      // The trace viewer's service worker is a classic script, where import.meta does not parse.
      // The base URI only locates the worker and WebAssembly files, which Flashwright turns off.
      'lib/zip-core-base.js': [
        removeLine('export * from "./zip-core-writer.js";'),
        [`try {
	setDefaultConfiguration({ baseURI: import.meta.url });
} catch {
	// ignored
}`, ''],
      ],
      // A static import: the dynamic one makes Vite add a preload helper that reads import.meta.
      'lib/core/zip-writer.js': [
        [`	PASS_THROUGH_COMPRESSED
} from "./options.js";
`, `	PASS_THROUGH_COMPRESSED
} from "./options.js";
import { ZipReader, getEntryDataDescriptorLength } from "./zip-reader.js";
`],
        removeLine(`		const { ZipReader, getEntryDataDescriptorLength } = await import("./zip-reader.js");`),
      ],
    },
    aliases: {
      '@zip.js/zip.js/lib/zip-core.js': 'lib/zip-core.js',
      '@zip.js/zip.js/lib/zip-core-writer.js': 'lib/zip-core-writer.js',
    },
    typeAliases: {
      '@zip.js/zip.js': 'index.d.ts',
      '@zip.js/zip.js/lib/zip-core.js': 'index.d.ts',
    },
  },
  'enquirer': {
    package: 'enquirer',
    version: '2.4.1',
    // The prompts watch mode asks with: multiselect and text.
    entries: ['index.js'],
    types: ['index.d.ts'],
    patches: {
      'lib/prompts/index.js': [
        [`define('AutoComplete', () => require('./autocomplete'));
define('BasicAuth', () => require('./basicauth'));
define('Confirm', () => require('./confirm'));
define('Editable', () => require('./editable'));
define('Form', () => require('./form'));
define('Input', () => require('./input'));
define('Invisible', () => require('./invisible'));
define('List', () => require('./list'));
define('MultiSelect', () => require('./multiselect'));
define('Numeral', () => require('./numeral'));
define('Password', () => require('./password'));
define('Scale', () => require('./scale'));
define('Select', () => require('./select'));
define('Snippet', () => require('./snippet'));
define('Sort', () => require('./sort'));
define('Survey', () => require('./survey'));
define('Text', () => require('./text'));
define('Toggle', () => require('./toggle'));
define('Quiz', () => require('./quiz'));`, `define('Input', () => require('./input'));
define('MultiSelect', () => require('./multiselect'));
define('Select', () => require('./select'));
define('Text', () => require('./text'));`],
      ],
      'lib/types/index.js': [
        [`module.exports = {
  ArrayPrompt: require('./array'),
  AuthPrompt: require('./auth'),
  BooleanPrompt: require('./boolean'),
  NumberPrompt: require('./number'),
  StringPrompt: require('./string')
};`, `module.exports = {
  ArrayPrompt: require('./array'),
  StringPrompt: require('./string')
};`],
      ],
    },
    inline: {
      'ansi-colors': '4.1.3',
      'strip-ansi': '6.0.1',
      'ansi-regex': '5.0.1',
    },
    aliases: { 'enquirer': '.' },
    typeAliases: { 'enquirer': 'index.d.ts' },
  },
  'open': {
    package: 'open',
    version: '11.0.4',
    // One package instead of twelve: its helpers come along in deps/.
    entries: ['index.js'],
    // Shipped next to the bundle, for Linux without xdg-open.
    files: ['xdg-open'],
    types: ['index.d.ts'],
    inline: {
      'default-browser': '5.5.1',
      'default-browser-id': '5.0.1',
      'bundle-name': '4.1.1',
      'run-applescript': '7.1.0',
      'define-lazy-prop': '3.0.0',
      'is-inside-container': '1.0.0',
      'is-docker': '3.0.0',
      'is-wsl': '3.1.1',
      'wsl-utils': '1.0.1',
      'powershell-utils': '0.2.1',
      'is-in-ssh': '1.0.0',
    },
    aliases: { 'open': '.' },
    typeAliases: { 'open': 'index.d.ts' },
  },
  'debug': {
    package: 'debug',
    version: '4.4.3',
    // Node only: the browser build is for Electron renderers and web pages.
    entries: ['src/index.js'],
    patches: {
      'src/index.js': [
        [`if (typeof process === 'undefined' || process.type === 'renderer' || process.browser === true || process.__nwjs) {
	module.exports = require('./browser.js');
} else {
	module.exports = require('./node.js');
}`, `module.exports = require('./node.js');`],
      ],
    },
    inline: {
      'ms': '2.1.3',
      'supports-color': '7.2.0',
      'has-flag': '4.0.0',
    },
    aliases: { 'debug': '.' },
  },
  'jest-message-util': {
    package: 'jest-message-util',
    version: '30.5.1',
    // Stack formatting for toThrow failures. Without jest-util, graceful-fs and picomatch.
    entries: ['build/index.js'],
    types: ['build/index.d.ts'],
    patches: {
      'build/index.js': [
        ['var fs = _interopRequireWildcard(require("graceful-fs"));', '// Flashwright: only reads files, as fs does.\nvar fs = _interopRequireWildcard(require("fs"));'],
        removeLine('var _picomatch = _interopRequireDefault(require("picomatch"));'),
        removeLine('var _jestUtil = require("jest-util");'),
        // Flashwright passes an empty testMatch.
        ['if (config.testMatch && config.testMatch.length > 0 && (0, _picomatch.default)(config.testMatch)(filePath) || filePath === relativeTestPath) {', 'if (filePath === relativeTestPath) {'],
        // jest-util's isError.
        ['return (0, _jestUtil.isError)(error) || error instanceof Error;', `return (typeof Error.isError === 'function' ? Error.isError : require("util/types").isNativeError)(error) || error instanceof Error;`],
      ],
    },
    // The Babel 7 code frame (1-based columns) and its helpers, as jest-message-util depends on them.
    inline: {
      '@babel/code-frame': '7.29.7',
      '@babel/helper-validator-identifier': '7.29.7',
      'js-tokens': '4.0.0',
      'picocolors': '1.1.1',
      'slash': '3.0.0',
      'stack-utils': '2.0.6',
      'escape-string-regexp': '2.0.0',
    },
    aliases: { 'jest-message-util': 'build/index.js' },
    typeAliases: { 'jest-message-util': 'build/index.d.ts' },
  },
};
