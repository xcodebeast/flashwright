import { resolve } from 'node:path';
import { initializeIndependentCollection, collectIndependentFile, sealIndependentCollection } from '../independent.js';
import { resolveIndependentProjects, discoverIndependentTests, type IndependentProjectsOverrides } from './config.js';
import { configureIndependentExpect } from './expect.js';
import { beginOutput, finishOutput } from './output.js';
import type { ProcessSuiteModule } from './process-protocol.js';
import { registerIndependentLoader } from './loader.js';

registerIndependentLoader();
const settings = JSON.parse(process.env.FLASHWRIGHT_INDEPENDENT_RUN ?? '{}') as { configFile: string; outputDir: string; projectName: string; overrides: IndependentProjectsOverrides };
const configuration = require(settings.configFile) as { default?: unknown };
const project = resolveIndependentProjects(configuration.default ?? configuration, settings.configFile, settings.overrides).find(project => project.name === settings.projectName);
if (!project) throw new Error('Independent project disappeared during worker collection');
const config = project.config;
configureIndependentExpect({ timeout: config.expect.timeout });
export const loadSuite: ProcessSuiteModule['loadSuite'] = async () => {
  initializeIndependentCollection(config.use);
  for (const file of await discoverIndependentTests(config)) await collectIndependentFile(file, config.fullyParallel, () => require(resolve(file)));
  const tests = sealIndependentCollection();
  for (const key of Object.keys(config.use)) if (!tests.some(test => test.pool.resolve(key))) throw new Error(`Unknown independent fixture option: ${key}`);
  const expression = config.grep === undefined ? undefined : new RegExp(config.grep);
  return tests.filter(test => !expression || expression.test(test.titlePath.join(' ')));
};
export const onBegin: ProcessSuiteModule['onBegin'] = (test, info) => beginOutput(test, info, settings.outputDir, { ...config, name: project.name });
export const onResult: ProcessSuiteModule['onResult'] = finishOutput;
