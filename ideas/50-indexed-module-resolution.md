# Compile module-resolution rules and reuse verified lookup results

Scope: large TypeScript monorepos with many aliases, imports and worker processes. Effort: medium for rule compilation; large for shared lookup results. Priority: promising for import-heavy suites.

**Assessed 2026-10-31:** deferred. A relative import costs a few file-system probes (~10-30 µs), so typical suites spend milliseconds per process; only large monorepos would notice.

Research, 2026-10-31, against `c4c3583b` and the live worktree. No test modules imported or files scanned beyond targeted source reads.

## Where the work is

[`resolveHook`](../packages/playwright/src/transform/transform.ts) caches parsed tsconfigs, but still scans each config's path mappings and splits wildcard keys on resolution calls. Matching candidates reach [`resolveImportSpecifierAfterMapping`](../packages/playwright/src/util.ts), which probes extension alternatives, files, directories and package metadata with synchronous filesystem calls.

CommonJS and ESM have their own caches, so this is not necessarily paid on every import statement. The opportunity is the custom resolver's actual misses and first loads repeated across processes. [Idea 12](12-native-test-transformation.md) speeds up compilation after resolution; [idea 13](13-scalable-test-file-discovery.md) finds test files; [idea 41](41-declarative-test-collection-manifests.md) changes collection. None compiles this resolver.

## Proposed change

First compile each parsed tsconfig into exact-key and wildcard-prefix lookup structures. Store prefix, suffix, ordered target substitutions and original registration position once. Produce the same ordered candidate set as the current implementation, including its longest-successful-prefix and fallback behavior. Continue probing current filesystem state normally.

Do not silently change resolution while optimizing it. The [TypeScript module reference](https://www.typescriptlang.org/docs/handbook/modules/reference.html#paths) explains path substitution and package-resolution distinctions, but the current Flashwright implementation is the behavioral reference for this patch, including edge-case precedence.

For a larger second stage, share positive resolution results across collection and workers only within an explicitly immutable input tree. Key entries by importer location, specifier, config chain, module mode, runtime/conditions and resolver version. Include relevant package metadata, symlink topology and failed higher-priority candidates in validity. A previously absent `.ts` file appearing can invalidate a cached `.js` result even when the `.js` bytes are unchanged.

Use a build-provided immutable tree or an enforced filesystem snapshot for that tier. Plain mtimes or a watcher with possible gaps cannot certify lookup freshness. Mutable/generated trees keep live probes; they can still benefit from compiled alias rules. Delegate normal Node package resolution as before rather than replacing its entire algorithm.

## Compatibility boundary

Preserve extension order, exact versus wildcard matches, config inheritance, `allowJs`, base paths, directory imports, `main`/`exports` distinctions, case and symlink behavior, error timing and source maps. CJS and ESM must retain their respective module identity and evaluation order.

Do not cache module exports or execute imports speculatively. Dynamic file creation and custom loader hooks require the existing path unless explicitly covered by the immutable-input contract. Bound caches and discard them on configuration or snapshot changes; keep a resolver disable switch.

## Payoff and first decision

Rule compilation targets repeated work proportional to alias count. Verified shared results can remove duplicated metadata probes across many workers, particularly on slow filesystems. Warm small suites may gain nothing, and generating a filesystem snapshot can cost more than resolution itself.

First implement only compiled rules and compare every selected path with the current resolver, including overlapping mappings whose targets are missing. Later measure cold/warm imports with few/many aliases and one/four workers. Attribute custom resolution separately from Babel and module execution; do not claim their time as savings.

Run tsconfig, ESM, CJS, loader and source-map coverage in `tests/playwright-test`, plus `tests/page` on `chromium-page`, against pristine upstream in `workbench/pw-src`. Report the full [benchmark matrix and scenario command](../bench/README.md), an import-heavy corpus and current-fork comparisons under the [shared rules](01-browser-native-actions.md#payoff-and-decision-test). Count index/snapshot creation, cache transfer and memory. No execution now.
