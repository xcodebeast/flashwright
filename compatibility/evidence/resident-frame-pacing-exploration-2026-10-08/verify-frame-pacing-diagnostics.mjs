import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { verifyResidentLoad } from '../benchmarks/resident-load-contract.mjs';
const root = 'compatibility/evidence/resident-frame-pacing-exploration-2026-10-08';
const configuration = JSON.parse(await readFile('benchmarks/configurations/resident-load.json'));
const policy = JSON.parse(await readFile('crates/flashwright-browser/src/chromium-launch-policy.json'));
const checkpoint = JSON.parse(await readFile('compatibility/evidence/resident-frame-pacing-checkpoint-2026-10-08.json'));
let launches = 0;
for (const name of ['diagnostic-001', 'diagnostic-002']) {
  const directory = join(root, name);
  const metadata = JSON.parse(await readFile(join(directory, 'metadata.json')));
  assert.deepEqual(metadata.sources, checkpoint.sources);
  assert.equal(metadata.driverSha256, checkpoint.coreEvidence[0].driverSha256);
  for (const file of await readdir(directory)) {
    if (!file.startsWith('launch-')) continue;
    const record = JSON.parse(await readFile(join(directory, file)));
    verifyResidentLoad(record, configuration, policy, checkpoint.coreEvidence[0].browser.executablePath, true);
    launches++;
  }
}
assert.equal(launches, 9);
console.log('Verified all nine separate instrumented fixed-work diagnostics.');
