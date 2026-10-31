# Clone large local artifacts with copy-on-write files

Scope: large downloads, videos, traces and file attachments on clone-capable filesystems. Effort: medium for initial copy sites; large for broad integration. Priority: promising speed and storage improvement within this workload.

**Assessed 2026-10-31:** deferred: only large local artifacts on filesystems that can clone files.

Research, 2026-10-31, against `95f3e831` and the live worktree. No files copied, filesystems probed or I/O tests performed.

## Evidence and distinct opportunity

[`normalizeAndSaveAttachment`](../packages/playwright/src/util.ts) copies a path attachment into the test output directory with `fs.promises.copyFile` and no clone flag. [`ArtifactDispatcher.saveAs`](../packages/playwright-core/src/server/dispatchers/artifactDispatcher.ts) does the same for local downloads/video artifacts. [`copyFileAndMakeWritable`](../packages/utils/fileUtils.ts) also uses an ordinary copy.

[Node's COPYFILE_FICLONE option](https://nodejs.org/docs/latest-v22.x/api/fs.html#fspromisescopyfilesrc-dest-mode) requests a copy-on-write clone and falls back to copying where unsupported. The destination remains a separate file; writes allocate private blocks. This is a candidate implementation, not a promise that today's underlying copy implementation always duplicates blocks. Some OS/filesystem combinations already optimize ordinary copies.

[Idea 30](30-windowed-remote-artifact-streams.md) changes remote transfer, [idea 37](37-content-addressed-remote-upload-fixtures.md) caches upload content, and [idea 20](20-incremental-test-report-generation.md) changes report assembly. This targets local artifact copies at their existing API boundaries, without a content-addressed store or earlier reads.

## Proposed change

Introduce a small copy helper that requests filesystem cloning for eligible regular files, with ordinary-copy fallback. Start at completed local `saveAs` and path-based `testInfo.attach`, where the current implementation already requires an independent destination before returning. Keep naming, overwrite rules and directory creation unchanged.

Do not pre-hash files to decide whether they match: that reads every byte and is unnecessary for cloning one known source. Do not use hardlinks, which let later writes through one path change the other. Avoid cross-filesystem staging solely to obtain a clone; a new full copy can erase the benefit.

Retain the current capture time. An attachment copied when `attach()` runs must not instead refer to a mutable original until reporting. Conversely, a reporter that currently reads a file at run end must still read its then-current contents. Roll the helper out only to actual copy operations, not to arbitrary read/hash/compress paths.

After the first two sites prove useful, inspect subsequent physical copies in artifact publication. ZIP compression and remote transfer still read all bytes and are separate costs. The proposal does not eliminate those operations.

## Compatibility boundary

Preserve bytes, independent subsequent mutation/deletion, permissions, symlink behavior, overwrite errors and API completion. Test source/destination aliases and unsupported filesystems. Avoid a silent fallback that changes an existing permission or I/O failure into success; only unsupported clone behavior should select the ordinary copy.

Copy-on-write changes when physical space is allocated. Later writes can run out of space even though the clone originally succeeded. A speed-first clone policy therefore needs a documented ordinary-copy opt-out for users requiring eagerly allocated independent storage. Count delayed allocation costs when tests actually modify the copies.

Clones are not a new durability guarantee or an atomic snapshot promise for files being concurrently written. Preserve the supported stable-source contract and existing cancellation/cleanup. Do not advertise artifact corruption protection from this change.

## Payoff and later decision

For eligible multi-gigabyte artifacts, copying block references can replace a full data transfer and reduce duplicate disk usage. Small files, remote saves and non-cloning filesystems may see no benefit. If the existing Node/kernel path already clones the source, this candidate has no remaining opportunity there.

Later compare ordinary and requested-clone copies on supported and fallback filesystems, including source/destination mutation after return. Measure full `attach`/`saveAs` and run completion, physical allocated space, I/O and subsequent writes. Include multiple workers and disk-pressure/error cases.

Run attachment/download/video coverage, `tests/page` on `chromium-page` and `tests/playwright-test` against pristine upstream in `workbench/pw-src`. Report artifact-heavy rows beside the full [matrix](../bench/README.md), following the [shared rules](01-browser-native-actions.md#payoff-and-decision-test). No experiments now.
