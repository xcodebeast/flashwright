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

/* eslint-disable no-restricted-properties */

import fs from 'fs';
import path from 'path';

import { getPlaywrightVersion, registry } from 'playwright-core/lib/coreBundle';
import { codingAgentEnvVars, getPackageManagerExecCommand } from '@utils/env';

import { configLoader } from '../common';
import { packageJSON, packageRoot } from '../package';
import { collectFilesForProject } from './projectUtils';
import { warmSessionStatus } from './session';

import type { FullConfigInternal, FullProjectInternal } from '../common/config';

// Flashwright: `playwright doctor` checks, without changing anything, what a run needs: Node,
// one copy of Playwright, a config that loads, test files, browsers and their system libraries,
// and a display for headed projects. It also says which Flashwright modes a run here would use.

type Level = 'ok' | 'info' | 'warning' | 'error';
type Check = { level: Level, title: string, details?: string[] };

export async function runDoctor(options: { config?: string, json?: boolean }): Promise<number> {
  const checks: Check[] = [];
  const exec = getPackageManagerExecCommand();

  checks.push(checkNode());
  checks.push(...checkInstall(options.config));

  let config: FullConfigInternal | undefined;
  try {
    config = await configLoader.loadConfigFromFile(options.config);
    const file = config.config.configFile ? path.relative(process.cwd(), config.config.configFile) || config.config.configFile : 'none, using the defaults';
    checks.push({ level: 'ok', title: `Config: ${file}, ${config.projects.length} project${config.projects.length === 1 ? '' : 's'}` });
  } catch (e) {
    checks.push({ level: 'error', title: 'Config does not load', details: String(e?.message ?? e).split('\n').slice(0, 12) });
  }

  if (config) {
    for (const project of config.projects)
      checks.push(await checkTestFiles(project));
    checks.push(...await checkBrowsers(config.projects, exec));
    checks.push(...checkDisplay(config.projects));
  }

  const proxies = ['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy', 'NO_PROXY', 'no_proxy'].filter(name => process.env[name]);
  if (proxies.length)
    checks.push({ level: 'info', title: `Proxy variables are set: ${proxies.join(', ')}`, details: ['Browser downloads use them; browsers use a proxy only through the proxy option.'] });
  if (process.env.CI)
    checks.push({ level: 'info', title: 'CI is set: the dot reporter is the default, retries and forbidOnly often depend on it' });

  if (config) {
    const agents = codingAgentEnvVars.filter(name => process.env[name] && process.env[name] !== '0' && process.env[name] !== 'false');
    const reason = process.env.FLASHWRIGHT_AGENT_MODE ? 'FLASHWRIGHT_AGENT_MODE is set' : agents.length ? `${agents.join(', ')} ${agents.length === 1 ? 'is' : 'are'} set` : 'no coding agent detected';
    checks.push({ level: 'info', title: `Agent mode: ${config.config.agentMode ? 'on' : 'off'} (${reason})` });
  }
  const session = warmSessionStatus(process.cwd());
  checks.push({ level: 'info', title: `Warm session: ${session.requested ? 'on' : 'off'}${session.running ? ', one is running for this directory' : ''}` });

  const errors = checks.filter(c => c.level === 'error').length;
  const warnings = checks.filter(c => c.level === 'warning').length;
  if (options.json) {
    process.stdout.write(JSON.stringify({ ok: !errors, errors, warnings, checks }, undefined, 2) + '\n');
  } else {
    const marks: Record<Level, string> = { ok: '✓', info: '·', warning: '!', error: '✗' };
    const lines = ['', 'Flashwright doctor', ''];
    for (const check of checks) {
      lines.push(`  ${marks[check.level]} ${check.title}`);
      for (const detail of check.details ?? [])
        lines.push(`      ${detail}`);
    }
    lines.push('');
    lines.push(errors || warnings ? `  ${[errors ? `${errors} problem${errors === 1 ? '' : 's'}` : '', warnings ? `${warnings} warning${warnings === 1 ? '' : 's'}` : ''].filter(Boolean).join(', ')}.` : '  No problems found.');
    lines.push('');
    process.stdout.write(lines.join('\n'));
  }
  return errors ? 1 : 0;
}

function checkNode(): Check {
  const required = packageJSON.engines?.node as string | undefined;
  const wanted = Number(required?.match(/\d+/)?.[0] ?? 0);
  const major = Number(process.versions.node.split('.')[0]);
  if (major < wanted)
    return { level: 'error', title: `Node.js ${process.version} is older than Flashwright needs (${required})` };
  return { level: 'ok', title: `Node.js ${process.version}` };
}

function checkInstall(configFile: string | undefined): Check[] {
  const checks: Check[] = [];
  const coreVersion = getPlaywrightVersion();
  if (coreVersion !== packageJSON.version)
    checks.push({ level: 'error', title: `playwright ${packageJSON.version} runs with playwright-core ${coreVersion}`, details: ['Reinstall so that both have the same version.'] });
  else
    checks.push({ level: 'ok', title: `Flashwright ${packageJSON.version}` });

  // Two copies of the test runner make tests fail to load ("Requiring @playwright/test second time").
  const from = configFile ? path.dirname(path.resolve(configFile)) : process.cwd();
  const ours = realpath(packageRoot);
  for (const name of ['@playwright/test', 'playwright']) {
    // Node's resolution, without the test runner's hooks that send these names to this copy.
    const entry = findPackage(name, from);
    const resolved = entry && (name === 'playwright' ? entry : findPackage('playwright', entry));
    if (!resolved)
      continue;
    if (realpath(resolved) !== ours) {
      const version = readVersion(path.join(resolved, 'package.json'));
      checks.push({ level: 'error', title: `The project's ${name} is another copy of Playwright${version ? ` (${version})` : ''}`, details: [realpath(resolved), `This one is ${ours}. Tests import ${name}, so they would load a second test runner.`] });
    }
  }
  return checks;
}

async function checkTestFiles(project: FullProjectInternal): Promise<Check> {
  const name = projectLabel(project);
  try {
    const files = await collectFilesForProject(project);
    if (!files.length)
      return { level: 'warning', title: `${name}: no test files`, details: [`testDir: ${path.relative(process.cwd(), project.project.testDir) || '.'}`, `testMatch: ${String(project.project.testMatch)}`] };
    return { level: 'ok', title: `${name}: ${files.length} test file${files.length === 1 ? '' : 's'}` };
  } catch (e) {
    return { level: 'error', title: `${name}: test files cannot be listed`, details: [String(e?.message ?? e)] };
  }
}

async function checkBrowsers(projects: FullProjectInternal[], exec: string): Promise<Check[]> {
  // Projects that share a browser share its check.
  const byExecutable = new Map<string, { projects: string[], executablePath?: string }>();
  for (const project of projects) {
    const use = project.project.use as any;
    const executablePath = use?.launchOptions?.executablePath as string | undefined;
    const browserName = (use?.browserName ?? use?.defaultBrowserType ?? 'chromium') as string;
    const channel = (use?.channel ?? use?.launchOptions?.channel) as string | undefined;
    const headless = (use?.headless ?? use?.launchOptions?.headless ?? true) as boolean;
    let key: string;
    if (executablePath)
      key = 'path:' + executablePath;
    else if (browserName === 'chromium')
      key = channel && !registry.registry.isChromiumAlias(channel) ? channel : (headless && !channel ? 'chromium-headless-shell' : 'chromium');
    else
      key = browserName;
    const entry = byExecutable.get(key) ?? { projects: [], executablePath };
    entry.projects.push(project.project.name || '(unnamed)');
    byExecutable.set(key, entry);
  }

  const checks: Check[] = [];
  for (const [key, { projects, executablePath }] of byExecutable) {
    const used = `used by ${projects.join(', ')}`;
    if (executablePath) {
      checks.push(fs.existsSync(executablePath)
        ? { level: 'ok', title: `Browser at ${executablePath} (${used})` }
        : { level: 'error', title: `Browser at ${executablePath} does not exist (${used})` });
      continue;
    }
    const executable = registry.registry.findExecutable(key);
    if (!executable) {
      checks.push({ level: 'warning', title: `Unknown browser "${key}" (${used})` });
      continue;
    }
    const label = `${executable.title ?? executable.name}${executable.browserVersion ? ' ' + executable.browserVersion : ''}`;
    const file = executable.executablePath();
    if (!file || !fs.existsSync(file)) {
      checks.push({ level: 'error', title: `${label} is not installed (${used})`, details: [`Install it with: ${exec} playwright install ${executable.name}`] });
      continue;
    }
    try {
      await executable._validateHostRequirements('javascript');
      checks.push({ level: 'ok', title: `${label} (${used})` });
    } catch (e) {
      checks.push({ level: 'error', title: `${label} is missing system libraries (${used})`, details: missingLibraries(String(e?.message ?? e), exec, executable.name) });
    }
  }
  return checks;
}

function missingLibraries(message: string, exec: string, name: string): string[] {
  const text = message.replace(/[║╔╗╚╝═]/g, '');
  const apt = text.match(/apt-get install ([\s\S]*?)(?:\n\s*\n|<3|$)/);
  const packages = apt ? apt[1].split(/[\s\\]+/).filter(Boolean) : [];
  if (packages.length)
    return [packages.join(' '), `Install them with: sudo ${exec} playwright install-deps ${name}`];
  const libraries = text.match(/Missing libraries:([\s\S]*?)(?:\n\s*\n|<3|$)/);
  if (libraries)
    return [libraries[1].split(/\s+/).filter(Boolean).join(' ')];
  return text.split('\n').map(line => line.trim()).filter(Boolean).slice(0, 8);
}

function checkDisplay(projects: FullProjectInternal[]): Check[] {
  if (process.platform !== 'linux' || process.env.DISPLAY || process.env.WAYLAND_DISPLAY)
    return [];
  const headed = projects.filter(project => {
    const use = project.project.use as any;
    return (use?.headless ?? use?.launchOptions?.headless) === false;
  });
  if (!headed.length)
    return [];
  return [{ level: 'error', title: `No display for headed projects: ${headed.map(projectLabel).join(', ')}`, details: ['Neither DISPLAY nor WAYLAND_DISPLAY is set. Run them headless, or under xvfb-run.'] }];
}

function projectLabel(project: FullProjectInternal): string {
  return project.project.name ? `Project ${project.project.name}` : 'Project';
}

function findPackage(name: string, from: string): string | undefined {
  for (let dir = path.resolve(from); ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'node_modules', name);
    if (fs.existsSync(path.join(candidate, 'package.json')))
      return candidate;
    if (path.dirname(dir) === dir)
      return undefined;
  }
}

function realpath(file: string): string {
  try {
    return fs.realpathSync(file);
  } catch {
    return file;
  }
}

function readVersion(file: string): string | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')).version;
  } catch {
    return undefined;
  }
}
