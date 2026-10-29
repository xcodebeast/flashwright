# Benchmarks

Complete `test` command runs, stock Playwright vs this checkout, alternating between them on the same machine.

## Setup

```bash
npm ci && npm run build                     # this checkout, the "fork" engine
mkdir -p workbench/pw-stock && cd workbench/pw-stock
npm init -y && npm i @playwright/test@1.64.1   # the "stock" engine
npx playwright install chromium
```

## Run

```bash
node bench/run.mjs todomvc 1 15 stock,fork   # one scenario: <scenario> <workers> <iterations> <engines>
node bench/matrix.mjs 15                     # every scenario with 1 and 4 workers
```

Scenarios: `todomvc` and `svgomg` (Playwright's example suites, in `apps/`), `shop` (a single-page app with a sign-in setup project and 40 ms API latency), `inventory` (an admin page of about 9,000 elements whose 19 tests find elements by role, label and text) and `workload:<name>` (15 tests that each exercise one thing; see `workloads/server.mjs`).

An engine can carry environment variables and options: `fork:USE_failFastWhenIdle=false` sets a test option, `fork:CONFIG_testOrder="file"` a config property, `fork:NAME=value` anything else (values cannot contain commas). `BENCH_ARGS` adds arguments to the test command, for example a single test file. `BASE_DIR=<checkout>` adds the engine `base`, the fork as built in another checkout, to compare two builds: `git worktree add workbench/fork-base <commit>`, copy `node_modules` into it, `npm run build` there, then `BASE_DIR=workbench/fork-base node bench/run.mjs todomvc 1 9 base,fork`. A summary line ends with `FAILED <n>/<runs> runs` when tests failed: such timings are not comparable.

The warm session is off unless an engine turns it on (`fork:FLASHWRIGHT_SESSION=1`): it keeps working after a run, which would slow down the next engine's run. `BENCH_PAUSE=<ms>` waits before each run, untimed, like an agent editing between runs. Measure the warm session with it, since its next runner gets ready after the previous run: `BENCH_PAUSE=1500 BENCH_ARGS=tests/adding-todos/should-add-single-todo.spec.ts node bench/run.mjs todomvc 1 15 stock,fork,fork:FLASHWRIGHT_SESSION=1`.

## Media

- `media/chart.mjs` draws `docs/media/benchmarks.svg` from the last matrix run.
- `media/race.mjs` renders the side-by-side video: record runs with `BENCH_TIMELINE=workbench/race-timeline node bench/run.mjs todomvc 1 7 stock,fork`, then `node bench/media/race.mjs`.

## Profiling

`STEPS=1` writes per-step timings next to the run (`step-reporter.cjs`, `worker-timeline.cjs`), `BENCH_CPU=1` and `BENCH_PROCCPU=1` report CPU time (`BENCH_PROCCPU=system` also counts a warm session's processes), and `trace.mjs`, `proto-timeline.py` and `cpuprofile.py` help read protocol traces and CPU profiles.

`BENCH_PROCCPU=threads` breaks CPU time down by thread. `BENCH_CHROME_TRACE=<dir>` records a Chromium trace of each worker's browser (`BENCH_CHROME_TRACE_CATEGORIES` picks the categories), and `python3 bench/chrome-trace.py <dir>` attributes its thread time to DevTools commands, mojo interfaces and posted tasks, or with `--self` to event names. Tracing slows Chromium down several times: compare shares, and take absolute CPU from `BENCH_PROCCPU=threads`. `EXTRA_ARGS` adds browser arguments, also per engine variant: `fork,fork:EXTRA_ARGS=--single-process`.
