'use strict';

const Module = require('node:module');
const { readFileSync, realpathSync } = require('node:fs');
const { extname, resolve } = require('node:path');

let bootstrapLoaders;
let bootstrapCompiler;

function unsupported(message) {
  const { UnsupportedFeatureError } = require('@flashwright/core');
  return new UnsupportedFeatureError({
    code: 'UnsupportedFeatureError',
    method: 'runner.transform',
    message,
    referenceVersion: '1.60.0',
    browser: 'chromium',
  });
}

function optionTokens(value) {
  const tokens = [];
  let token = '';
  let quote;
  let escaped = false;
  for (const character of value) {
    if (escaped) { token += character; escaped = false; }
    else if (character === '\\' && quote !== "'") escaped = true;
    else if (quote) { if (character === quote) quote = undefined; else token += character; }
    else if (character === '"' || character === "'") quote = character;
    else if (/\s/.test(character)) { if (token) tokens.push(token); token = ''; }
    else token += character;
  }
  if (quote || escaped) throw unsupported('Bun runner startup options could not be parsed safely.');
  if (token) tokens.push(token);
  return tokens;
}

function rejectConfiguredPreloads() {
  const configurations = new Set();
  for (let index = 0; index < process.execArgv.length; index++) {
    const option = process.execArgv[index];
    let configuration;
    if (option.startsWith('--config=')) configuration = option.slice('--config='.length);
    else if (option === '--config' || option === '-c') configuration = process.execArgv[++index];
    else if (option.startsWith('-c') && !option.startsWith('--')) configuration = option.slice(2).replace(/^=/, '');
    else continue;
    if (!configuration || configuration.startsWith('-'))
      throw unsupported('Bun runner startup requires an explicit readable runtime configuration path.');
    configurations.add(resolve(configuration));
  }
  if (configurations.size > 1)
    throw unsupported('Bun runner startup does not support multiple runtime configuration selections.');
  const configuration = configurations.values().next().value || resolve('bunfig.toml');
  let source;
  try { source = readFileSync(configuration, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT' && !configurations.size) return;
    throw unsupported('Bun runner startup could not read its runtime configuration.');
  }
  let settings;
  try { settings = Bun.TOML.parse(source); }
  catch { throw unsupported('Bun runner startup could not parse its runtime configuration.'); }
  if (settings.preload !== undefined && (!Array.isArray(settings.preload) || settings.preload.length !== 0))
    throw unsupported('Bun runner source transformation does not support bunfig.toml runtime preload modules. Remove the top-level preload setting or run the runner with Node.');
}

// A supported executable registers before user configuration. This establishes
// continuity from entry; it does not identify arbitrary preexisting handlers.
function registerOwnedBootstrap(entrypoint) {
  if (!process.versions.bun || bootstrapLoaders) return;
  if (!entrypoint || !process.argv[1] || realpathSync(entrypoint) !== realpathSync(process.argv[1]))
    throw unsupported('Bun runner source transformation requires direct owned CLI or worker entry; programmatic runner entry is unsupported.');
  const startupOptions = [...process.execArgv,
    ...optionTokens(process.env.NODE_OPTIONS || ''), ...optionTokens(process.env.BUN_OPTIONS || '')];
  if (startupOptions.some(option => /^--(?:preload|require|import)(?:=|$)/.test(option) || /^-r/.test(option)))
    throw unsupported('Bun runner source transformation does not support runtime preload modules. Start the owned CLI without --preload, --require, --import or -r.');
  rejectConfiguredPreloads();
  bootstrapLoaders = new Map(Object.entries(Module._extensions));
  bootstrapCompiler = Module.prototype._compile;
}

// Validate before the runner changes its resolver or marks the transform installed.
function prepareOriginalSourceLoader(transformHook, shouldTransform, extensions) {
  if (!bootstrapLoaders || !bootstrapCompiler)
    throw unsupported('Bun runner source transformation requires a clean owned CLI or worker bootstrap; programmatic or preloaded entry is unsupported.');
  if (Module.prototype._compile !== bootstrapCompiler)
    throw unsupported('Bun runner source transformation cannot replace a prior third-party compiler.');

  // Match the pinned hook scope, including Bun's native CommonJS handling.
  const extensionsToOverwrite = extensions.filter(extension => extension !== '.cjs');
  const supportedExtensions = new Set(extensions);
  const previousLoaders = new Map();
  for (const extension of extensionsToOverwrite) {
    const loader = Module._extensions[extension] || Module._extensions['.js'];
    const expected = bootstrapLoaders.get(extension) || bootstrapLoaders.get('.js');
    if (loader !== expected)
      throw unsupported('Bun runner source transformation cannot replace a prior third-party extension loader.');
    previousLoaders.set(extension, loader);
  }

  return function installOriginalSourceLoader() {
    for (const extension of extensionsToOverwrite) {
      const previousLoader = previousLoaders.get(extension);
      Module._extensions[extension] = function compileOwnedOriginalSource(module, filename, ...loaderArguments) {
        if (!supportedExtensions.has(extname(filename)) || !shouldTransform(filename))
          return previousLoader.call(this, module, filename, ...loaderArguments);
        if (module._compile !== bootstrapCompiler)
          throw unsupported('Bun runner source transformation cannot replace a prior third-party compiler.');
        const originalSource = readFileSync(filename, 'utf8');
        const transformedSource = transformHook(originalSource, filename).code;
        bootstrapCompiler.call(module, transformedSource, filename);
      };
    }
  };
}

module.exports = { registerOwnedBootstrap, prepareOriginalSourceLoader };
