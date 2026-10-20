import assert from 'node:assert/strict';

const MiB = 1024 ** 2;
export const finalGoalEvidenceLimits = Object.freeze({
  maximumFileBytes: 32 * MiB,
  maximumMetadataJsonBytes: 512 * MiB,
  maximumRunJsonBytes: 256 * MiB,
  maximumRuns: 9 * 2 * 8 * 2,
  maximumAggregateJsonBytes: (512 + 9 * 2 * 8 * 2 * 256) * MiB,
  opaqueReadChunkBytes: 64 * 1024,
  maximumLinuxRunCachedBytes: 256 * MiB,
});

/** Input accounting only: decoded objects and GC determine the actual live heap. */
export function createFinalGoalEvidenceBudget(maximumAggregateJsonBytes = finalGoalEvidenceLimits.maximumAggregateJsonBytes) {
  assert.ok(Number.isSafeInteger(maximumAggregateJsonBytes) && maximumAggregateJsonBytes > 0
    && maximumAggregateJsonBytes <= finalGoalEvidenceLimits.maximumAggregateJsonBytes,
  'JSON byte budget must be positive and cannot exceed the declared limit');
  let aggregateJsonBytes = 0, metadataJsonBytes = 0, runCount = 0, maximumObservedRunJsonBytes = 0;
  const runs = new WeakMap();
  function reserveAggregate(size) {
    assert.ok(Number.isSafeInteger(size) && size >= 0, 'Invalid evidence byte reservation');
    assert.ok(size <= maximumAggregateJsonBytes - aggregateJsonBytes, 'Aggregate JSON byte budget exceeded before parsing');
    aggregateJsonBytes += size;
  }
  return {
    reserveMetadata(size) {
      assert.ok(size <= finalGoalEvidenceLimits.maximumMetadataJsonBytes - metadataJsonBytes,
        'Campaign metadata JSON byte budget exceeded before parsing');
      reserveAggregate(size);
      metadataJsonBytes += size;
    },
    forRun(run) {
      assert.ok(run && typeof run === 'object', 'Missing original run for byte accounting');
      if (runs.has(run)) return runs.get(run);
      assert.ok(runCount < finalGoalEvidenceLimits.maximumRuns, 'Too many runs for evidence byte accounting');
      runCount++;
      let runJsonBytes = 0;
      const reserve = size => {
        assert.ok(size <= finalGoalEvidenceLimits.maximumRunJsonBytes - runJsonBytes,
          'Run JSON byte budget exceeded before parsing');
        reserveAggregate(size);
        runJsonBytes += size;
        maximumObservedRunJsonBytes = Math.max(maximumObservedRunJsonBytes, runJsonBytes);
      };
      runs.set(run, reserve);
      return reserve;
    },
    summary() {
      return { ...finalGoalEvidenceLimits, maximumAggregateJsonBytes, aggregateJsonBytes, metadataJsonBytes,
        runCount, maximumObservedRunJsonBytes };
    },
  };
}
