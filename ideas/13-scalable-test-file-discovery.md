# Stop rescanning irrelevant directory trees for every run

**Scope:** large monorepos, many projects and frequent single-test reruns. **Effort:** medium for pruning; large for a trustworthy persistent index.

Research proposal, 2026-10-29. No measurements. This optimizes filesystem discovery only; it does not skip test-module execution or reuse its side effects.

## Evidence and opportunity

[`collectFilesForProject`](../packages/playwright/src/runner/projectUtils.ts) gathers files under `testDir`, then filters by extension, `testMatch` and `testIgnore`. The recursive walker awaits each child-directory visit and sorts each directory. It already skips `node_modules`, implements gitignore rules and caches repeated `(testDir, respectGitIgnore)` scans within one collection.

[`collectProjectsAndTestFiles`](../packages/playwright/src/runner/loadUtils.ts) creates that cache afresh, and applies command-line file filters after project collection. A warm browser therefore does not imply cheap discovery in a large checkout. Thousands of non-test directories can contribute latency before the selected test even loads.

## Design

First compile safe path constraints from `testMatch`/`testIgnore` into a traversal plan. Skip a subtree only when no descendant can match under the exact matcher semantics. Broad patterns, regular expressions, gitignore negation and ambiguous constraints retain full traversal. Preserve shared scans across projects; a union of required subtrees can avoid scanning overlapping roots twice.

Use a small bounded queue for independent directory reads, then assemble the same sorted traversal order. Do not parallelize user test imports: top-level code can depend on module evaluation order. Include dependency projects and source-map-based file matching in the plan; a CLI filename substring is not automatically a safe filesystem prefix.

For repeated runs, explore a persistent directory inventory attached to the existing session. It stores names/types and ignore-rule results, not Suite objects, config results or module globals. Fresh config still determines which files qualify.

The persistent tier requires a reliable change boundary: a supported journal/barrier or an explicit immutable checkout manifest. A plain watcher cannot prove freshness. [Node documents missed/replacement and network-filesystem limitations](https://nodejs.org/docs/latest-v22.x/api/fs.html#caveats). On overflow, watcher gaps, directory replacement, uncertain mounts or session restart, rescan affected roots. If an implementation cannot establish a safe boundary, ship only pruning and bounded traversal; never silently omit new tests.

## Compatibility boundary

Return exactly the same ordered file list, errors and dependency-project inclusion as current discovery. Preserve hidden-file, symlink, case, extension, ignore and inaccessible-directory behavior. Do not replace discovery with `git ls-files`: untracked/generated tests are valid inputs. A stale inventory must not cause a green run that never discovered a failing test.

Index maintenance has CPU, descriptor and memory costs. Reuse existing watch infrastructure where sound, enforce budgets, and avoid polling every file continuously. A disable switch must restore full scanning.

## Payoff and later validation

The target is reducing directory visits from repository scale to relevant subtrees, and repeated work to verified changes. Small repositories may gain nothing. First instrument visited-directory counts in a future prototype and compare exact manifests with the reference walker over adversarial patterns and concurrent edits.

Later measure cold/warm discovery and full CLI duration in large/deep trees, overlapping projects and single-test selections. Count background inventory work. Run `tests/playwright-test` discovery, filtering, sharding, project-dependency and watch coverage, plus `tests/page` on `chromium-page`; compare failures against pristine upstream in `workbench/pw-src`. Run `node bench/run.mjs todomvc 1 15 stock,fork` and the full `node bench/matrix.mjs 15`, adding a monorepo scenario and current-fork comparison under the [shared rules](01-browser-native-actions.md#payoff-and-decision-test).
