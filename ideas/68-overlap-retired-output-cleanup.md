# Move old output out of the startup path before deleting it

Scope: repeated runs with large previous output trees, especially many small trace/resource files. Effort: medium to large. Priority: high only when output cleanup delays startup.

**Assessed 2026-10-31:** deferred. Measured: removing 72 files takes 2.4 ms, 1,000 files 11 ms, 10,000 files 59 ms. Moving the folder aside first would leave stray folders behind when a run is killed.

Research, 2026-10-31, against `2bc2768b` plus the live worktree. No directories renamed, deleted or benchmarked.

## Evidence and opportunity

The clear-output task in [`tasks.ts`](../packages/playwright/src/runner/tasks.ts) awaits recursive removal of each selected project's output directory. [`removeFolders`](../packages/utils/fileUtils.ts) uses `fs.promises.rm` with retries. Independent project directories are already processed concurrently; another Promise.all does not remove the per-tree startup barrier.

Large old artifact trees must be walked and unlinked before this task completes, even though tests only need their configured output path to be clean. [Idea 59](59-copy-on-write-local-artifacts.md) accelerates copies of retained files. This proposal changes when deletion of obsolete output happens.

## Proposed change

For an eligible runner-owned directory, rename the old tree to a unique private sibling on the same filesystem, establish the new empty output path, then continue startup. Delete the retired tree through a bounded cleanup queue while useful collection, fixture or browser work proceeds.

Keep deletion in the run's lifecycle: await every retired tree before successful final completion. Never report a speedup by leaving an unmeasured cleanup daemon after exit. Persist enough ownership information to recover an interrupted retirement on a later invocation without mistaking an active run's directory for abandoned output.

Normalize overlapping project output paths before retirement. Serialize ownership when concurrent invocations target the same directory, or retain the existing cleanup path for that situation. A failed rename must fall back before the original path changes. Mount roots, cross-device operations, symlinks and unsupported Windows handle behavior retain ordinary recursive cleanup.

Begin as an explicit cleanup policy for dedicated output directories. A rename is fast only when the filesystem supports the required operation; do not substitute copy-and-delete. Bound deletion concurrency so metadata I/O does not overwhelm source loading or current artifact writes.

## Compatibility boundary

Tests must see the same empty configured output path before their setup begins. Preserve `preserveOutputDir`, shared-project directory behavior and the existing busy-mount fallback. All later writers must use the new path, not a retained descriptor into the retired directory.

There is an observable difference: deletion errors can now surface after tests have begun instead of aborting setup, and filesystem observers can see the retired name. Document this policy and keep synchronous deletion as the opt-out. Unknown external references or cleanup requirements that demand removal before setup should use the existing path.

Cancellation must stop new work and settle cleanup or report its failure. Disk usage remains higher until retirement finishes; under space pressure, synchronous deletion may be necessary. Do not hide those resource costs.

## Payoff and later decision

If cleanup takes D and otherwise independent execution takes E, perfect overlap could change D + E toward max(D, E). That is a scheduling model, not a measurement. Total deletion work remains, and I/O contention can erase the benefit. Clean checkouts and tiny output trees gain nothing.

Later compare complete launch-to-exit time with large old trees, clean trees, slow storage and concurrent artifacts. Check cleanup errors, interruption, nested directories and absence of leaked retired trees. Use output-directory/runner tests and upstream page/runner suites against pristine upstream. Report this policy separately beside the full [matrix](../bench/README.md), with current-fork controls under the [shared rules](01-browser-native-actions.md#payoff-and-decision-test). Do not perform cleanup experiments on the busy machine.
