import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { quantile } from '../benchmarks/statistics.mjs';

const directory = process.argv[2];
assert.ok(directory, 'Pass a retained runtime installation diagnostic directory');
const read = async name => JSON.parse(await readFile(join(directory, name), 'utf8'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
assert.equal(await access(join(directory, 'invalidated.json')).then(() => true, () => false), false, 'Invalidated diagnostic cannot be verified');
const metadata = await read('metadata.json');
const report = await read('report.json');
const samples = await read('samples.json');
assert.equal(metadata.kind, 'instrumented-runtime-component-diagnostic');
assert.equal(metadata.schemaVersion, 2);
assert.equal(report.status, 'passed');
const retainedNames = ['metadata.json', 'samples.json', 'tool-source.mjs', ...Object.values(metadata.scripts).flat().map(script => script.path)];
assert.deepEqual(Object.keys(report.retainedFileHashes).sort(), retainedNames.sort());
for (const name of retainedNames) assert.equal(hash(await readFile(join(directory, name))), report.retainedFileHashes[name]);
for (const scripts of Object.values(metadata.scripts)) {
  for (const script of scripts) {
    const source = await readFile(join(directory, script.path), 'utf8');
    assert.equal(hash(source), script.sha256);
    assert.equal(source.length, script.utf16Units);
  }
}
const combined = await readFile(join(directory, metadata.scripts.combined[0].path), 'utf8');
const escaped = await readFile(join(directory, metadata.scripts.escaped[0].path), 'utf8');
assert.notEqual(combined, escaped);
assert.equal(combined.replaceAll('…', '\\u2026'), escaped);
assert.ok(Array.from(escaped).every(character => character.charCodeAt(0) < 128));
const { configuration } = metadata;
assert.equal(samples.length, configuration.independentLaunches * (configuration.warmupIterations + configuration.measuredIterations) * configuration.variants.length);
const identities = new Set();
const documents = new Set();
for (const sample of samples) {
  assert.ok(Number.isSafeInteger(sample.launchIndex) && sample.launchIndex >= 0 && sample.launchIndex < configuration.independentLaunches);
  assert.ok(Number.isSafeInteger(sample.iteration) && sample.iteration >= 0 && sample.iteration < configuration.warmupIterations + configuration.measuredIterations);
  assert.ok(configuration.variants.includes(sample.variant));
  assert.equal(sample.phase, sample.iteration < configuration.warmupIterations ? 'warmup' : 'measured');
  const identity = `${sample.launchIndex}/${sample.iteration}/${sample.variant}`;
  assert.equal(identities.has(identity), false); identities.add(identity);
  const document = `${sample.launchIndex}/${sample.loader}`;
  assert.equal(documents.has(document), false, 'Every installation must use a new document'); documents.add(document);
  assert.equal(sample.intervals.length, metadata.scripts[sample.variant].length);
  if (['combined', 'split', 'scoped', 'escaped'].includes(sample.variant)) {
    assert.deepEqual(sample.diagnostics, { matches: false, truncated: true, received: 'x'.repeat(4096) + '… [diagnostic truncated]' });
  } else assert.equal(sample.diagnostics, undefined);
  for (const interval of sample.intervals) {
    assert.ok(Number.isFinite(interval.milliseconds) && interval.milliseconds > 0);
    for (const value of Object.values(interval.renderer)) assert.ok(Number.isFinite(value) && value >= 0);
  }
}
for (const variant of configuration.variants) {
  const selected = samples.filter(sample => sample.phase === 'measured' && sample.variant === variant);
  const renderer = field => quantile(selected.map(sample => sample.intervals.reduce((total, interval) => total + (interval.renderer[field] ?? 0), 0)), 0.5);
  assert.deepEqual(report.summary[variant], {
    measuredSamples: selected.length,
    commandMedianMilliseconds: quantile(selected.map(sample => sample.intervals.reduce((total, interval) => total + interval.milliseconds, 0)), 0.5),
    renderer: { declarations: renderer('declarations'), construction: renderer('construction'), wrapperDeclarations: renderer('wrapperDeclarations'), wrapper: renderer('wrapper') },
  });
}
console.log(`Verified ${samples.length} fresh-document installations, exact script variants, retained hashes and recomputed component statistics: ${directory}`);
