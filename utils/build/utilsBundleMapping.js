// Single source of truth for the mapping between idiomatic npm imports and
// the keys exported from `playwright-core/lib/utilsBundle`.
//
// Each entry: package specifier → { default?, named?: {srcName: bundleKey}, namespace? }
// `lockfile` and `extract` have no clean npm equivalent (they wrap in-tree
// third_party files) and intentionally remain as direct utilsBundle imports.

/** @type {Record<string, { default?: string, named?: Record<string,string>, namespace?: string }>} */
const MAPPING = {
  'colors/safe': { default: 'colors' },
  'debug': { default: 'debug' },
  'ini': { namespace: 'ini' },
  'diff': { namespace: 'diff' },
  'dotenv': { default: 'dotenv' },
  'proxy-from-env': { named: { getProxyForUrl: 'getProxyForUrl' } },
  'https-proxy-agent': { default: 'httpProxyAgent', named: { HttpsProxyAgent: 'HttpsProxyAgent' } },
  'jpeg-js': { default: 'jpegjs' },
  'mime': { default: 'mime' },
  'minimatch': { named: { minimatch: 'minimatch' } },
  'open': { default: 'open' },
  'pngjs': { named: { PNG: 'PNG' } },
  'commander': { named: { program: 'program', Option: 'ProgramOption' } },
  'progress': { default: 'progress' },
  'socks-proxy-agent': { default: 'socksProxyAgent', named: { SocksProxyAgent: 'SocksProxyAgent' } },
  'ws': {
    default: 'ws',
    named: { WebSocketServer: 'wsServer' },
  },
  'yaml': { default: 'yaml' },
  'json5': { default: 'json5' },
  'source-map-support': { default: 'sourceMapSupport' },
  'enquirer': { default: 'enquirer' },
  'chokidar': { default: 'chokidar' },
  'get-east-asian-width': { namespace: 'getEastAsianWidth' },
  'yazl': { namespace: 'yazl' },
  'yauzl': { default: 'yauzl', namespace: 'yauzl' },
  'zod': { namespace: 'z' },
  '@modelcontextprotocol/sdk/server/index.js': { named: { Server: 'Server' } },
  '@modelcontextprotocol/sdk/server/sse.js': { named: { SSEServerTransport: 'SSEServerTransport' } },
  '@modelcontextprotocol/sdk/server/stdio.js': { named: { StdioServerTransport: 'StdioServerTransport' } },
  '@modelcontextprotocol/sdk/server/streamableHttp.js': { named: { StreamableHTTPServerTransport: 'StreamableHTTPServerTransport' } },
  '@modelcontextprotocol/sdk/types.js': {
    named: {
      CallToolRequestSchema: 'CallToolRequestSchema',
      ListToolsRequestSchema: 'ListToolsRequestSchema',
    },
  },
  // Transitive deps of in-tree third_party extractZip.ts / lockfile.ts.
  // Callers use `@utils/third_party/*` which routes through coreBundle.utils;
  // their transitive imports of these npm packages need to stay external and
  // come from utilsBundle just like any other vendored package.
  'graceful-fs': { default: 'gracefulFs', namespace: 'gracefulFs' },
  'retry': { default: 'retry' },
  'signal-exit': { named: { onExit: 'onExit' } },
  'get-stream': { default: 'getStream' },
};

const VENDORED_PACKAGES = new Set(Object.keys(MAPPING));

module.exports = { MAPPING, VENDORED_PACKAGES };
