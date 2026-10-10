const { appendFileSync, readFileSync, writeFileSync } = require('node:fs');
const { execFileSync } = require('node:child_process');
const { join } = require('node:path');
const configuration = JSON.parse(readFileSync(join(__dirname, 'admission-configuration.json'), 'utf8'));

/** Retain only owned browser commands; the hook's proposed arguments are labelled separately. */
function recordOwnedBrowserProcesses() {
  const owner = Number(process.env.FLASHWRIGHT_CYPRESS_OWNER);
  const lines = execFileSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8', timeout: 5000 }).trim().split('\n');
  const processes = lines.map(line => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    return match && { process: Number(match[1]), parent: Number(match[2]), command: match[3] };
  }).filter(Boolean);
  const descendants = new Set([owner]);
  let changed;
  do {
    changed = false;
    for (const candidate of processes) if (descendants.has(candidate.parent) && !descendants.has(candidate.process)) { descendants.add(candidate.process); changed = true; }
  } while (changed);
  return processes.filter(candidate => descendants.has(candidate.process) && candidate.command.startsWith(process.env.FLASHWRIGHT_BROWSER_PATH + ' ') && candidate.command.includes('--user-data-dir='));
}

module.exports = {
  video: false, screenshotOnRunFailure: false, viewportWidth: configuration.viewport.width, viewportHeight: configuration.viewport.height,
  retries: 0, defaultCommandTimeout: 5000,
  e2e: {
    supportFile: false, specPattern: 'workloads.cy.js', testIsolation: true,
    setupNodeEvents(on, config) {
      on('before:browser:launch', (browser, launchOptions) => {
        writeFileSync(process.env.FLASHWRIGHT_CYPRESS_LAUNCH_REPORT, JSON.stringify({ browser, proposedLaunchOptions: launchOptions }, null, 2) + '\n');
        return launchOptions;
      });
      on('task', {
        admissionObservation(value) {
          appendFileSync(process.env.FLASHWRIGHT_CYPRESS_OBSERVATIONS, JSON.stringify(value) + '\n');
          return null;
        },
        admissionBrowserProcesses() {
          const processes = recordOwnedBrowserProcesses();
          writeFileSync(process.env.FLASHWRIGHT_CYPRESS_PROCESSES, JSON.stringify(processes, null, 2) + '\n');
          return processes.length;
        },
      });
      return config;
    },
  },
};
