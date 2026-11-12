# Running tests with agents

[Back to the README](../README.md)

Short test runs matter when an agent checks its work after every edit. Flashwright reduces startup time and keeps passing-test output out of the way:

- [Agent mode](#agent-mode) prints failures and a short summary instead of passing-test noise.
- [Structured summaries](#structured-test-summary) expose outcomes, errors, attachments and rerun commands as JSON.
- [Watch mode](#watch-mode) re-runs affected tests on save and prepares the next run in advance.
- [Warm sessions](#warm-session) keep browsers ready between commands; one measured TodoMVC test re-runs in 76 ms instead of 673 ms.
- [Locator diagnostics](#locator-diagnostics) suggest what the page actually contains when an element never appears.
- [Doctor](#check-the-project-setup) checks whether the project is ready to run without changing it.
- [Adaptive MCP settling](#adaptive-mcp-settling) returns when the page settles instead of after a fixed delay.

## Agent mode

When Claude Code, Codex, Cursor, Gemini CLI, GitHub Copilot CLI or a tool that sets `AI_AGENT` runs the tests, an `agent` reporter replaces `list`, `line` and `dot`. It prints nothing for passing tests or their console output, prints each failure once (its last attempt, with the test's output), and ends with the counts and `npx playwright test --last-failed`. No colors, no rules of dashes, and the HTML report is never opened or served. 201 tests with one failure print 26 lines (888 bytes) instead of 425 (17.5 KB).

`agentMode: true` or `false` in the config sets it, and `FLASHWRIGHT_AGENT_MODE=1` or `0` overrides both. A `--reporter` on the command line and file reporters (`html`, `json`, `junit`, `blob`) are kept. `reporter: 'agent'` works outside agent mode too, with `outputFile` to move the JSON.

### Structured test summary

It also writes `test-results/summary.json`, with an `outcome` that tells apart failed tests (`failed`), errors outside tests such as a file that does not load (`error`), `no-tests`, `timedout` and `interrupted`; the counts; and for each failure its location, error, attachment paths and the command that reruns it. Exit codes stay the same.

## Watch mode

`npx playwright test --watch` runs, in the terminal, the tests of each test file you save and of the test files that import a file you save, with the command's filters. This is Playwright's terminal watch mode, exposed without its environment-variable switch. Press `h` for the other commands: run everything, run failures, repeat, change the project, file or title filter, or show the browser.

A saved file's tests report 255 ms after the save instead of 1065 ms (4.2×; one test that opens a page, medians of 9): the changed files run right away instead of after listing every test, and while you read the results the next run's worker starts with its browser, and so does the process that loads test files, with babel already loaded.

## Warm session

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

## Locator diagnostics

When an action or assertion waits for an element that never appears, its call log says which part of the locator stopped matching, whether a hidden element matches, and which similar elements exist:

```text
- waiting for getByRole('button', { name: 'Logout' })
  - no element matched
    - similar buttons: getByRole('button', { name: 'Log out' })
```

Suggestions cover roles, text, labels, placeholders, test IDs, `nth()` and chained locators. If nothing is close, the log points at iframes. Finding these suggestions takes at most 500 ms after the call has failed.

## Check the project setup

```bash
npx playwright doctor
npx playwright doctor --json
```

Doctor checks what a run needs without changing anything: Node, a single Playwright installation, a config that loads, tests for each project, browser executables and system libraries, and a display for headed projects. It also reports whether agent mode and the warm session are on. It exits with code 1 when a check finds something that would stop a run.

## Adaptive MCP settling

```bash
playwright mcp --adaptive-settle
```

Set this flag, or `timeouts.adaptiveSettle: true`, to return once the page settles instead of waiting a fixed 500 ms. In the measured API-save example, a click returns in 234 ms instead of 1014 ms.
