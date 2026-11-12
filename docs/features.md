# Quality-of-life features

[Back to the README](../README.md) · [Performance optimisations](performance.md)

Each item links to the instructions, examples and limitations for that feature.

- **[Turn tests into narrated videos](videos.md#record-a-test-run).** `--video` produces a video with test titles, action captions, results, a moving cursor and a camera that follows the action. Each test also gets a clip.
- **[Make demos from the same tests](videos.md#make-a-demo).** `--demo` keeps the page and narration without test names or results. Failed tests are omitted.
- **[Write your own narration](videos.md#write-narration).** Add `narrate()` calls to explain the flow. They do nothing during normal runs, and tests without them still get automatic action captions.
- **[Use a local or custom voice](videos.md#choose-a-voice).** Use your system's voice, install Kokoro, or supply a voice function. Generated speech is cached between runs.
- **[Get useful locator failures](agents.md#locator-diagnostics).** See which part of a locator stopped matching, whether a hidden element matches, and similar elements as locators to copy.
- **[Check the setup with doctor](agents.md#check-the-project-setup).** Check Node, duplicate installations, configs, test discovery, browsers, libraries and display availability. `--json` exposes the checks to scripts.
- **[Keep agent output small](agents.md#agent-mode).** Automatically detect supported coding agents, suppress passing-test noise and print each failure once with a rerun command.
- **[Read a structured test summary](agents.md#structured-test-summary).** Get outcomes, counts, failure locations, errors, attachment paths and rerun commands in `test-results/summary.json`.
- **[Run affected tests when you save](agents.md#watch-mode).** Use `--watch` directly in the terminal, including tests affected by changes to imports, and change filters or rerun failures interactively.
- **[Give each project its own server](configuration.md#a-web-server-per-project).** Start only the servers needed by the selected projects and stop them when the run finishes.
- **[Set options on individual tests](configuration.md#options-for-one-test).** Put `use` directly on a test or `describe` block instead of adding a group for one test's options.
- **[Remove stale snapshots](configuration.md#prune-stale-snapshots).** Prune unused files after a complete passing run, with safeguards for skipped tests, filters and other platforms.
- **[Accept snapshots without another run](configuration.md#accept-snapshots-without-a-rerun).** Update baselines from the last run's actual files, including results copied from CI.
- **[See discouraged APIs in your editor](migration.md#deprecated-apis).** Deprecated type annotations flag legacy methods while keeping them working.
- **[Migrate old calls with a codemod](migration.md#migrate-selector-based-calls).** Preview selector-to-locator changes, apply them with `--write`, and list cases requiring manual changes. `--keep-first` preserves first-match behaviour.
- **[Run TypeScript on Bun](migration.md#run-on-bun).** Run TypeScript configs and tests with `bunx --bun playwright test`.
- **[Handle test APIs without CORS headers](configuration.md#web-security).** Disable Chromium's same-origin enforcement and mixed-content blocking for that test environment with `webSecurity: false`.
