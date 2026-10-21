import { readdir, lstat, stat } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import path from 'node:path';
import { failure } from '@flashwright/core';

export type IndependentPattern = string | RegExp;
export interface IndependentReporter {
  readonly name: 'line' | 'list' | 'dot' | 'json';
  readonly options: { readonly outputFile?: string };
}
export interface IndependentConfigOverrides {
  workers?: number;
  retries?: number;
  grep?: string;
  files?: string[];
}
export interface IndependentProjectsOverrides extends IndependentConfigOverrides {
  project?: string[];
}
export interface IndependentProject {
  readonly name: string;
  readonly dependencies: readonly string[];
  readonly config: IndependentConfig;
}
export interface IndependentConfig {
  readonly configFile: string;
  readonly configDir: string;
  readonly testDir: string;
  readonly outputDir: string;
  readonly testMatch: readonly IndependentPattern[];
  readonly testIgnore: readonly IndependentPattern[];
  readonly timeout: number;
  readonly expect: { readonly timeout: number };
  readonly workers: number;
  readonly retries: number;
  readonly fullyParallel: boolean;
  readonly forbidOnly: boolean;
  readonly use: Readonly<Record<string, unknown>>;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly reporter: readonly IndependentReporter[];
  /** CLI paths are resolved from the invocation directory, as ordinary CLI paths are. */
  readonly files: readonly string[];
  /** Retained for title selection after collection, never applied to file names. */
  readonly grep: string | undefined;
}

function invalid(method: string, message: string): never { throw failure('InvalidArgumentError', method, message); }
function unsupported(method: string): never {
  throw failure('UnsupportedFeatureError', method, 'option is not implemented at this independent runner configuration boundary; global setup/teardown and webServer are not available');
}

const configFields = ['testDir', 'testMatch', 'testIgnore', 'timeout', 'workers', 'retries', 'fullyParallel', 'forbidOnly', 'outputDir', 'use', 'expect', 'reporter', 'repeatEach', 'maxFailures', 'metadata'];
const projectFields = ['name', 'dependencies', 'testDir', 'testMatch', 'testIgnore', 'timeout', 'retries', 'fullyParallel', 'outputDir', 'use', 'expect'];
function object(value: unknown, method: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid(method, 'expected a plain object');
  return value as Record<string, unknown>;
}
function fields(value: Record<string, unknown>, supported: readonly string[], method: string): void {
  for (const name of Reflect.ownKeys(value)) {
    if (typeof name !== 'string') { if (Reflect.get(value, name) !== undefined) unsupported(`${method}.${String(name)}`); }
    else if (!supported.includes(name) && value[name] !== undefined) unsupported(`${method}.${name}`);
  }
}
function integer(value: unknown, fallback: number, minimum: number, method: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) invalid(method, `expected an integer greater than or equal to ${minimum}`);
  return value;
}
function boolean(value: unknown, method: string): boolean {
  if (value === undefined) return false;
  if (typeof value !== 'boolean') invalid(method, 'expected a boolean');
  return value;
}
function string(value: unknown, method: string): string {
  if (typeof value !== 'string' || value.length === 0) invalid(method, 'expected a nonempty string');
  return value;
}
function patterns(value: unknown, fallback: IndependentPattern[], method: string): IndependentPattern[] {
  const result = value === undefined ? fallback : Array.isArray(value) ? value : [value];
  return result.map(item => {
    if (item instanceof RegExp) return new RegExp(item.source, item.flags);
    const pattern = string(item, method);
    globExpression(pattern, method);
    return pattern;
  });
}

// Compile common path globs identically on Bun and Node. Their built-in matchesGlob
// implementations disagree on the pinned runtime's positive extglob syntax.
function globExpression(pattern: string, method: string): RegExp {
  let position = 0;
  const source = pattern.replaceAll('\\', '/');
  const literal = (character: string): string => character.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
  function sequence(terminators: string): string {
    let expression = '';
    while (position < source.length && !terminators.includes(source[position]!)) {
      const character = source[position++]!;
      if ('@+?*!'.includes(character) && source[position] === '(') {
        if (character === '!') unsupported(`${method}.negativeExtglob`);
        position++;
        const alternatives = [sequence('|)')];
        while (source[position] === '|') { position++; alternatives.push(sequence('|)')); }
        if (source[position++] !== ')') invalid(method, 'unterminated extglob');
        expression += `(?:${alternatives.join('|')})${character === '@' ? '' : character}`;
      } else if (character === '{') {
        const alternatives = [sequence(',}')];
        while (source[position] === ',') { position++; alternatives.push(sequence(',}')); }
        if (source[position++] !== '}') invalid(method, 'unterminated glob alternatives');
        expression += `(?:${alternatives.join('|')})`;
      } else if (character === '[') {
        const start = position;
        while (position < source.length && source[position] !== ']') position++;
        if (position === source.length || position === start) invalid(method, 'invalid glob character class');
        let members = source.slice(start, position++);
        if (members.startsWith('!')) members = '^' + members.slice(1);
        expression += `(?!/)[${members}]`;
      } else if (character === '*') {
        if (source[position] === '*' && (position === 1 || source[position - 2] === '/') && (source[position + 1] === '/' || position + 1 === source.length)) {
          position++;
          if (source[position] === '/') { position++; expression += '(?:.*/)?'; }
          else expression += '.*';
        } else expression += '[^/]*';
      } else if (character === '?') expression += '[^/]';
      else expression += literal(character);
    }
    return expression;
  }
  const prefix = path.isAbsolute(pattern) || source.startsWith('**/') ? '' : '(?:.*/)?';
  try { return new RegExp(`^${prefix}${sequence('')}$`); }
  catch (error) {
    if (error instanceof Error && error.name !== 'SyntaxError') throw error;
    return invalid(method, 'invalid glob expression');
  }
}

function reporters(value: unknown, configDir: string): IndependentReporter[] {
  const entries = value === undefined ? ['list'] : typeof value === 'string' ? [value] : value;
  if (!Array.isArray(entries) || entries.length === 0) invalid('config.reporter', 'expected a reporter name or nonempty array of reporter tuples');
  return entries.map(entry => {
    let name: unknown = entry, options: Record<string, unknown> = {};
    if (Array.isArray(entry)) {
      if (entry.length < 1 || entry.length > 2) invalid('config.reporter', 'reporter tuples require a name and optional options');
      name = entry[0];
      if (entry[1] !== undefined) options = object(entry[1], 'config.reporter.options');
    } else if (typeof entry !== 'string') invalid('config.reporter', 'expected a reporter name or tuple');
    if (typeof name !== 'string') invalid('config.reporter', 'expected a reporter name');
    if (!['line', 'list', 'dot', 'json'].includes(name)) unsupported(`config.reporter.${name}`);
    fields(options, name === 'json' ? ['outputFile'] : [], `config.reporter.${name}`);
    const outputFile = options.outputFile === undefined ? undefined : path.resolve(configDir, string(options.outputFile, 'config.reporter.json.outputFile'));
    return { name: name as IndependentReporter['name'], options: outputFile === undefined ? {} : { outputFile } };
  });
}

/** Validate completely before discovery, test loading or output-directory effects. */
export function resolveIndependentConfig(value: unknown, configFile: string, overrides: IndependentConfigOverrides = {}): IndependentConfig {
  const input = object(value, 'config');
  fields(input, configFields, 'config');
  const cli = object(overrides, 'CLI');
  fields(cli, ['workers', 'retries', 'grep', 'files'], 'CLI');
  const absoluteConfigFile = path.resolve(string(configFile, 'configFile'));
  const configDir = path.dirname(absoluteConfigFile);
  const expect = input.expect === undefined ? {} : object(input.expect, 'config.expect');
  fields(expect, ['timeout'], 'config.expect');
  const workers = integer(input.workers, Math.max(1, Math.floor(availableParallelism() / 2)), 1, 'config.workers');
  const retries = integer(input.retries, 0, 0, 'config.retries');
  if (integer(input.repeatEach, 1, 1, 'config.repeatEach') !== 1) unsupported('config.repeatEach');
  if (integer(input.maxFailures, 0, 0, 'config.maxFailures') !== 0) unsupported('config.maxFailures');
  if (cli.files !== undefined && !Array.isArray(cli.files)) invalid('CLI.files', 'expected an array of paths');
  return {
    configFile: absoluteConfigFile, configDir,
    testDir: path.resolve(configDir, input.testDir === undefined ? '.' : string(input.testDir, 'config.testDir')),
    outputDir: path.resolve(configDir, input.outputDir === undefined ? 'test-results' : string(input.outputDir, 'config.outputDir')),
    testMatch: patterns(input.testMatch, [/\.(spec|test)\.[cm]?[jt]sx?$/], 'config.testMatch'),
    testIgnore: patterns(input.testIgnore, [], 'config.testIgnore'),
    timeout: integer(input.timeout, 30000, 0, 'config.timeout'),
    expect: { timeout: integer(expect.timeout, 5000, 0, 'config.expect.timeout') },
    workers: integer(cli.workers, workers, 1, 'CLI.workers'),
    retries: integer(cli.retries, retries, 0, 'CLI.retries'),
    fullyParallel: boolean(input.fullyParallel, 'config.fullyParallel'),
    forbidOnly: boolean(input.forbidOnly, 'config.forbidOnly'),
    use: input.use === undefined ? {} : { ...object(input.use, 'config.use') },
    metadata: input.metadata === undefined ? {} : { ...object(input.metadata, 'config.metadata') },
    reporter: reporters(input.reporter, configDir),
    files: ((cli.files ?? []) as unknown[]).map(file => path.resolve(string(file, 'CLI.files'))),
    grep: cli.grep === undefined ? undefined : string(cli.grep, 'CLI.grep'),
  };
}

/** Resolve and validate the complete graph before selection or test discovery. */
export function resolveIndependentProjects(value: unknown, configFile: string, overrides: IndependentProjectsOverrides = {}): IndependentProject[] {
  const input = object(value, 'config');
  fields(input, [...configFields, 'projects'], 'config');
  const cli = object(overrides, 'CLI');
  fields(cli, ['workers', 'retries', 'grep', 'files', 'project'], 'CLI');
  if (cli.project !== undefined && !Array.isArray(cli.project)) invalid('CLI.project', 'expected an array of project names');
  const projectName = (value: unknown, method: string): string => {
    const name = string(value, method);
    if (!name.trim()) invalid(method, 'expected a nonempty project name');
    return name;
  };
  const selection = ((cli.project ?? []) as unknown[]).map(name => projectName(name, 'CLI.project'));
  const { projects: declarations, ...root } = input;
  const { project: _selection, ...commonOverrides } = cli;
  const rootConfig = resolveIndependentConfig(root, configFile, commonOverrides as IndependentConfigOverrides);
  if (declarations === undefined) {
    if (selection.length) invalid('CLI.project', `unknown project: ${selection[0]}`);
    return [{ name: '', dependencies: [], config: rootConfig }];
  }
  if (!Array.isArray(declarations) || declarations.length === 0) invalid('config.projects', 'expected a nonempty array of named projects');
  const names = new Set<string>();
  const projects = declarations.map((declaration, index): IndependentProject => {
    const method = `config.projects[${index}]`;
    const project = object(declaration, method);
    fields(project, projectFields, method);
    const name = projectName(project.name, `${method}.name`);
    if (names.has(name)) invalid(`${method}.name`, `duplicate project name: ${name}`);
    names.add(name);
    if (project.dependencies !== undefined && !Array.isArray(project.dependencies)) invalid(`${method}.dependencies`, 'expected an array of project names');
    const dependencies = [...new Set(((project.dependencies ?? []) as unknown[]).map(dependency => projectName(dependency, `${method}.dependencies`)))];
    const merged = { ...root };
    for (const [field, value] of Object.entries(project)) {
      if (value === undefined || field === 'name' || field === 'dependencies') continue;
      if (field === 'use' || field === 'expect') merged[field] = { ...object(root[field] ?? {}, `config.${field}`), ...object(value, `${method}.${field}`) };
      else merged[field] = value;
    }
    return { name, dependencies, config: resolveIndependentConfig(merged, configFile, commonOverrides as IndependentConfigOverrides) };
  });
  for (const project of projects) for (const dependency of project.dependencies) {
    if (!names.has(dependency)) invalid('config.projects.dependencies', `project ${project.name} depends on unknown project: ${dependency}`);
  }
  const ordered: IndependentProject[] = [], completed = new Set<string>();
  while (ordered.length < projects.length) {
    const next = projects.find(project => !completed.has(project.name) && project.dependencies.every(dependency => completed.has(dependency)));
    if (!next) invalid('config.projects.dependencies', 'project dependency cycle detected');
    ordered.push(next);
    completed.add(next.name);
  }
  for (const name of selection) if (!names.has(name)) invalid('CLI.project', `unknown project: ${name}`);
  const selected = new Set(selection.length ? selection : projects.map(project => project.name));
  const required = new Set(selected);
  for (const project of [...ordered].reverse()) {
    if (required.has(project.name)) for (const dependency of project.dependencies) required.add(dependency);
  }
  const dependencies = new Set<string>();
  for (const project of ordered) {
    if (required.has(project.name)) for (const dependency of project.dependencies) dependencies.add(dependency);
  }
  return ordered.filter(project => required.has(project.name)).map(project => !dependencies.has(project.name) ? project : {
    ...project, config: { ...project.config, files: [], grep: undefined },
  });
}

function within(file: string, directory: string): boolean {
  const relative = path.relative(directory, file);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export async function discoverIndependentTests(config: IndependentConfig): Promise<string[]> {
  const match = (patterns: readonly IndependentPattern[]) => patterns.map(pattern => pattern instanceof RegExp ? new RegExp(pattern.source, pattern.flags) : globExpression(pattern, 'config.testMatch'));
  const matches = (patterns: readonly RegExp[], file: string) => patterns.some(pattern => { pattern.lastIndex = 0; return pattern.test(file); });
  const include = match(config.testMatch), exclude = match(config.testIgnore);
  const result: string[] = [];
  async function visit(directory: string): Promise<void> {
    if (within(directory, config.outputDir)) return;
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of entries) {
      if (['node_modules', '.git', 'workbench'].includes(entry.name)) continue;
      const file = path.join(directory, entry.name);
      if (within(file, config.outputDir)) continue;
      if (entry.isDirectory()) await visit(file);
      else {
        let regularFile = entry.isFile();
        if (entry.isSymbolicLink()) {
          try { regularFile = (await stat(file)).isFile(); }
          catch (error) { if (['ENOENT', 'ELOOP'].includes((error as NodeJS.ErrnoException).code ?? '')) continue; throw error; }
        }
        if (!regularFile) continue;
        const normalized = file.split(path.sep).join('/');
        if (matches(include, normalized) && !matches(exclude, normalized) && (!config.files.length || config.files.some(selected => within(file, selected)))) result.push(file);
      }
    }
  }
  let root;
  try { root = await lstat(config.testDir); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  if (!root.isDirectory()) invalid('config.testDir', 'expected a directory; directory symlinks are not followed');
  await visit(config.testDir);
  return result.sort();
}
