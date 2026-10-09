import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { devices } from 'playwright';
import { prepareDeviceOptions } from '../packages/flashwright-core/dist/commonjs/devices.js';

// Execute only the retained, hash-checked pure helper from the pinned reference.
const source = await readFile('compatibility/upstream/device-metadata.source.js', 'utf8');
const referenceMetadata = new Function(source + '\nreturn calculateUserAgentMetadata;')();
const userAgents = new Set(Object.values(devices).map(device => device.userAgent));
for (const value of ['', 'CustomAgent/1.0', 'LINUX ARM', 'Mac OS X 14_2_1', 'Intel Mac OS X 14_2_1', 'iPhone OS 17_5', 'iPad; CPU OS 17_5', 'Windows NT 10.0 ARM', 'Android 14.2.3', 'Mac OS X 14_2_1 Android 14.2.3']) userAgents.add(value);
for (const userAgent of userAgents) {
  for (const isMobile of [false, true]) {
    assert.deepEqual(prepareDeviceOptions({ userAgent, isMobile }).userAgentMetadata, referenceMetadata({ userAgent, isMobile }), `Pinned user-agent hints differ for ${userAgent}`);
  }
}
console.log(`User-agent metadata matches the pinned helper for ${userAgents.size * 2} profile combinations.`);
