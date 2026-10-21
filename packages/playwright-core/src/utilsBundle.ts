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


// Flashwright: every vendored package is loaded on first access rather than when this bundle
// loads. A test run touches only a few of them; the MCP SDK and zod alone cost ~70ms per process.

import type colorsModule from 'colors/safe';
import type debugModule from 'debug';
import type * as iniModule from 'ini';
import type * as diffModule from 'diff';
import type dotenvModule from 'dotenv';
import type { getProxyForUrl as getProxyForUrlModule } from 'proxy-from-env';
import type { HttpsProxyAgent as HttpsProxyAgentModule } from 'https-proxy-agent';
import type jpegjsModule from 'jpeg-js';
import type mimeModule from 'mime';
import type { minimatch as minimatchModule } from 'minimatch';
import type openModule from 'open';
import type { PNG as PNGModule } from 'pngjs';
import type { program as programModule } from 'commander';
import type { Option as ProgramOptionModule } from 'commander';
import type progressModule from 'progress';
import type { SocksProxyAgent as SocksProxyAgentModule } from 'socks-proxy-agent';
// @ts-ignore
import type wsModule from 'ws';
import type { WebSocketServer as wsServerModule } from 'ws';
import type yamlModule from 'yaml';
import type json5Module from 'json5';
import type sourceMapSupportModule from 'source-map-support';
import type enquirerModule from 'enquirer';
import type chokidarModule from 'chokidar';
import type * as getEastAsianWidthModule from 'get-east-asian-width';
import type * as yazlModule from 'yazl';
import type * as yauzlModule from 'yauzl';
import type retryModule from 'retry';
import type { onExit as onExitModule } from 'signal-exit';
import type getStreamModule from 'get-stream';
import type { HttpsProxyAgent as httpProxyAgentModule } from 'https-proxy-agent';
import type { SocksProxyAgent as socksProxyAgentModule } from 'socks-proxy-agent';
import type * as zModule from 'zod';
import type { Client as ClientModule } from '@modelcontextprotocol/sdk/client/index.js';
import type { Server as ServerModule } from '@modelcontextprotocol/sdk/server/index.js';
import type { SSEClientTransport as SSEClientTransportModule } from '@modelcontextprotocol/sdk/client/sse.js';
import type { SSEServerTransport as SSEServerTransportModule } from '@modelcontextprotocol/sdk/server/sse.js';
import type { StdioClientTransport as StdioClientTransportModule } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { StdioServerTransport as StdioServerTransportModule } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { StreamableHTTPServerTransport as StreamableHTTPServerTransportModule } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { StreamableHTTPClientTransport as StreamableHTTPClientTransportModule } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolRequestSchema as CallToolRequestSchemaModule } from '@modelcontextprotocol/sdk/types.js';
import type { ListRootsRequestSchema as ListRootsRequestSchemaModule } from '@modelcontextprotocol/sdk/types.js';
import type { ListToolsRequestSchema as ListToolsRequestSchemaModule } from '@modelcontextprotocol/sdk/types.js';
import type { PingRequestSchema as PingRequestSchemaModule } from '@modelcontextprotocol/sdk/types.js';
import type { ProgressNotificationSchema as ProgressNotificationSchemaModule } from '@modelcontextprotocol/sdk/types.js';
import type { zodToJsonSchema as zodToJsonSchemaModule } from 'zod-to-json-schema';


// Mirrors esbuild's interop for `import x from 'pkg'`.
const defaultExport = (module: any) => module?.__esModule ? module.default : module;

// esbuild replaces module.exports with its own object for this module; define the getters there.
function lazy(name: string, load: () => unknown) {
  const target = module.exports;
  Object.defineProperty(target, name, {
    enumerable: true,
    configurable: true,
    get() {
      const value = load();
      Object.defineProperty(target, name, { enumerable: true, value });
      return value;
    },
  });
}

export declare const colors: typeof colorsModule;
lazy('colors', () => defaultExport(require('colors/safe')));

export declare const debug: typeof debugModule;
lazy('debug', () => defaultExport(require('debug')));

export declare const ini: typeof iniModule;
lazy('ini', () => require('ini'));

export declare const diff: typeof diffModule;
lazy('diff', () => require('diff'));

export declare const dotenv: typeof dotenvModule;
lazy('dotenv', () => defaultExport(require('dotenv')));

export declare const getProxyForUrl: typeof getProxyForUrlModule;
lazy('getProxyForUrl', () => require('proxy-from-env').getProxyForUrl);

export declare const HttpsProxyAgent: typeof HttpsProxyAgentModule;
lazy('HttpsProxyAgent', () => require('https-proxy-agent').HttpsProxyAgent);

export declare const jpegjs: typeof jpegjsModule;
lazy('jpegjs', () => defaultExport(require('jpeg-js')));

export declare const mime: typeof mimeModule;
lazy('mime', () => defaultExport(require('mime')));

export declare const minimatch: typeof minimatchModule;
lazy('minimatch', () => require('minimatch').minimatch);

export declare const open: typeof openModule;
lazy('open', () => defaultExport(require('open')));

export declare const PNG: typeof PNGModule;
lazy('PNG', () => require('pngjs').PNG);

export declare const program: typeof programModule;
lazy('program', () => require('commander').program);

export declare const ProgramOption: typeof ProgramOptionModule;
lazy('ProgramOption', () => require('commander').Option);

export declare const progress: typeof progressModule;
lazy('progress', () => defaultExport(require('progress')));

export declare const SocksProxyAgent: typeof SocksProxyAgentModule;
lazy('SocksProxyAgent', () => require('socks-proxy-agent').SocksProxyAgent);

export declare const ws: typeof wsModule;
lazy('ws', () => defaultExport(require('ws')));

export declare const wsServer: typeof wsServerModule;
lazy('wsServer', () => require('ws').WebSocketServer);

export declare const wsReceiver: any;
lazy('wsReceiver', () => require('ws').Receiver);

export declare const wsSender: any;
lazy('wsSender', () => require('ws').Sender);

export declare const yaml: typeof yamlModule;
lazy('yaml', () => defaultExport(require('yaml')));

export declare const json5: typeof json5Module;
lazy('json5', () => defaultExport(require('json5')));

export declare const sourceMapSupport: typeof sourceMapSupportModule;
lazy('sourceMapSupport', () => defaultExport(require('source-map-support')));

export declare const enquirer: typeof enquirerModule;
lazy('enquirer', () => defaultExport(require('enquirer')));

export declare const chokidar: typeof chokidarModule;
lazy('chokidar', () => defaultExport(require('chokidar')));

export declare const getEastAsianWidth: typeof getEastAsianWidthModule;
lazy('getEastAsianWidth', () => require('get-east-asian-width'));

export declare const yazl: typeof yazlModule;
lazy('yazl', () => require('yazl'));

export declare const yauzl: typeof yauzlModule;
lazy('yauzl', () => require('yauzl'));

export declare const gracefulFs: any;
lazy('gracefulFs', () => require('graceful-fs'));

export declare const retry: typeof retryModule;
lazy('retry', () => defaultExport(require('retry')));

export declare const onExit: typeof onExitModule;
lazy('onExit', () => require('signal-exit').onExit);

export declare const getStream: typeof getStreamModule;
lazy('getStream', () => defaultExport(require('get-stream')));

export declare const httpProxyAgent: typeof httpProxyAgentModule;
lazy('httpProxyAgent', () => require('https-proxy-agent').HttpsProxyAgent);

export declare const socksProxyAgent: typeof socksProxyAgentModule;
lazy('socksProxyAgent', () => require('socks-proxy-agent').SocksProxyAgent);

export declare const z: typeof zModule;
lazy('z', () => require('zod'));

export declare const Client: typeof ClientModule;
lazy('Client', () => require('@modelcontextprotocol/sdk/client/index.js').Client);

export declare const Server: typeof ServerModule;
lazy('Server', () => require('@modelcontextprotocol/sdk/server/index.js').Server);

export declare const SSEClientTransport: typeof SSEClientTransportModule;
lazy('SSEClientTransport', () => require('@modelcontextprotocol/sdk/client/sse.js').SSEClientTransport);

export declare const SSEServerTransport: typeof SSEServerTransportModule;
lazy('SSEServerTransport', () => require('@modelcontextprotocol/sdk/server/sse.js').SSEServerTransport);

export declare const StdioClientTransport: typeof StdioClientTransportModule;
lazy('StdioClientTransport', () => require('@modelcontextprotocol/sdk/client/stdio.js').StdioClientTransport);

export declare const StdioServerTransport: typeof StdioServerTransportModule;
lazy('StdioServerTransport', () => require('@modelcontextprotocol/sdk/server/stdio.js').StdioServerTransport);

export declare const StreamableHTTPServerTransport: typeof StreamableHTTPServerTransportModule;
lazy('StreamableHTTPServerTransport', () => require('@modelcontextprotocol/sdk/server/streamableHttp.js').StreamableHTTPServerTransport);

export declare const StreamableHTTPClientTransport: typeof StreamableHTTPClientTransportModule;
lazy('StreamableHTTPClientTransport', () => require('@modelcontextprotocol/sdk/client/streamableHttp.js').StreamableHTTPClientTransport);

export declare const CallToolRequestSchema: typeof CallToolRequestSchemaModule;
lazy('CallToolRequestSchema', () => require('@modelcontextprotocol/sdk/types.js').CallToolRequestSchema);

export declare const ListRootsRequestSchema: typeof ListRootsRequestSchemaModule;
lazy('ListRootsRequestSchema', () => require('@modelcontextprotocol/sdk/types.js').ListRootsRequestSchema);

export declare const ListToolsRequestSchema: typeof ListToolsRequestSchemaModule;
lazy('ListToolsRequestSchema', () => require('@modelcontextprotocol/sdk/types.js').ListToolsRequestSchema);

export declare const PingRequestSchema: typeof PingRequestSchemaModule;
lazy('PingRequestSchema', () => require('@modelcontextprotocol/sdk/types.js').PingRequestSchema);

export declare const ProgressNotificationSchema: typeof ProgressNotificationSchemaModule;
lazy('ProgressNotificationSchema', () => require('@modelcontextprotocol/sdk/types.js').ProgressNotificationSchema);

export declare const zodToJsonSchema: typeof zodToJsonSchemaModule;
lazy('zodToJsonSchema', () => require('zod-to-json-schema').zodToJsonSchema);
