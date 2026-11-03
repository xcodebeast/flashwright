// Writes every framework's port of the scenarios into bench/competitors/<framework>/.
// Usage: node bench/competitors/generate.mjs [framework,...]
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { scenarios } from './scenarios.mjs';

export const frameworks = ['playwright', 'flashwright', 'cypress', 'webdriverio', 'selenium', 'puppeteer', 'testcafe', 'nightwatch', 'bun'];

export async function loadAdapter(framework) {
  return (await import(`./${framework}/adapter.mjs`)).default;
}

// LAYOUT=files (default) keeps Playwright's example layout, one test per file; LAYOUT=grouped
// puts each feature's tests in one file (7 files), as most hand-written suites do.
export const layout = process.env.LAYOUT ?? 'files';
const layoutScenarios = layout === 'grouped' ? scenarios.map(scenario => ({ ...scenario, file: scenario.file.split('/')[0] })) : scenarios;

export async function generate(framework) {
  const adapter = await loadAdapter(framework);
  const directory = join(import.meta.dirname, framework);
  await rm(join(directory, 'tests'), { recursive: true, force: true });
  for (const file of adapter.files(layoutScenarios)) {
    await mkdir(dirname(join(directory, file.path)), { recursive: true });
    await writeFile(join(directory, file.path), file.contents);
  }
}

if (import.meta.main) {
  for (const framework of process.argv[2]?.split(',') ?? frameworks)
    await generate(framework);
}
