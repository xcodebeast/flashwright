# Running tests with agents

[Back to the README](../README.md)

Short test runs matter when an agent checks its work after every edit. Flashwright reduces startup time and keeps passing-test output out of the way:

- **Re-running one test** takes about 75 ms instead of 673 ms, in the [warm session](#warm-session) that the first run starts; that first run takes 240 ms. `playwright cli` commands start in ~45 ms instead of ~260 ms.
- **Screenshots** take about half the time, and `toHaveScreenshot()` returns immediately when nothing changed.
- **Agent mode**: when Claude Code, Codex, Cursor, Gemini CLI, GitHub Copilot CLI or any tool that sets `AI_AGENT` runs `playwright test`, the output is the failures and nothing else, and the outcome is also written as JSON. See [agent mode](#agent-mode).
- **Failures say what the page has instead.** When an action or assertion waits for an element that never appears, the call log says which part of the locator stopped matching, whether a hidden element matches, and which elements are close, as locators to copy:
  ```
  - waiting for getByRole('button', { name: 'Logout' })
    - no element matched
      - similar buttons: getByRole('button', { name: 'Log out' })
  ```
  It covers role names, text, labels, placeholders, test ids, `nth()` and chains, and points at iframes when nothing is close.
- **`npx playwright doctor`** checks, without changing anything, what a run needs: Node, a single copy of Playwright, a config that loads, test files for each project, each project's browser and its system libraries, and a display for headed projects. It also says whether agent mode and the warm session are on. `--json` prints the checks for a script or an agent; it exits with 1 when something would stop a run.
- **The MCP server** can answer as soon as the page has settled instead of after a fixed 500 ms: `playwright mcp --adaptive-settle` (or `timeouts.adaptiveSettle: true`). A click that saves through an API returns in 234 ms instead of 1014 ms.

### Agent mode

When a coding agent runs the tests, an `agent` reporter replaces `list`, `line` and `dot`. It prints nothing for passing tests or their console output, prints each failure once (its last attempt, with the test's output), and ends with the counts and `npx playwright test --last-failed`. No colors, no rules of dashes, and the HTML report is never opened or served. 201 tests with one failure print 26 lines (888 bytes) instead of 425 (17.5 KB).

It also writes `test-results/summary.json`, with an `outcome` that tells apart failed tests (`failed`), errors outside tests such as a file that does not load (`error`), `no-tests`, `timedout` and `interrupted`; the counts; and for each failure its location, error, attachment paths and the command that reruns it. Exit codes stay the same.

`agentMode: true` or `false` in the config sets it, and `FLASHWRIGHT_AGENT_MODE=1` or `0` overrides both. A `--reporter` on the command line and file reporters (`html`, `json`, `junit`, `blob`) are kept. `reporter: 'agent'` works outside agent mode too, with `outputFile` to move the JSON.

### Watch mode

`npx playwright test --watch` runs, in the terminal, the tests of each test file you save and of the test files that import a file you save, with the command's filters. This is Playwright's terminal watch mode, exposed without its environment-variable switch. Press `h` for the other commands: run everything, run failures, repeat, change the project, file or title filter, or show the browser.

A saved file's tests report 255 ms after the save instead of 1065 ms (4.2×; one test that opens a page, medians of 9): the changed files run right away instead of after listing every test, and while you read the results the next run's worker starts with its browser, and so does the process that loads test files, with babel already loaded.

### Warm session

Outside CI, the first `playwright test` in a project starts a session in the background. The session keeps the next run's runner process and workers started, and it keeps the browsers: a worker that exits hands its browser to the session instead of closing it, with the context reset as between two tests and with the renderer that has already compiled the application. The next run's first test starts as warm as the second test of a run.

| Run, 1.5 s after the previous one | Playwright | Flashwright | Flashwright, warm session |
| --- | ---: | ---: | ---: |
| One TodoMVC test | 673 ms | 240 ms | 76 ms (8.9×) |
| TodoMVC suite, 1 worker | 3648 ms | 1023 ms | 900 ms (4.1×) |
| TodoMVC suite, 4 workers | 1804 ms | 728 ms | 508 ms (3.6×) |
| SVGOMG suite, 1 worker | 1725 ms | 510 ms | 377 ms (4.6×) |
| SVGOMG suite, 4 workers | 1257 ms | 476 ms | 278 ms (4.5×) |
| Shop app, 1 worker | 6321 ms | 2969 ms | 2839 ms (2.2×) |
| Shop app, 4 workers | 2593 ms | 1194 ms | 1003 ms (2.6×) |

<sub>Medians of 15 (one test) or 9 alternating runs with a 1.5 s pause before each, like an agent that edits between runs; the session prepares the next run during that pause. Reproduce with `BENCH_PAUSE=1500 node bench/run.mjs todomvc 4 9 stock,fork,fork:FLASHWRIGHT_SESSION=1`.</sub>

Every run still gets new runner and worker processes, so changed tests, configs and environment variables are picked up as usual. A run whose environment, terminal or Flashwright install differs from the session's runs on its own, like without the session. A run returns once its results are reported; its workers hand their browsers over afterwards, unless a worker fixture of the project still has to tear down.

- **When it is on:** by default, except when the `CI` environment variable is set, when a debugger is attached, with `PWDEBUG`, `--ui` or `--debug`, and on Windows. A CI job usually runs its tests once, so a session would only hold memory there. `FLASHWRIGHT_SESSION=0` turns it off and `FLASHWRIGHT_SESSION=1` turns it on in CI.
- **What it holds:** one session per project directory, until 5 minutes after its last run (`FLASHWRIGHT_SESSION_TIMEOUT=<seconds>` changes that) or until Flashwright is reinstalled. While it waits, it keeps a runner, a worker for each kept browser and the browsers: about 0.4 GB after one-test runs and 1 GB after a 4-worker suite. Headed browsers are closed, not kept.
