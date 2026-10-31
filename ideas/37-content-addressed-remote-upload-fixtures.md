# Transfer repeated remote upload fixtures once

**Scope:** remote browsers repeatedly receiving large files or directories through setInputFiles. **Effort:** large. **Priority:** high for repeated media/document uploads over limited bandwidth.

**Assessed 2026-10-31:** deferred: remote browsers only.

Research proposal, 2026-10-31. No transfers or measurements. Unlike [windowed artifact downloads](30-windowed-remote-artifact-streams.md), this avoids sending already-present bytes. It also differs from [API multipart assembly](16-segmented-api-request-bodies.md).

## Evidence

[`convertInputFiles`](../packages/playwright-core/src/client/elementHandle.ts) enumerates remote input files, calls `createTempFiles`, and streams each file to the server on every invocation. There is no content lookup in that path. [`WritableStreamImpl`](../packages/playwright-core/src/client/writableStream.ts) also waits for each channel write, but merely fixing that transport would still resend the whole fixture every test.

Local path uploads already pass paths instead of transferring contents. This proposal must not claim a local-path win. A [content-addressed store](https://bazel.build/remote/caching) is an established way to separate immutable file bytes from per-operation metadata; adapting it to browser upload lifetimes is the new work.

## Proposed change

Maintain a bounded fixture-content store on the remote Playwright server, scoped to an authorized project/session. For each upload, identify the exact bytes being consumed, query missing content IDs in one manifest, and transfer only missing objects. Verify received length and digest before publishing an object atomically.

Create a fresh per-call file manifest containing names, relative directory paths, order and modification times. Materialize private files from cached bytes using copy-on-write clones where available, otherwise a copy. Keep cache objects immutable; changing a file's timestamp or deleting an upload must not alter another test's object. Do not use mutable hardlinks as a shortcut.

Hash the actual stream captured for this call. Path, size and mtime alone cannot establish content identity. Avoid a hash-then-reread race by retaining/staging the captured bytes or using a supported immutable filesystem snapshot. Small files can remain buffered; large-file staging needs bounded memory and honest disk-cost accounting. A miss uses those same bytes, not a second read of a potentially changed source.

Keep the current simple transfer below a size/reuse threshold. Batched missing-object queries prevent one metadata round trip per small file. Windowed transport can be added separately for misses, without counting its gain twice.

## Compatibility

Publish the file selection and dispatch input/change events only after all required objects are ready, as today. Preserve file contents, names, order, MIME behavior, lastModified, directory-relative paths, empty selections, errors and context-close cleanup.

An expired, missing or corrupt cache entry causes a verified retransmission before selection, never an empty file or success. Bound storage and active references; evict only unleased objects. Session disposal removes retained private fixture data according to an explicit policy. Old servers retain the existing protocol, and remote browsers not colocated with their server retain their existing limitations.

## Payoff and later decision

For N uploads of an unchanged S-byte fixture, network payload can approach S plus N small manifests instead of N × S. Local hashing, materialization and browser reading still occur. One-off uploads, tiny files or slow staging disks may be slower, so measure complete `setInputFiles` duration rather than cache-hit rate.

Later compare repeated and unique files, same-name changed bytes, metadata-only changes, large directories, interrupted publication and eviction. Verify browser-observed bytes and metadata. Run input-file/remote-connection coverage, `tests/page` on `chromium-page` and `tests/playwright-test` against pristine upstream in `workbench/pw-src`.

Report remote upload rows beside `node bench/run.mjs <scenario> <workers> <iterations> stock,fork` and the full `node bench/matrix.mjs`, including current-fork cold/warm cache controls under the [shared rules](01-browser-native-actions.md#payoff-and-decision-test). Include local staging, remote storage, cleanup and all network traffic. Defer execution while this machine is busy.
