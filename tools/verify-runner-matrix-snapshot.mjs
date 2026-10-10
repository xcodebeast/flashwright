import assert from 'node:assert/strict';
import { verifyRunnerMatrixSnapshot } from './runner-matrix-snapshot.mjs';

const [directory] = process.argv.slice(2);
assert.ok(directory && process.argv.length === 3, 'Usage: verify-runner-matrix-snapshot.mjs SNAPSHOT');
const { analysis } = await verifyRunnerMatrixSnapshot(directory);
console.log(`Verified all ${analysis.independentPairs} runner pairs, retained bytes, original observations and semantic admission. Performance accepted: ${analysis.performanceAccepted}. Historical executable and dependency identities are retained, not freshly validated.`);
