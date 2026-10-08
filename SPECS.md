# Flashwright implementation specification

## S1 Purpose, authority and reading path

Flashwright is the project name; Playwright is the compatibility reference. Package names below are proposed release names, not a claim that those names are available or published

Build a Rust browser-testing engine and a first-class TypeScript library that can replace Playwright in existing TypeScript projects with minimal migration. Optimize action/assertion latency and suite throughput while preserving the compatibility contract in S4

Current state: the experimental TypeScript library launches the pinned Chromium through a persistent Rust driver, owns contexts/pages, evaluates values and navigates real HTTP pages with network and lifecycle events. Basic cookies and exact UTF-16 localStorage state now round-trip through objects/files and native runner fixtures; private origin pages preserve isolation, with the documented service-worker collection difference in S4.j. The isolated resident selector runtime now supports a tested slice of locator reads, waits, same-process child-frame queries, native text fill, selection, focus and native pointer actions with fresh frame stability, hit interception and navigation barriers. Undelayed pointer input now queues native events in order without reply barriers, and multiple pages retain the reference focus/visibility defaults. Native locator and page keyboard presses now cover the pinned key layout, platform editing shortcuts and cancellation cleanup. Retrying DOM assertions and an experimental native test-runner fixture/matcher adapter are available, with shared ESM/CommonJS runtime identities and packed consumer checks. The three preserved TodoMVC migration tests pass through packed packages with import/config changes only. Browser/process failure tests and shared navigation/locator/pointer/keyboard/assertion differential fixtures are available. Opt-in resident assertions now pass host cancellation and lifecycle checks and improve delayed assertion latency in matched engineering profiles; complete-flow material benefit remains unproven. The complete runner adapter, broader navigation/frame/value conformance, artifacts and release performance gates remain unfinished. For verified progress and remaining gates, read [compatibility/milestones.json](compatibility/milestones.json); reference identities and retained evidence are in [compatibility/reference-manifest.json](compatibility/reference-manifest.json). The exploratory prototypes and their raw measurements have been removed; requirements below remain delivery contracts rather than claims of shipped coverage

a. For implementation planning, read S2–S6, select the first incomplete milestone in S5, then load the sections named in that milestone
b. For TypeScript migration or runner integration, load S7–S9 and S18
c. For engine operations, load S10 and the applicable semantic section S11–S14
d. For optimization, load S6 plus S12, S16 or S17 as applicable; a faster result doesn't override S4
e. For publication, apply S18 and the release gates in S19
f. If a proposed change alters this contract, record the decision and update the affected section before implementation. This file is the source of truth for main-build requirements; it has no dependency on retired research files

Chromium on Linux and macOS is the initial delivery scope. “Any TypeScript project” is the migration ambition, not a claim that a Chromium-only first release covers Firefox, WebKit, every plugin or every private Playwright API

## S2 Selected decisions and rationale

Earlier exploration informed these choices, but its removed artifacts aren't reproducible evidence for the main build. Establish new baselines in M0 using S6; don't quote retired pilot numbers as verified product performance

| Decision | Reason | Implementation and validation |
| --- | --- | --- |
| Keep CDP as the initial coarse browser channel | Transport is one part of a pipeline that also includes readiness, input, rendering and application waiting | S10 and S13; attribute costs before replacing transport |
| Execute supported conditions beside the DOM | Subscriptions can reduce repeated coordination and delay after a condition changes | S12; retain full predicates, fallback detection and independent host deadlines |
| Offer explicit submitted sequences | Rust-owned loops reduce adapter traffic; renderer-owned loops can additionally reduce browser coordination | S16; compare both against ordinary calls, including preparation and real application work |
| Harden existing binary CDP for payloads | Chromium already has a binary pipe; Unicode conversion and base64 artifacts can make encoding material | S10; prove value/framing coverage and measure both small commands and large payloads |
| Preserve ordinary scheduling and fresh stability | Frame uncapping changes workload and scheduling; past geometry alone can't account for already-queued movement | S13; use fresh observation and current targeting by default |
| Separate controlled time from compatibility mode | Accelerating logical time can change frames, CSS animations and races with external clocks | S16; require explicit activation and a declared coverage contract |
| Make custom Chromium conditional | A coarse native operation may remove orchestration, but adds browser-build and maintenance cost | S13; require a compiled equivalent action and complete-flow evidence |

Application waiting bounds ordinary real-time execution. Removing coordination overhead helps only the portion of the critical path it occupies. Browser residency alone isn't a novelty claim, and neither a new encoding nor a Rust rewrite proves faster complete suites

## S3 Components and ownership

The default execution path is TypeScript facade → persistent Rust driver → Chromium, with a resident runtime in each participating document. Python and Playwright's browser driver aren't in this browser-command path

| Component | Owns | Doesn't own |
| --- | --- | --- |
| flashwright TypeScript package | Public browser objects, argument validation, callbacks, Promise/event delivery, engine startup and shutdown | Browser automation through a second Playwright backend |
| @flashwright/test package | Runner adapter, browser fixtures, Flashwright-aware assertions, config validation and artifact integration | A new scheduler in the first release |
| Rust engine | Browser/context/page/frame registry, semantic operations, deadlines, cancellation, protocol dispatch, cleanup and error records | Execution of arbitrary Node callbacks |
| Resident runtime | Lazy locator resolution, predicate checks, dependency subscriptions and bounded local execution | Final authority over host deadlines or process survival |
| Chromium backend | Real browser storage/rendering/network/input, document and target events | Reduced simulation of Chromium |
| External supervisor | Termination of stuck jobs and owned child-process cleanup | Replacing an explicitly unbounded public API timeout with an undisclosed timeout |

a. Run one persistent Rust driver per test worker by default, amortizing startup, and close it during worker teardown. Plain library calls start a driver lazily; closing the last owned browser releases its implicit driver and lets Node exit. An explicitly retained engine client has its own documented close/disposal contract
b. Use a Rust executable over bounded asynchronous IPC for the first TypeScript binding. A Node native addon is a later measured alternative, not an initial dependency
c. Use stock Chromium first. JSON pipe CDP is the complete baseline; select CBOR for a browser connection only after codec conformance and capability negotiation in S10. A connection has one negotiated encoding
d. Keep browser-engine operations behind a capability interface. An interface doesn't imply working Firefox/WebKit backends
e. Expose explicit extension APIs separately from Playwright-compatible methods. Ordinary calls don't silently compile or fuse user test code
f. Keep runner integration and engine independent: flashwright must work from a plain Node script, Vitest/Jest or another host without importing the test runner

## S4 Compatibility and unsupported behavior

The default target is documented Playwright behavior with faster condition detection. Initial compatibility reference: Playwright 1.60.0. Publish a tested version range only after S19; current online docs can contain newer APIs and don't silently expand that range

Decision order for every operation:

1. Validate its capability, arguments, ownership and options using S9. If unsupported, fail before starting that operation's browser effects
2. Apply the public method's contract, including its locator, timeout, event and completion rules
3. Choose a proven optimized implementation that satisfies that contract
4. If the optimized implementation doesn't cover the case, use a declared compatible implementation in the same engine
5. If neither implementation covers it, return UnsupportedFeatureError. Don't fall back silently to Playwright, synthetic input, a mock backend or another browser

a. Preserve supported return values, Promise rejection behavior, object identity, event ordering, strictness, matching rules, host callbacks, isolation, action completion and useful diagnostics
b. Faster checks may observe brief valid states that slower sampling misses. Record this difference in conformance cases; don't promise identical sampling traces or detection of every transient state
c. Preserve per-call timeout defaults and overrides. A segment budget isn't a replacement for ordinary per-step timeouts; apply S10 and S16
d. Unknown browser/method options aren't ignored. Custom runner fixture options are forwarded according to S8; they aren't mistaken for browser options
e. Unsupported means a specific typed capability failure, not a generic TypeError or a fabricated empty result. Include the method/option, value class, browser, reference version and documented alternative where one exists
f. Preserve user-requested semantics such as force, trial, dispatchEvent or clock control only when implemented. Their explicitly changed behavior isn't an ordinary-mode architecture speedup
g. Exact internal retry cadence, private channel objects, internal class brands and identical error-message whitespace aren't compatibility promises. Public error classes, meaningful messages, call sites and reporter integration remain required
h. Browser binaries, supported platforms and artifact capabilities are part of compatibility. Refuse an unavailable engine/platform or artifact policy explicitly
i. Browser-profile checks happen at configuration/launch time where possible. A Firefox/WebKit project or device configuration doesn't silently become Chromium
j. Basic storage snapshots collect existing cookie/localStorage state without executing application code in internal pages. Temporary origin pages bypass service-worker fetch interception. A pinned 1.60.0 differential found that its fallback page can execute a worker-supplied document and mutate the state being collected after all public pages close; Flashwright deliberately does not reproduce that side effect. Retain this behavioral difference in conformance evidence and release notes; it is not a performance equivalence claim

For assertions, consult [published retry semantics](https://playwright.dev/docs/test-assertions) when resolving a sampling question. For action checks, consult [actionability](https://playwright.dev/docs/actionability) and then apply S13. For a timeout question, consult [timeout categories](https://playwright.dev/docs/test-timeouts) and apply S10

## S5 Implementation milestones and finish lines

Each milestone produces working code, conformance evidence, raw benchmark data where relevant and an updated capability inventory. Documentation or compilation alone doesn't complete a browser milestone. Don't begin an optimization that depends on an unfinished semantic gate

| Milestone | Work and prerequisite | Finish line |
| --- | --- | --- |
| M0 Baselines and compatibility inventory | Apply S6 and S9 on Linux CI and macOS; pin the reference packages/browser; select representative TypeScript projects; verify runner integration feasibility using S8 | Reproducible matched harness, complete public member/option inventory, migration corpus, explicit platform/version matrix, and recorded performance/regression thresholds. Missing Linux execution keeps the Linux gate open |
| M1 Rust core and TypeScript library skeleton | Build S3, S7, S10 and S18; retain provenance for reused upstream code | Plain TypeScript and CommonJS scripts launch Chromium, create isolated contexts/pages, evaluate supported values and close cleanly. Malformed framing, blocked writes/renderer, cancellation, process exit and worker termination pass under an external watchdog. Package smoke tests use packed artifacts |
| M2 Ordinary operations and early test-runner integration | Implement the initial slice in S9 using S11–S14; integrate S8 and basic S15 artifacts | Existing supported Chromium tests run with import/config changes only, including page objects and extended fixtures. Their type checks, assertions, trusted input, navigation, strictness, timeout and cleanup cases pass. No Playwright browser-command fallback. This is a labelled preview, not full parity |
| M3 Shared dependency tracking and payload refinement | M2 semantics pass; implement S12 registry and complete S10 CBOR boundary | Mutation/property/style/shadow/frame invalidation passes adversarial cases; cache and transport off/on comparisons retain equivalent work and include preparation. Keep either optimization disabled where correctness or net benefit isn't established |
| M4 Practical TypeScript replacement coverage | Expand S8–S9, S14–S15 and S18 over the M0 corpus | Migrated corpus compiles/runs without changed test logic; supported config, callbacks, authentication, networking, request fixtures, reporters and requested artifacts conform. Publish exact remaining unsupported entries and zero-import alias verification results |
| M5 Optional execution and throughput | M4 baseline is stable; implement selected S16–S17 paths according to S6 attribution | Explicit sequence modes pass their budget/yield/barrier contract; throughput tuning proves isolation and includes unused preparation costs. Controlled time ships only for its independently validated coverage |
| M6 Release and conditional native action | Apply S19. A custom browser branch additionally needs the native gate in S13 | Release packages and supported-platform binaries pass consumer installation, compatibility and resource gates. Native work, if selected, has a compiled equivalent action and matched evidence before adoption |

M0 harness work and M1 setup may overlap, but a release's baseline and compatibility gates must finish before its performance claim. M5 extensions aren't prerequisites for releasing a well-labelled compatible subset; incomplete extensions stay unsupported

Engineering profiling may run before the full M2 surface is complete when the measured methods and their applicable behavior/lifecycle checks already pass. Apply S6 to browser policy, complete work and retained observations, and identify open compatibility, attribution and platform gates. This can guide implementation priorities; it does not complete M2 or permit an optimization to bypass a semantic gate it depends on

A disabled S12 assertion-residency experiment may overlap the remaining M2 APIs once the existing assertion, selector, document-transition and lifecycle fixtures pass on the recorded development platforms. First prove the shared registry in an isolated Chromium realm, then preserve host deadlines, cancellation and diagnostics during engine integration, and run the applicable differential and S6 comparisons before enabling it. This dependency decision follows the retained protocol attribution in [compatibility/evidence/cleanup-attribution-checkpoint-2026-10-07.json](compatibility/evidence/cleanup-attribution-checkpoint-2026-10-07.json); it does not complete M2 or M3

## S6 Benchmark rules and claim acceptance

Use these rules for every claimed improvement, including adapter overhead, transport, subscriptions, native endpoints, artifacts, startup and suite scheduling

a. Match well-configured Playwright TypeScript/JavaScript on the same Chromium binary, revision, flags, fixture, backend, context isolation, viewport, artifact policy and resource budget. Python is a secondary attribution comparator, never the only baseline for a TypeScript replacement
b. Record OS/architecture, CPU/memory, display/headless mode, exact packages/toolchains, browser flags, source and executable hashes, worker counts and configuration. Distinguish reference-browser comparison from a custom-browser cross-build comparison
c. Rotate execution order across independent launches, warm deliberately and retain every valid sample. Record failures and the declared exclusion policy; don't rerun only unfavorable timings
d. Separate no-op latency, warm action/assertion latency, detection lag, cold launch, context/application preparation, real application waiting and suite wall time. Report complete preparation-inclusive observations alongside warmed paths
e. Include interaction-heavy, assertion-heavy, navigation-heavy, setup-heavy, backend-heavy and failure-heavy workloads. M0 must contain an application with real network/backend work as well as deterministic microbenchmarks
f. Retain sample counts, distributions, medians and observed tails. With too few observations for a tail estimate, report observed maxima instead. M0 sets sampling policy, confidence method and material-regression thresholds before final comparisons; analyze independent-launch variation
g. Count operations/evaluations, trusted input, protocol and adapter crossings, payload bytes, discovery visits, artifact output and backend requests where relevant. Different legitimate schedules can change reevaluation counts; disclose them rather than forcing artificial equality
h. Measure CPU and memory with explicit process-tree coverage. Per-worker maximum RSS isn't summed concurrent browser memory; reconstructed protocol bytes aren't raw wire captures
i. Require applicable behavior and lifecycle gates before reporting an equivalent-operation speedup. A fast failing test, skipped predicate, dropped trace or missed callback isn't a win
j. Compare latency at matched concurrency and suite throughput at matched resource limits. Sweep contention; don't attribute additional hardware or workers to the engine
k. Keep controlled time, replay/mocking, selected-test execution, altered stability, skipped animations and reduced artifacts in separate result classes. Apply S4.f
l. Store implementation benchmark workloads and configurations under benchmarks/ with executable harnesses and verifiers. Preserve immutable result snapshots, raw data, hashes and run metadata under benchmarks/results/. Record source hashes and licenses for reused code
m. Publish a speed claim only with a metric, workload, baseline, machine, retained result file and limitations. “Fastest” requires a declared competitor set and reproducible results; an isolated benchmark doesn't prove superiority over every alternative

M0 records numeric acceptance thresholds in versioned benchmark configuration, with rationale. Until then this spec defines an optimization objective, not an invented speed guarantee

## S7 TypeScript packages, types and migration

Proposed public packages:

| Package | Required exports or behavior |
| --- | --- |
| flashwright | chromium, explicitly unsupported firefox/webkit BrowserType facades until implemented, devices, errors, browser/page/locator/frame/network types, and a request facade whose unimplemented methods reject explicitly |
| @flashwright/test | test, expect, defineConfig, devices, runner/config/fixture types, the reporter subpath, errors and the flashwright CLI |
| flashwright/test | Optional entry point forwarding to @flashwright/test for consumers of playwright/test; importing the ordinary library doesn't load the runner |
| flashwright/experimental | Explicit sequence and controlled-time extensions from S16; no automatic activation |
| Platform runtime packages | Rust executable and its integrity/version manifest for each supported OS/architecture; selected by S18 |

a. Produce ESM and CommonJS exports with declarations and source maps. Test Node module resolution, NodeNext and the supported bundler resolution mode; consumers don't need Rust or a TypeScript build of our sources
b. Select exact Node/TypeScript/package-manager test versions in M0. Initial Node support target is 22 and 24, subject to verification before publication; declare tested engines and module modes, not “all TS environments”
c. Preserve documented names, overloads, generic inference and callback types for the reference API. Derive or copy public declaration shapes with upstream notices and provenance; engine implementation types stay separate
d. Keep synchronous locator construction and normal Promise-based operations. Preserve Page/Context/Browser object identity and event-listener behavior; don't return raw protocol objects
e. Separate source/type compatibility from runtime coverage. A facade may expose a declared method that rejects as unsupported; S9 must list it. Never use any casts or universal Proxy stubs to conceal incomplete implementation
f. Use explicit imports as the preferred migration. Change imports in tests, fixtures, page objects and configuration, and change the test command. Test bodies and fixture logic remain intact within the supported surface
g. Offer zero-import migration through verified package-manager aliases or supported resolver integrations. A tsconfig paths mapping alone isn't runtime module replacement. S18 installation tests must exercise both runtime and declarations
h. Do not promise interoperability with unmodified plugins that inspect Playwright internals or require actual Playwright class identity. Preflight-known incompatibilities use S4.e; list tested public-API integrations
i. Inventory public package subpaths as well as object members. Alias-mode tests include playwright/test and @playwright/test/reporter. A playwright-core alias is claimed only after its own exported surface passes; private deep imports aren't covered

The examples below define intended released behavior and aren't runnable until the library milestones pass

Library migration:

```ts
import { chromium } from 'flashwright';

const browser = await chromium.launch();
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('http://localhost:3000');
  await page.getByLabel('Email').fill('jhon@example.com');
  await page.getByRole('button', { name: 'Continue' }).click();
} finally {
  await browser.close();
}
```

Test migration:

```ts
import { test, expect } from '@flashwright/test';

test('saves a profile', async ({ page }) => {
  await page.goto('/profile');
  await page.getByLabel('Name').fill('Jhon');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('status')).toHaveText('Saved');
});
```

Configuration migration keeps the existing file name if desired:

```ts
import { defineConfig } from '@flashwright/test';

export default defineConfig({
  testDir: './tests',
  use: { baseURL: 'http://localhost:3000' },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
```

The primary command is flashwright test --config=playwright.config.ts. In alias mode, verify the consumer's package manager can resolve playwright → flashwright and @playwright/test → @flashwright/test together. An optional legacy CLI shim must be tested for bin conflicts; it isn't assumed to work merely because import aliases work

Migration acceptance: a packaged consumer project type-checks, runs and preserves its test/fixture body using the preferred import path; zero-import claims require the separate alias suite

## S8 Playwright Test runner integration

Reuse the pinned Playwright Test scheduler and fixture lifecycle through a dedicated versioned runner adapter. This avoids building retries, sharding and reporting before delivering the new browser engine. It is a product dependency with licensing and maintenance cost, not evidence of engine compatibility

a. Isolate the upstream runtime under an internal dependency identity. Resolve it from our dependency tree, not the consumer's @playwright/test import, which may alias back to us. Verify no recursive imports, duplicate runner instances or accidental upstream browser launch in S18
b. Prefer documented fixture/expect extension points. Keep unavoidable private integrations inside the versioned adapter, with source provenance and tests; no private runner assumptions leak into engine contracts
c. Flashwright supplies browser, context, page and supported request fixtures, their teardown, and artifact hooks. Worker fixture configuration must key browser reuse correctly; each ordinary test/retry gets a fresh context
d. Generic value matchers may reuse the pinned assertion infrastructure. Browser/locator/Page matchers dispatch to Flashwright operations and retain negation, configured timeouts, soft failures and runner step reporting when claimed
e. Re-exporting upstream expect unchanged is insufficient: its browser matchers and fixture/artifact plumbing may require private methods. M0 proves the integration boundary; M2 completes the declared slice before release
f. Preserve test.extend generics, fixture dependency ordering/scopes, hooks, test.use, describe/parallel/serial behavior, retries, projects, worker identity, testInfo and attachments for claimed entries in S9
g. Forward supported runner configuration and custom fixture options to the runner. Validate native browser/context/engine options at their own boundary. Reject unsupported built-in project settings before starting tests where statically discoverable
h. Integrate runner timeout/cancellation with S10; a timed-out fixture or test can't leave resident subscriptions, routes or contexts alive. Teardown failures remain distinguishable from the original test failure
i. Keep runner reporters and attachments meaningful. Trace/video configuration is governed by S15; the adapter doesn't leave upstream artifact hooks operating on counterfeit Playwright objects
j. The CLI forwards supported test selection, projects, workers, retries, sharding, reporters and config loading to the runner adapter. Unknown flags fail with guidance; UI/codegen/debugger commands remain separate capabilities
k. Don't implement a replacement scheduler as a workaround for one private integration. If the versioned adapter can't meet a required public contract, isolate the root cause, record an architecture change and update S5/S8 before changing the delivery model

For fixture ownership questions, load [fixture extension and override documentation](https://playwright.dev/docs/test-fixtures). For integration changes, inspect the pinned [runner fixtures](https://github.com/microsoft/playwright/blob/v1.60.0/packages/playwright/src/index.ts) and [assertion wrapper](https://github.com/microsoft/playwright/blob/v1.60.0/packages/playwright/src/matchers/expect.ts). For config forwarding, load [configuration](https://playwright.dev/docs/test-configuration)

Finish line: extended user fixtures, ordinary and soft assertions, test timeouts, retries, reporters and worker teardown pass against a packed adapter without upstream browser-driver execution. Private touchpoints and their tested reference version are recorded

## S9 Public capability inventory and delivery slices

Create a machine-readable inventory from the pinned public declarations/docs in M0. Every public package subpath, export, member, overload, event, relevant option and default has an entry with its compatibility reference, backend, status, milestone, implementation path and conformance evidence

Statuses are planned, supported, experimental and unsupported. “Supported” requires executable conformance and package tests. These product capabilities are currently planned; an implementation sketch doesn't make a full public API supported

| Surface | M2 preview minimum | M4 expansion requirement |
| --- | --- | --- |
| Browser/context/page | launch, newContext, newPage, close, pages, viewport, baseURL, basic cookies/storage state | Persistent contexts, configuration combinations, permissions/emulation, supported connection modes and context events |
| Locators/frames | CSS, test ID, text, label and role with their implemented options; chaining/filtering/nth; main and child-frame ownership | Full declared matching/composition options, open-shadow semantics and cross-process frame behavior |
| Actions | goto, click, fill, press, check/uncheck, selectOption, focus and supported hover | Mouse/keyboard/touch sequences, files, dragging, additional action options and locator convenience methods |
| Assertions | toHaveText, toContainText, toBeVisible/Hidden, toBeEnabled/Disabled, toBeChecked, toHaveCount, toHaveValue, toHaveURL and toHaveTitle, with supported negation/options and soft/configured expectations | Remaining claimed locator/page matchers, polling/retrying host expectations, custom matchers and screenshot comparison |
| Evaluation/events | evaluate, supported handle lifecycle/serialization, console/pageerror, close, basic waitForEvent and waitForURL | Exposed callbacks, init scripts, full claimed handle value classes, popups/dialogs/downloads and event options |
| Network/API | Request/Response observation and waitForResponse for the preview fixture; explicit route/request gaps | Routing and fulfill/continue/abort, host callbacks, APIRequestContext/request fixture, redirects, headers/cookies/authentication and supported WebSocket/service-worker behavior |
| Runner/config | Basic test, expect, defineConfig, page/context/browser fixtures, extended fixtures, hooks, test.use, retries, basic projects/reporters and supported timeouts | Corpus-used worker fixtures, project dependencies, parallel/serial modes, annotations, attachments, sharding, global setup/teardown and webServer |
| Artifacts | Browser screenshots and basic structured failures; trace/video rejected until implemented | Claimed screenshot options/comparison, configured screenshot/trace/video policies, reporter attachments and playback/viewer contracts |
| Additional backends/tools | Chromium only; other exports reject explicitly | Remain unsupported unless separately implemented and verified |

This table is a required slice, not a complete API list. The inventory is authoritative for individual options; for example, implementing click doesn't establish force/trial/modifier/position parity

a. A capability becomes supported only when its argument/default/return/error/event behavior and relevant lifecycle cases pass
b. A valid but unimplemented option produces UnsupportedFeatureError; malformed input produces InvalidArgumentError. Don't mislabel a missing implementation as invalid user input
c. The driver publishes capabilities during handshake; the TypeScript facade and runner compare them against their required contract. A mismatched package/driver can't run optimistically
d. Expose a flashwright doctor/preflight command that reports package/runtime/browser versions, config incompatibilities and detectable unsupported usage. Static inspection is advisory for dynamic test code; runtime enforcement remains mandatory
e. Mark browser-specific defaults in the inventory. Unknown flags and browser versions require capability validation or explicit user opt-in, not automatic support
f. Add migration fixtures for third-party page objects/helpers that use documented methods. Private-brand plugins follow S7.h

Finish line: inventory generation flags uncovered public members/options; release notes derive supported and unsupported tables from the same inventory used in validation and tests

## S10 Transport, operation state and process lifecycle

Use two separate protocols: TypeScript↔Rust application IPC and Rust↔Chromium CDP. Do not implement Playwright's private driver protocol as a prerequisite for TypeScript migration

a. Application IPC uses versioned length-prefixed messages, typed payloads and explicit binary/chunk attachments. Protocol 5 retains JSON control frames and adds request-scoped attachment streams: a start envelope declares encoding and encoded/decoded lengths, bounded data frames carry a zero marker, little-endian request identity and encoded offset, and a terminal result confirms complete delivery. Raw bytes and Chromium's existing base64 representation are distinct encodings; JSON CDP base64 can pass through without a redundant Rust decode/re-encode. A base64 stream uses complete four-character groups. Enforce exact offsets, lengths, ownership and terminal state; errors discard incomplete data. Default limits allow 32 MiB decoded per attachment and two active attachments, with backpressure and cancellation while streaming. Chunk payloads are at most 64 KiB and complete frames obey the negotiated byte limit. Interleave other replies/events between attachment frames. These limits do not imply that the current browser transport can yet receive equally large CDP replies. Standard streams don't mix logs with protocol frames; diagnostics go to a separate stream
b. Handshake contains package/engine/protocol versions, capability inventory version, browser identity, encoding support and resource limits. Reject incompatibility before creating browser state
c. Command envelopes identify request, operation, context, page/frame, document generation, parameters and deadline policy. Terminal results include outcome, value/error, ownership metadata and bounded diagnostics
d. Keep request identity distinct from long-lived browser object identity. Deliver exactly one terminal result per operation; late results/events from cancelled generations can't satisfy a new request
e. Bound frame size, nesting/value counts, queued messages, pending operations and retained diagnostics. Initially cap control frames at 8 MiB, pending commands at 1024 and tracked main-world execution contexts at 1024 per page session; stream larger allowed artifacts in bounded chunks. Depth and node limits apply to command parameters, successful result values and event parameters. Error UTF-16 messages and dynamic diagnostics share one payload node budget; fixed error-envelope metadata is exempt from payload depth/node limits so a resource error remains representable, but the complete envelope still obeys the byte limit. Validate and encode terminal replies before writing any bytes. An oversized result/error rejects that call without replaying effects, preserving input delivery and cleanup state. An event or handshake that cannot fit produces a bounded global resource error and closes the stream, because omitting it could desynchronize the client. Allocated objects remain private until their successful reply is validated and encoded; rejected allocations receive bounded disposal. Basic context storage snapshots additionally cap retained origins at 1024, aggregate localStorage names/values at 100000 UTF-16 code units including two units per entry, and the serialized result at 7 MiB; an exceeded cap rejects the complete snapshot. Limits are negotiated and configurable where valid; exceeded limits return explicit resource errors without truncating requested content
f. Keep the event loop responsive while waiting for replies, writing a full pipe, servicing routes or invoking host callbacks. Support interleaved events and out-of-order replies; don't assume one outstanding request globally
g. JSON CDP preserves supported special values through typed conversion. CBOR must preserve UTF-16 code units, including lone surrogates where the public contract permits them, binary fields, numeric classes and inspector envelopes. Chromium uses an inspector-specific profile, not arbitrary generic CBOR; a decoder's convenience restrictions don't define production compatibility
h. Test framing fragmentation/concatenation, malformed lengths/tokens, duplicate policy, nested values, Unicode/NUL, binary payloads, event/reply interleaving, EOF and blocked writes. Transport failure invalidates the affected stream; don't continue after a partial corrupt write

Operation states: accepted → validating → resolving/waiting → dispatching → completing → terminal → released. Read-only predicates can repeat inside waiting; an input/backend effect can't be replayed merely because its reply was lost

i. Rust owns monotonic operation deadlines and cancellation. Resolve inherited/default/explicit timeouts per S4/S9, including the method-specific meaning of timeout: 0
j. The TypeScript adapter accounts for elapsed time before driver acceptance and retains a caller-side timeout/cancellation path. Send remaining finite budgets; don't compare raw monotonic timestamps from different processes or restart a timeout after every exchange
k. Parent test/fixture/worker budgets bound child operations when applicable. An explicitly unbounded standalone call remains unbounded by its public timeout; a separately configured job watchdog is disclosed as a system budget
l. Terminal resolution is atomic: success/failure/deadline/cancellation/target loss race through one completion point. Preserve the method's completion conditions; don't use Promise.race while leaving browser work active
m. Cancelled/expired work stops further dispatch, releases subscriptions/handles and settles host callbacks. Bounded cleanup has a separate reported result; it doesn't hide the original timeout or failure
n. If input delivery is uncertain after disconnection, report that uncertainty and stop automatic retries. Retry only a phase whose lack of effect is established
o. Locator-based work may rebind to successor documents when its documented behavior permits it; JSHandle/ElementHandle ownership remains tied to its original execution context. Don't treat every document transition as the same public error
p. Frame/target attachment, navigation, popup, detach, renderer crash and browser exit update registries and invalidate stale generations. Frame routing covers out-of-process targets
q. Every long browser harness/job has an external watchdog independent of Rust and renderer progress. Track owned process groups/profiles; normal exit, errors, signals, worker death and watchdog termination clean them up without killing unrelated user browsers. Borrowed remote connections have separate ownership: disconnect and dispose only owned resources, never terminate the remote browser implicitly. On watchdog shutdown, allow cleanup-owning descendants a bounded grace period before escalating through surviving owners to the whole tree. An exited or zombie owner does not remove that grace period; report incomplete cleanup explicitly
r. Rust panics/driver EOF reject pending operations deterministically and terminate owned resources. A dead Node worker can't leave an orphan Rust/browser tree; provide a parent-liveness mechanism in addition to normal disposal

CDP implementation reference: when implementing or upgrading encoding, inspect the selected revision's [pipe handler](https://github.com/chromium/chromium/blob/148.0.7778.96/content/browser/devtools/devtools_pipe_handler.cc) and [inspector codec](https://github.com/chromium/chromium/blob/148.0.7778.96/third_party/inspector_protocol/crdtp/cbor.cc). For this reference revision, the binary launch mode is --remote-debugging-pipe=cbor, selected for the entire connection. JSON pipe frames are NUL-terminated; CBOR maps/arrays use length-delimited inspector envelopes. The current envelope starts with d8 18 5a and a big-endian 32-bit payload length; validate legacy envelopes only when supported by the target browser

Inspector binary fields use tag 22 rather than JSON base64 strings. Keep their bytes distinct from text. In this reference codec, UTF-16 code units are little-endian despite a conflicting header comment; verify behavior against the pinned implementation and actual browser replies. Test lone surrogates, nonfinite numbers and integer ranges through the appropriate protocol value representation instead of relying on Rust String or plain JSON to represent every value

Finish line: deterministic race and failure tests establish one terminal result, no duplicate input, bounded cleanup, generation isolation and owned-process termination, including a stuck Rust process and blocked renderer

## S11 Locator and value semantics

a. Represent locators as immutable typed query/composition descriptors, resolved when an operation runs. Don't cache an element handle as the meaning of a Locator
b. Preserve exact/substring/regex matching, normalization, role/accessible-name rules, visibility options, chaining, filters, relative scope, list ordering and strictness for supported inventory entries
c. Handle detached/replaced elements, dynamically created open shadow roots, slotting, child frames and out-of-process frames. Don't cross closed shadow roots or frame boundaries where the reference selector doesn't
d. Multi-element/list assertions and count methods use their own cardinality rules; strict single-target rules don't apply indiscriminately. Negation, missing targets and empty collections require explicit conformance cases
e. Invalid selector syntax and strictness violations retain useful selector and call-site diagnostics. Query preparation doesn't surface an error before the corresponding operation is invoked
f. Value transport preserves documented evaluation/handle results and JavaScript edge values through a typed representation. Validate cycles, handles, ownership, errors and supported number/string/binary classes against the reference
g. evaluate functions run in the requested realm with the reference serialization rules; Node closures aren't magically captured. JSHandles have explicit disposal and can't be reused across unrelated contexts
h. Reuse pinned upstream selector/matcher logic where appropriate with licenses, provenance and an upgrade test corpus. An ID-only matcher or ordinary querySelectorAll isn't general Playwright selector parity; distinguish shadow-piercing CSS from css:light

Finish line: the inventory's supported selector/value cases pass a shared fixture corpus under both engines, including adversarial replacement, shadow/frame and Unicode/regex cases

## S12 Resident conditions and shared dependency registry

a. Install the runtime in an isolated realm per participating document/frame. Application scripts can't forge operation identity or terminal results; validate messages against the originating session/context and live operation
b. Register dependencies before the first condition check, then resolve the locator and evaluate the complete predicate. Handle mutations occurring during setup without a check/subscribe gap
c. On relevant change, re-resolve membership and evaluate the predicate; detach/replacement can't leave a subscription attached to the wrong element
d. Maintain a shared per-document registry for dependency discovery, open shadow roots and dirty invalidation. Cache immutable descriptors and valid discovery state, not assertion truth or completed actionability
e. Scope discovery when completeness is provable; otherwise use bounded discovery and a fallback. Whole-document scans aren't the default implementation goal, but narrowing without proving membership equivalence is invalid
f. MutationObserver doesn't cover every property, CSS/animation, stylesheet, font, focus, viewport or new-shadow change. Use scheduler/lifecycle subscriptions and bounded reevaluation for incomplete dependencies. Don't patch application behavior as a shortcut
g. Choose coalescing and fallback cadence by predicate requirements, responsiveness and measured cost. No fixed discovery/polling cadence is a universal API constant
h. Cancel stale work on ownership changes and release registry references when operations/documents end. Bound retained nodes, callbacks, subscriptions and invalidation queues
i. Return terminal outcomes and bounded relevant diagnostics; emit intermediate details only for requested instrumentation. Instrumentation policy is matched under S6
j. Test already-true, delayed, transient, negated, property-only, CSS-only, replacement, shadow creation, document transition and blocked-renderer cases. Earlier valid detection follows S4.b
k. Bound batches of pending reevaluations across observer and microtask cascades, and yield to browser tasks between batches. Coalescing must preserve progress for conditions at the end of the queue under continuous invalidation. An asynchronous check cannot block unrelated conditions. Dispose queued work and scheduling resources on cancellation or document retirement. A batch budget cannot preempt an individual synchronous predicate; retain host deadline and blocked-renderer ownership for that case
l. Known read-only assertion checks may share selector work within one uninterrupted synchronous batch. Each condition still executes its complete predicate. Close the query-cache scope before any microtask, browser task or application callback can run; retain no membership or predicate result across that boundary. Generic check callbacks and application-script predicates aren't eligible for a shared cache scope. Verify replacement, property changes, errors and cancellation across scopes, and count native queries separately from complete predicates

When optimizing traversal, count discovery passes and visited nodes separately from predicate evaluations. Repeating whole-document discovery for every step can dominate long sequences; prove that shared state removes that work without omitting membership or predicate checks

For a blocked renderer, a read-only condition cancellation may outlive the caller while the exact-context cancellation reply is retained under the connection's pending-work bound. Finite conditions also check their renderer deadline before every predicate. Release this deferred ownership when the cancellation is acknowledged, the document disappears or the page/browser closes; an ended host operation can never receive a late success. Collect terminal diagnostics within a short host-owned cleanup budget when the renderer responds. Do not terminate unrelated application JavaScript to force an assertion timeout

Assertions don't inherit an action's checks. A visibility assertion needs its own strictness, visibility, negation and missing-target behavior; it doesn't require click stability, enabled state or a receives-events check

Finish line: subscription and fallback paths have equivalent supported predicates, registry invalidation passes adversarial changes, cleanup retains no live work, and S6 demonstrates net benefit including discovery/preparation overhead

## S13 Native actions and custom Chromium gate

a. Keep pointer/keyboard input in Chromium's native input path. Match the reference action's targeting, event order and trusted-input behavior; DOM dispatchEvent isn't a substitute for an ordinary click
b. Resolve strict targets, perform the method's actionability checks, scroll, hit test through applicable frames, dispatch and wait for the method's required completion. Recheck invalidated facts immediately before dispatch
c. Initially preserve fresh consecutive-frame stability observation. Past geometry, layout-clean status or elapsed idle time alone isn't sufficient proof; an already-queued animation-frame callback may move a previously stable target. Two geometry reads in one task aren't two real frame samples
d. Match method-specific behavior: fill/select/check aren't interchangeable with typing/clicking, and their DOM/event semantics require separate tests
e. Implement force/trial/modifiers/positions/retries only according to their inventory contract. Preserve intentionally synthetic APIs when explicitly requested; don't use them underneath ordinary actions
f. Track input acknowledgement and delivery state. A cancelled pre-dispatch action sends no input; cancellation after dispatch reports progress without promising to undo application effects
g. Navigation/popup/dialog completion is coupled to the action where the reference requires it. Avoid success returned before required barriers or duplicated input after a lost reply

Custom Chromium gate:

1. Profile compatible ordinary actions on representative workloads after M2 using S6
2. If material orchestration remains, implement the browser/renderer ownership boundary below and compile one narrow coarse action endpoint with explicit supported options
3. Compare the same custom browser using Playwright and Flashwright, then report a separate stock-browser comparison. Keep frame/action checks initially unchanged
4. Require targeting, trusted event order, navigation, cancellation, crash, blocked-renderer and duplicate-delivery conformance before adoption
5. Retain the extension only if complete-flow savings exceed endpoint/setup/maintenance costs; otherwise keep the stock backend

The extension uses Chromium C++/Mojo interfaces while Rust remains the supervisor. A browser-side controller owns operation identity, deadlines, native input and navigation barriers; a Blink executor owns document-local resolution, fresh geometry and a live hit guard. Bind the typed channel to the DevTools session and invalidate it on detach, frame replacement or document change. DOM pointers never cross processes

The renderer returns an opaque attempt token, frame/document generations and a current root-space point. Revalidate the token after scrolling or relevant changes, open the method's navigation barrier before input, then inject through a shared Chromium input helper. Preserve acknowledgement, discard and uncertain-delivery distinctions; don't re-enter CDP through nested JSON or assume an acknowledgement alone proves the intended node received input

Release hit guards, retained nodes, subscriptions and pressed input state on terminal paths where possible. Keep bounded session-scoped completion records so reconnects or duplicate identifiers can't replay an accepted action. Apply S10.n when delivery is uncertain

Default click completion isn't an unconditional load or network-idle wait; preserve the reference method's signal barrier and input epilogue. Visibility/enabled checks must cover cases such as display:contents, label/control associations, fieldsets and inherited ARIA disabled state, not just a rectangle and a disabled attribute

Record patch surface, reproducible build instructions, Chromium revision, update/security cadence, redistribution notices and stock-backend behavior. A custom browser is acceptable, but its performance and maintenance benefit aren't assumed

## S14 Navigation, networking and host callbacks

a. Preserve goto URL resolution, navigation result/errors, waitUntil modes, same-document behavior, redirects and explicit wait methods for supported entries. Maintain lifecycle state across renderer/document changes
b. Arm event/predicate waits before the trigger when user code does so. Promise.all with an event wait and action must work; don't impose a page-wide queue that prevents the wait or route handler from running
c. Route callbacks, response predicates, exposed functions, fixtures and arbitrary user control flow stay in Node. Suspend the relevant operation and process unrelated protocol/lifecycle events while awaiting them
d. Callback messages carry ownership and operation identity; a late callback can't continue a cancelled request or new document. Propagate callback errors with user stacks
e. Network routing/fulfillment preserves body bytes, headers, method, redirects, cookies and response/error contracts. Do not replay a request because its callback/result delivery failed
f. Request/API fixtures need the declared authentication/storage-sharing/isolation behavior, timeout and disposal contract. They aren't fake Page requests or an unlabelled upstream browser backend
g. Distinguish transport network observation from page APIs and service-worker interception. Unsupported service-worker/WebSocket cases fail or stay explicitly outside the supported surface
h. Popup/dialog/download events create or reference registered objects with valid lifetimes; preserve event order, acceptance/dismissal/save semantics and target cleanup

Finish line: local real-HTTP fixtures cover redirects, auth/state, routing with delayed/failing callbacks, concurrent waits, navigation supersession, popups and declared events without deadlocks, duplicated requests or state leakage

## S15 Diagnostics, artifacts and reporting

a. Public failures identify the operation, selector, relevant observed value, timeout/elapsed duration, user call site and lifecycle cause. Redact credentials according to explicit logging policy without altering browser behavior
b. Map internal errors into stable public classes: UnsupportedFeatureError, InvalidArgumentError, TimeoutError, TargetClosedError, BrowserDisconnectedError, ProtocolError and ResourceLimitError. Preserve useful cause records and expose reference-compatible error exports where claimed
c. Bound success-path histories and materialize expensive diagnostics according to requested policy. A post-failure capture can't reconstruct earlier DOM/network state; don't call it an equivalent full trace
d. Screenshot options, masks, animation handling, scale/type and buffers/files require individual capability entries. Screenshot assertions include the declared reference image, comparison/update behavior and artifact outputs
e. Runner screenshot/trace/video settings are validated before the affected run. Unsupported requested artifacts reject explicitly; off and on-demand extensions are distinct policies
f. A claimed Playwright trace-compatible artifact must open in the pinned viewer and preserve the claimed information. A Flashwright-native trace uses an identified format/viewer and isn't advertised as the same artifact contract
g. Keep artifact events, attachments, test steps and reporter status consistent across passing, failing, retried, cancelled and crashed tests. A cleanup failure doesn't replace the originating test failure
h. Stream large artifacts with backpressure and atomic file completion. Don't emit corrupt/truncated files as successful results, retain unlimited frames, or block deadline/cancellation processing
i. Preserve requested passing/failure artifact policy in performance comparisons. Dropping screenshots/video/trace is governed by S6.k

Finish line: artifact fidelity, file/buffer outputs, viewer expectations, reporter attachments and failure diagnostics pass the declared policy corpus; resource limits don't silently omit requested data

## S16 Explicit sequences and controlled time

Ordinary Playwright-style calls retain S4. These extensions have distinct contracts and release labels

a. Submitted sequences contain finite validated operation descriptors, not arbitrary JavaScript/Python code. Expose them through flashwright/experimental with capability/version metadata
b. Offer Rust-owned sequencing first where host/native integration is needed, and renderer-owned assertion segments for validated local phases. Choose placement explicitly or by a disclosed planner with identical declared semantics
c. Preflight a sequence's supported syntax/options before starting. Resolve targets and execution-time conditions at the correct step; don't fail future locator checks prematurely
d. Preserve order, fail-fast behavior, completed indices and the first failed step when recoverable. If a renderer is lost, report unknown internal progress rather than inventing an exact index
e. Define the shared monotonic budget and required task/microtask yields. It isn't a transparent transformation of per-step timeouts or arbitrary await interleavings
f. Host callbacks/services, unsupported native operations and document transitions form explicit boundaries. Initial renderer segments are assertion-only and document-bound; stop or split before a boundary
g. No implicit action speculation, skipped predicates or unsupported branches. Expired/cancelled plans start no additional operations; apply S10 delivery and cleanup rules
h. Benchmark both sequence owners against ordinary TypeScript calls on the same predicates, diagnostic policy and application work, including plan preparation. Apply S6; an immediate-assertion workload isn't a representative application suite

Controlled-time mode is separately enabled through the experimental namespace/config. Its capability declaration covers timers, microtasks, frame timestamps/callbacks, CSS/Web Animations, workers, cross-process frames, media and network/backend clock interactions individually. Unsupported combinations reject before activation

Maintain a real host deadline and declared synchronization with external work. Existing Playwright clock APIs are a required comparator when applicable. Never enable virtual time, frame uncapping or animation skipping from an ordinary config as a hidden speed optimization

Finish line: each extension passes its own order, yield, deadline, cancellation, callback and lifecycle corpus; controlled-time results retain separate coverage and benchmark labels

## S17 Isolation, preparation and suite throughput

a. Share worker browser processes according to compatible launch/configuration keys. Give each ordinary test/retry a fresh context and dispose it; clearing a used page isn't fresh isolation
b. Add a bounded supply of virgin prepared contexts only after setup attribution justifies it. Match configuration, count unused preparation work and release unused contexts on teardown
c. Prove isolation of cookies, local/session storage, IndexedDB, caches/service workers, permissions, handles and application state for the claimed context contract. External backend state remains the test's responsibility
d. Reuse only immutable compilation/selector artifacts with correct source/browser/origin/configuration invalidation. Separate cold and warm application modes
e. Start with the runner's declared worker scheduling. Add resource-aware decisions only through a runner extension that preserves test ordering/dependency/fixture semantics
f. Measure contention across CPU, memory, rendering and backend resources. Report adaptive overhead, fairness and determinism as well as throughput at matched budgets
g. Page/process snapshots, hydrated checkpoints and alternative engines are separate research until full restoration/coverage is proven; V8 serialization alone isn't complete browser-state restoration

Finish line: resource-bounded suite tests demonstrate isolation across failures/retries and useful complete-suite savings including preparation, startup and discarded work

## S18 Distribution, installation and version policy

Development reference: Rust 1.98/Cargo and Playwright 1.60.0. The repository bootstrap installs checksum-verified Node 24.15.0 (default) or 22.22.0 under .tools without changing global PATH. Load [README.md](README.md) R2 for development commands. Python is used by the development watchdog and bootstrap, not the shipped engine. Existing local macOS browsers are under ~/Library/Caches/ms-playwright. Exact toolchain/browser identities and platform evidence are in [compatibility/reference-manifest.json](compatibility/reference-manifest.json); these local facts aren't cross-platform consumer install instructions

a. Publish installable JavaScript/declaration packages and platform executables, with exact engine/protocol/artifact manifests. Verify package-name availability before finalizing release names
b. Prefer minimal justified dependencies. Pin Rust dependencies and commit Cargo.lock; pin the JavaScript runner/build dependency graph in the chosen workspace lockfile. Version runner integration independently when necessary and declare the tested upstream range
c. Prefer platform packages or explicit install commands with integrity verification. Support an explicit local executable override for development/offline deployments. Don't require a Rust compiler in consumer projects
d. Browser acquisition is explicit, versioned and reproducible. A lightweight npm install doesn't silently download or garbage-collect shared browsers. Existing browser paths are accepted only after identity/capability validation
e. The install command records revision, checksums, cache identity and required system dependencies. Respect offline/cache paths; never remove unrelated Playwright caches
f. Initial release targets are Linux x64 and macOS arm64; Linux arm64, macOS x64 and Windows become supported only with binary/install/lifecycle/browser coverage. Fail clearly on unsupported targets
g. Test packed tarballs in clean projects using npm, pnpm and Yarn configurations selected in M0. Include ESM, CommonJS, mixed-module tests, workspace layouts, direct imports and aliases; don't rely on repository symlinks
h. Alias tests verify dependency resolution of the isolated upstream runner, optional flashwright/test entry point, type-only imports from page objects, reporter imports, CLI ownership and absence of upstream browser-driver operations. Missing optional runner installation produces clear guidance; library-only installation stays independent. Do not mutate global module resolution or prototype-brand Playwright objects
i. Preserve upstream Apache/Chromium/inspector notices and provenance for copied code/types. Publish third-party license notices and source requirements applicable to distributed browsers/binaries
j. No semver claim exceeds the tested capability/version matrix. On upstream/browser upgrades, regenerate inventory, review selector/runner/codec changes and pass S19 before expanding support
k. Documentation distinguishes engine/browser installation, preferred import migration, alias mode, unsupported configuration, experimental APIs and artifact viewing. Package examples must run against packed releases

Finish line: supported-platform consumers install and run migration examples without local build tools, resolve the intended engine/runner once, and clean up every owned process

## S19 Repository layout, verification and release gate

Create this proposed implementation layout from the specification:

```text
Cargo.toml
Cargo.lock
crates/
  flashwright-protocol/
  flashwright-browser/
  flashwright-engine/
  flashwright-driver/
packages/
  flashwright/
  flashwright-test/
  resident-runtime/
compatibility/
  reference-manifest.json
  capabilities.json
  fixtures/
  migration-projects/
benchmarks/
  configurations/
  workloads/
  results/
docs/
  compatibility.md
  migration.md
```

Keep architecture-sized module boundaries; don't add crates solely to wrap single helpers. The resident runtime is bundled and hashed with the engine version. Exact generated layout/build tooling is selected in M1 and recorded in code manifests

Use clear readable names and match the surrounding implementation style. Fix root causes rather than hiding failures behind workarounds; refactor when the ownership or operation model is wrong. Keep comments for non-obvious reasons, not restatements of code

Implementation workflow:

1. Select the S5 milestone and applicable sections; identify its supported slice and finish line before editing
2. Implement from this specification and pinned upstream contracts. Reused upstream sources retain hashes, notices and a record of changes
3. Implement the root operation and ownership semantics, then add meaningful conformance/lifecycle cases for that slice
4. Run applicable formatting/lint/type/package checks and functional differential cases before S6 timing
5. Retain results/provenance, update the capability inventory and mark the milestone complete only when its full finish line passes

Release verification must cover:

a. Rust formatting/lint/unit/integration, TypeScript declaration/runtime checks and reproducible locked builds
b. Differential API fixtures for supported defaults/options, return/error values, locators, events, callbacks, input, navigation and artifacts; compare semantic outcomes with S4's permitted sampling differences
c. Cancellation/deadline races, blocked outgoing pipe, blocked renderer/Rust/Node worker, stale generations, crashes/disconnects, callback rejection and resource cleanup
d. Packed consumer/migration projects from S7–S9/S18, with compile-time and runtime evidence. Preserve test bodies; record any unavoidable migration change
e. Browser/context isolation, retries, worker teardown, process-tree cleanup and requested diagnostic fidelity
f. S6 performance/regression gates on supported Linux/macOS targets using matched reference versions and policies
g. Machine-readable inventory with no unclassified member/option and no “supported” entry lacking evidence
h. Explicit release notes listing supported versions/platforms, unsupported APIs/options, experimental modes and benchmark scope

Release finish line: all gates for the declared release scope pass, unresolved gaps are typed unsupported capabilities, package manifests match tested artifacts, and no public claim exceeds S6 evidence

## S20 Decisions still requiring evidence

These aren't excuses to defer S5; resolve them in the named milestone and record the result in the relevant inventory/configuration

| Decision | Resolve in | Required evidence |
| --- | --- | --- |
| Linux frame/input and setup cost versus macOS | M0 | Matched real browser runs on target CI hardware |
| Exact runner private touchpoints and alias dependency layout | M0–M2 | Pinned-source review plus installed fixture/assertion/artifact smoke and conformance tests |
| Node/TypeScript/package-manager version ranges and performance thresholds | M0 | Consumer matrix and baseline variability, recorded before final timing comparisons |
| Shared registry invalidation strategy and fallback cost | M3 | Adversarial predicates and matched off/on workload accounting |
| Production CBOR string/binary coverage and connection policy | M3 | Full declared value/framing corpus and payload/control comparisons |
| Which additional APIs/configurations matter most for migration | M0–M4 | Inventory of selected existing TS projects and unchanged-body migration corpus |
| Native endpoint's benefit and maintenance cost | M6 conditional | Compiled equivalent action, complete-flow attribution and reproducible browser builds |
| Controlled-time coverage and throughput priorities | M5 | Separate semantic coverage and representative suite attribution |

Don't leave a decision marked pending once its evidence exists. Adopted architecture choices are in S2; unmeasured implementation performance remains unknown
