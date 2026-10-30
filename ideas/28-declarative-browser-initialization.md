# Install page configuration inside the browser before targets resume

**Scope:** frequent new pages, popups, frame-process changes and strict contexts. **Effort:** very large, requiring browser integration. **Priority:** broad architectural opportunity.

**Measured 2026-10-30:** on Chromium, creating and closing a test's page costs ~1.8 ms Node and ~2.5 ms browser CPU, so the ceiling is small. On Firefox a new page costs ~90 ms inside Firefox even in a warm context (TodoMVC on Firefox: 6.5 s, Chromium: 1.0 s); prelaunching content processes and process reuse did not change it, preparing the next test's context and page in the background gained 4% (Firefox's parent process is busy either way), and `reuseContext: true` (one page for all tests) runs 1.72× faster.

Research proposal, 2026-10-29. No experiments. [Browser-native actions](01-browser-native-actions.md) move click/fill state machines; this proposal removes repeated target-initialization work before those actions can start. It preserves fresh pages and all browser capabilities.

## Evidence

[`FrameSession._initialize`](../packages/playwright-core/src/server/chromium/crPage.ts) installs listeners and sends Page/Runtime/Log enablement, frame-tree retrieval, isolated-world setup, network setup, auto-attach and option-specific emulation commands. Init scripts add further commands. Most are **already concurrent** through a promises array; another Promise.all is not the opportunity.

It also buffers attached-target events until the frame tree is known and must configure auto-attach before resuming execution. [`CRBrowserContext.doCreateNewPage`](../packages/playwright-core/src/server/chromium/crBrowser.ts) creates a target, after which this machinery initializes it. Recycled contexts still create fresh pages.

## Design

Register a versioned immutable automation profile with the browser context. It describes supported initial emulation values, protocol instrumentation, utility-world setup and ordered init scripts. New targets inherit and install it through browser-owned hooks before their existing resume boundary. Return an initialization acknowledgement and the frame/session bootstrap data needed by Node, rather than requiring Node to repeat each static setting.

Separate immutable profile data from per-target IDs and runtime state. Install shared script source once per profile where engine support allows, but execute it afresh in every required world. No previous page heap, cookies, storage or JS globals are reused by this mechanism.

Prototype a small subset of emulation settings on ordinary new Chromium pages first. Keep other commands unchanged. Extend only after proving initial document, popup and out-of-process frame ordering; these are not identical cases. Existing attached pages, Electron/WebView, unsupported options and external CDP connections retain ordinary initialization.

## Compatibility and payoff

The [Target auto-attach protocol](https://chromedevtools.github.io/devtools-protocol/tot/Target/#method-setAutoAttach) supplies lifecycle primitives, not this complete profile feature. A browser extension must honor ordering across browser/renderer/network threads; a command that acknowledges before settings take effect is incorrect.

Preserve event replay, initial frame identity, utility-world availability, first navigation, script/binding ordering and the first application-observable emulation values. Context option changes create a new profile generation; pages and workers must receive the same updates they receive today. User CDP sessions must not see settings silently diverge. Profile references and secrets stay within their context and are released at disposal.

Negotiate support before target creation. If installation partially fails after a target has run, do not retry as though nothing happened. Keep a launch-time switch for ordinary CDP initialization and small `Flashwright:` hooks in upstream files; implement profile machinery in new files/browser patches.

## Later decision test

The target is fewer command parses, callbacks, repeated configuration work and host coordination—not eliminating all page-creation latency. Already-parallel commands limit latency savings; browser-local work still occurs. Measure newPage and full short-test boundaries, including profile registration and context teardown.

Later compare first-observed page values/events and run popup/frame/emulation/init-script coverage, `tests/page` on `chromium-page` and `tests/playwright-test` against pristine upstream in `workbench/pw-src`. Report strict/recycled and cold/warm cases with `node bench/run.mjs <scenario> <workers> <iterations> stock,fork`, the full `node bench/matrix.mjs` and a current-fork baseline under the [shared rules](01-browser-native-actions.md#payoff-and-decision-test). No browser builds now.
