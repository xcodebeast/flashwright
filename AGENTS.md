# Flashwright agent guide

Flashwright is a fork of Playwright that keeps its API and behavior and removes time from test runs. The goal: complete test suites at least 2× faster than stock Playwright, while existing Playwright projects run unmodified.

Build, lint and test commands are upstream's; see [CLAUDE.md](CLAUDE.md). Use the Node binaries in `.tools/` when the system Node is not 20–24.

## Rules

1. Keep upstream merges cheap. Change upstream files only where time is spent, keep each change small, and mark it with a `Flashwright:` comment that says why. New code goes in new files where possible. Pristine Playwright releases are imported on the `upstream/playwright` branch and merged into `main`.
2. Functionality comes first. A speedup that changes what a test observes needs an explicit, documented reason and an opt-out (see `FLASHWRIGHT_ISOLATION=strict`). List remaining differences in README.md.
3. Measure before and after with `node bench/run.mjs <scenario> <workers> <iterations> stock,fork` and `node bench/matrix.mjs`. Report the matrix, not single favorable runs.
4. Run upstream suites as the regression bar: `tests/page` on `chromium-page`, and `tests/playwright-test` for runner changes. Compare failures against pristine upstream (built in `workbench/pw-src`) on the same machine; flakes must show the same rate there.
5. Put scratch files, raw runs and checkouts in the ignored `workbench/` directory.
