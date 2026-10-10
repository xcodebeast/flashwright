import assert from 'node:assert/strict';
import { exportRunnerMatrix } from './runner-matrix-snapshot.mjs';

const [sourceDirectory, destination, recordedWorkspace] = process.argv.slice(2);
assert.ok(sourceDirectory && destination && recordedWorkspace && process.argv.length === 5, 'Usage: export-runner-matrix.mjs RAW NEW_DESTINATION RECORDED_WORKSPACE');
const { analysis } = await exportRunnerMatrix({ sourceDirectory, destination, recordedWorkspace });
console.log(JSON.stringify({ destination, independentPairs: analysis.independentPairs, functionalAdmissionPassed: analysis.functionalAdmissionPassed, performanceAccepted: analysis.performanceAccepted }));
