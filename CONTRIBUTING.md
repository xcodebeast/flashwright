# Contributing

Flashwright is Playwright with less waiting. Contributions that make test runs faster without changing what tests observe are the most welcome, along with reports of anything that behaves differently from Playwright.

## Build and test

```bash
npm ci
npm run build                # or `npm run watch` while you work
npx playwright install chromium
npm run ctest -- tests/page  # Playwright's page tests on Chromium
npm run ttest -- <filter>    # test runner tests
npm run flint                # lint, types and docs, before you commit
```

[CLAUDE.md](CLAUDE.md) describes the codebase, which is Playwright's: packages, the client/server protocol, and where tests go.

## How Flashwright changes Playwright

- **Keep upstream merges cheap.** Change Playwright's files only where time is spent, keep each change small, and mark it with a `Flashwright:` comment that says why. Put new code in new files where you can.
- **Behavior first.** A speedup that changes what a test observes needs a documented reason and a way to opt out, and goes in the README's "Differences from Playwright".
- **Measure.** Compare before and after with `node bench/run.mjs <scenario> <workers> <iterations> stock,fork` and `node bench/matrix.mjs`; [bench/README.md](bench/README.md) explains the setup. Report medians, not single runs.
- **Playwright's suites are the regression bar.** Run them before and after; a test that fails with your change must fail the same way, at the same rate, with stock Playwright.

## Pull requests

- One change per pull request, with the numbers that justify it.
- Semantic commit messages: `perf(test): …`, `fix(server): …`, `docs(readme): …`.
- Bugs that also happen with stock Playwright belong [upstream](https://github.com/microsoft/playwright/issues).

By contributing, you agree that your contributions are licensed under the Apache License 2.0, like the rest of the project.
