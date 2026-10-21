# Benchmark comparison status

Flashwright has not established performance leadership. The [five-engine checkpoint](../compatibility/evidence/broad-performance-checkpoint-2026-10-10.json) records 40 passing sampled launches after a 162-group core gate. All 926 recorded source files match commit `70dc299f`. The [complete comparison table](../benchmarks/results/broad-matrix-2026-10-10/evidence/table.md) includes every workload, preparation-inclusive totals, startup, CPU, concurrent memory, uncertainty and recorded semantic differences.

The current contender set also includes **Bun.WebView**, pinned initially to Bun 1.4.2. Its Linux Chrome adapter now has eight launches of native library timing observations across seven fixture categories, shown separately below. Equivalent-work and comparative measurements remain unadmitted; it has no result in the historical five-engine snapshot. The system-WebKit backend on macOS requires a separate comparison class. See the [native observations](../benchmarks/results/bun-webview-native-linux-2026-10-21.json) and [contender configuration](../benchmarks/configurations/competitors.json).

## Integrated runner with lazy video-capability initialization

The [lazy VAAPI comparison](../benchmarks/results/lazy-vaapi-initialization-linux-2026-10-21.json) runs the public independent scheduler with the private renderer-reuse and frame-scheduling composition. The custom browser keeps ordinary hardware-decoding policy and defers native video-driver capability discovery until a consumer needs it. Both Flashwright arms use the same binary; the reference uses stock Playwright. Complete times include HTTP startup, tests, shutdown and observed natural drain under equal resource limits.

Each cell shows the two opposite-order observations in seconds. These 24 captures pass all 360 original tests.

| Application | Workers | Stock Playwright | Eager discovery | Lazy discovery | Playwright / lazy |
| --- | ---: | ---: | ---: | ---: | ---: |
| TodoMVC | 1 | 3.841 / 3.903 | 2.077 / 2.225 | 1.954 / 1.992 | 1.966× / 1.959× |
| TodoMVC | 4 | 2.729 / 2.696 | 2.328 / 2.386 | 1.664 / 1.699 | 1.640× / 1.587× |
| SVGOMG | 1 | 1.647 / 1.957 | 1.219 / 1.210 | 0.932 / 1.115 | 1.768× / 1.755× |
| SVGOMG | 4 | 2.370 / 2.293 | 2.532 / 2.040 | 1.234 / 1.270 | 1.921× / 1.805× |

Four-worker complete times fall 28.5–28.8% for TodoMVC and 37.7–51.3% for SVGOMG against eager discovery. The Playwright ratios remain below 2×. Selected rendering, isolation, codec-query and software-playback controls pass, but this machine never reaches successful deferred hardware initialization. The feature requires the existing unsandboxed experimental profile; first hardware use and watchdog behavior remain unverified. This is an engineering improvement, not public default adoption or the final nine-scenario, eight-pair acceptance campaign.

## Bounded retirement collection: rejected

The subsequent [same-binary comparison](../benchmarks/results/batched-retirement-collection-linux-2026-10-21.json) retains every existing context/worker retirement fence but forces garbage collection every fourth closure, or earlier when observed V8 heap/backing-store bytes reach 64 MiB. Ordinary memory pressure remains checked at every closure. Both Flashwright arms retain lazy video-capability initialization.

| Application | Workers | Complete time saved, first order | Complete time saved, reverse order |
| --- | ---: | ---: | ---: |
| TodoMVC | 1 | -0.7% | -1.1% |
| TodoMVC | 4 | 11.9% | 1.9% |
| SVGOMG | 1 | -4.9% | -11.6% |
| SVGOMG | 4 | 16.9% | -20.9% |

Negative savings mean slower execution. All 360 original application tests pass, as do 64 fresh-context functional controls. Native traces verify skipped/fourth collections and immediate collection for large backing stores; all 16 video screenshots retain the expected visible pixels. No late timer/finalizer beacon is observed, which does not prove synchronous finalizer drainage. The 64 MiB trigger is not a process memory limit.

The predeclared gate requires at least 10% lower TodoMVC time at both worker counts in both orders, with no more than 5% regression elsewhere. It fails. The candidate is rejected and the preceding native source is restored; the archived patch is experiment evidence only. Do not repeat this unchanged policy as a general speed optimization or select its single favorable four-worker observation as the result.

## Renderer reuse experiment on Linux

The [renderer reuse screen](../benchmarks/results/renderer-reuse-linux-2026-10-21.json) records 240 passing unchanged TodoMVC/SVGOMG tests across 16 complete runs. The private browser retains physical renderer compilation state across actual fresh BrowserContexts, after retiring original document, connection and worker ownership. Both modes use the same custom browser, private driver and feature flags; only reservation reuse changes. This is a comparison against reuse disabled, not against Playwright.

| Application | Workers | Complete time saved, first pair | Complete time saved, reverse pair |
| --- | ---: | ---: | ---: |
| TodoMVC | 1 | 25.0% | 22.1% |
| TodoMVC | 4 | 11.2% | 12.7% |
| SVGOMG | 1 | −18.6% | 19.5% |
| SVGOMG | 4 | −3.9% | 1.0% |

Negative savings mean slower execution. Time includes fixture and browser startup, preparation, unused final reservations, runner shutdown and observed descendant drain. Sampled peak RSS changes range from −2.6% to +5.0%; they are not exact charged-memory measurements. Only TodoMVC at one worker meets the prospective rule of at least 20% savings in both orders. Continue targeted investigation without enabling reuse by default. The two-pair private screen does not establish broad 2× performance, release acceptance or standalone reproducibility; the checkpoint retains all observations and these limitations.

A subsequent direct comparison runs another 360 unchanged tests across 24 complete launches. It includes Playwright 1.60.0 on the pinned stock headless shell and on the same custom browser. All tests and requested common launch-argument checks pass; no capture is retried or discarded. The ratios below divide Playwright time by candidate time, so values above 1 favor Flashwright.

| Application | Workers | Stock Playwright / candidate, first / reverse pair | Custom Playwright / candidate, first / reverse pair |
| --- | ---: | ---: | ---: |
| TodoMVC | 1 | 1.088× / 1.120× | 1.186× / 1.237× |
| TodoMVC | 4 | 0.879× / 0.896× | 0.982× / 1.020× |
| SVGOMG | 1 | 0.931× / 0.788× | 0.980× / 0.847× |
| SVGOMG | 4 | 0.695× / 0.745× | 0.786× / 0.787× |

No cell reaches 2×. The candidate beats stock Playwright only for one-worker TodoMVC, and sampled peak RSS is about 15–23% higher than stock in every pair. Do not adopt this composition based on its improvement over reuse disabled. Four separate instrumented runs pass another 60 tests and place about 0.8–0.9 seconds before the first engine operation. Pointer actions, navigation and context retirement dominate the observed operation intervals; those intervals include waiting and are not CPU costs or guaranteed savings. Startup investigation remains separate from the timed comparison. The result file preserves the attribution controller's initial verifier-invocation failure and continuation without rerunning the completed workload.

## Runner native-transform experiment on Linux

The [native-transform screen](../benchmarks/results/native-transform-linux-2026-10-21.json) retains 240 passing original TodoMVC/SVGOMG tests across sixteen one-worker launches. It keeps the pinned runner and fixtures, adds conservative SWC transformation with Babel fallback, and defers three eager Babel consumers. Both modes use the same private renderer-reuse browser and driver. This compares two Flashwright variants, not Playwright.

| Application | Transform cache | Complete time saved, first / reverse pair |
| --- | --- | ---: |
| TodoMVC | Cold | −0.54% / 3.43% |
| SVGOMG | Cold | −0.57% / 6.14% |
| TodoMVC | Warm | −0.97% / 0.74% |
| SVGOMG | Warm | −0.55% / 19.96% |

No cell meets the prospective 20% reduction in both orders. Reject this composition for adoption. Cold native runs still need Babel for forty framework files and use roughly 4–6% more sampled peak RSS. Warm caches are independently copied from each mode's earlier cold run before timing; they are explicitly separate from cold startup. The single near-20% observation is not a consistent gain or a reason to change the threshold.

Thirty-two source-loader controls, eight selected semantic differential cases and focused caller/error checks pass after tightening fallback rules for TypeScript module extensions and CommonJS export descriptors. An initial caller-test adaptation incorrectly assumed CommonJS within an ESM package; the failed attempt and explicit fixture correction are retained. These controls do not prove complete transform compatibility. All three generated runtime files were restored exactly; no product transform change was adopted. The checkpoint records provenance gaps, sampled-resource limits and every timed observation. The representative 2× objective remains unmet.

## Independent runner and renderer reuse on Linux

The [composition screen](../benchmarks/results/bun-reuse-composition-linux-2026-10-21.json) combines the existing private Bun passing-suite bridge with the native renderer-reuse candidate. Sixteen one-worker launches pass 240 unchanged TodoMVC/SVGOMG tests. The four arms are stock Playwright, the existing Flashwright runner with reuse, the Bun bridge with reuse and its full utility bundle, and the same bridge with only the pinned YAML modules extracted. Ordinary test/context isolation and selected native input remain enabled.

| Application | Stock Playwright / slim composition, first / reverse pair | Existing runner with reuse / slim composition, first / reverse pair |
| --- | ---: | ---: |
| TodoMVC | 1.518× / 1.442× | 1.356× / 1.362× |
| SVGOMG | 1.585× / 1.244× | 2.042× / 1.255× |

Values above one favor the composition. Neither application meets the prospective 1.5× stock-reference threshold in both orders, and no stock-reference pair reaches 2×. Sampled peak RSS is about 18–20% below stock. Removing unrelated utilities is not a consistent source of improvement: TodoMVC changes by −1.2%/+2.3%, and SVGOMG by +7.6%/−22.7%. The combined result cannot be attributed solely to YAML loading or compared by multiplying earlier stage ratios.

Nine selected parser cases and nine bridge controls per utility mode pass. Reservation records verify fresh context transfers and original host/process joins. The original controller finished all runs but then rejected its input check because it had inventoried its own changing stdout log; independent reconstruction excludes exactly that output and verifies every other recorded input unchanged. The reservation verifier was also corrected to use retained raw stderr, where this runner profile emits its diagnostics. No application capture was repeated.

Keep this composition private. The bridge still lacks general fixture/hook semantics, retries, failure worker replacement, timeout cancellation and requested artifacts. This is a useful measurement of combined startup and renderer savings, not a compatible runner release or evidence for the majority-scenario 2× target. Preserve the gap and do not expand the unchanged composition's campaign.

## Independent runner, renderer reuse and frame scheduling on Linux

The [combined frame-scheduling screen](../benchmarks/results/bun-reuse-frame-composition-linux-2026-10-21.json) adds uncapped frames and the existing classic scheduler early idle deadline to the private Bun bridge and physical renderer reuse. Twenty complete one-worker launches pass all 300 original tests. Five arms include stock Playwright, ordinary and accelerated custom-browser Playwright, and ordinary and accelerated candidates. The second pair reverses the first pair's order. Time includes fixture validation/startup, runner/browser startup, test execution, unused final reservations and observed process drain.

| Application | Stock Playwright, first / reverse pair | Accelerated candidate, first / reverse pair | Stock / candidate | Time saved versus ordinary candidate |
| --- | ---: | ---: | ---: | ---: |
| TodoMVC, 24 tests | 3.849 / 3.804 s | 2.164 / 2.085 s | 1.779× / 1.824× | 20.85% / 26.91% |
| SVGOMG, 6 tests | 1.987 / 1.968 s | 1.204 / 1.196 s | 1.651× / 1.645× | 12.10% / 30.03% |

No pair reaches 2×. The prospective rule required at least 20% savings versus the ordinary candidate in both pairs for both applications; SVGOMG's first pair fails it. Do not promote this composition or launch the final acceptance campaign on these results. All launch policies, original test/fixture callback identities, request contracts and reservation host/process joins verify. Each candidate run retains one physical renderer while transferring fresh contexts. Selected real-time motion, trusted input, fresh-storage and isolated idle-CPU controls pass; these do not establish complete frame, screenshot or isolation compatibility.

The preceding SlimScheduler composition failed on TodoMVC's fifth test after four passing captures. It reached the unchanged 12-second renderer-transfer deadline; fifteen planned captures were not run. A bounded diagnostic reproduced the failure after target-close acknowledgement, before retirement GC. A debugger found the renderer main thread waiting for compositor commit during document shutdown while the compositor thread was idle. This localizes the stall but does not prove its exact scheduler cause. A separate verbose diagnostic passed all 24 tests; its logging perturbs timing and does not erase the failures. All observations are retained. The completed campaign explicitly disables SlimScheduler and uses the existing classic scheduler policy; it is a separate composition, not a claimed fix for SlimScheduler.

The bridge remains private: general fixture graphs, hook ordering, retries, worker replacement, cancellation and requested artifacts remain incomplete. The failed run also exposed skipped final reporting under Bun's bail behavior. Two pairs on two applications are engineering evidence, not confidence intervals or the nine-scenario, one/four-worker, eight-pair release result. CPU and memory remain limited observations. No product runtime or native-browser change is adopted by this checkpoint.

## Retirement garbage-collection attribution on Linux

The [retirement attribution checkpoint](../benchmarks/results/retirement-gc-attribution-linux-2026-10-21.json) measures the existing native collection policy before investing in another browser build. Four instrumented one-worker runs of the private Bun bridge with renderer reuse pass all 60 original tests. The traces contain 60 nonoverlapping retirement calls, matching the reservation counts and renderer identities.

| Application | Native retirement collection, first / second run | Host context-close total, first / second run |
| --- | ---: | ---: |
| TodoMVC, 24 tests | 184.36 / 184.83 ms | 479.74 / 469.45 ms |
| SVGOMG, 6 tests | 43.76 / 41.27 ms | 144.20 / 134.97 ms |

Do not build the deferred-collection variant now. The measured collection spans are small relative to the roughly 0.7-second TodoMVC gap to 2× in the preceding uninstrumented composition. This is a prioritization decision, not a bound on possible savings: tracing changes scheduling, and collection can have indirect effects. Native spans include nested GC work; host close durations use a separate clock and are not added to them. The deliberate wait for trace publication makes these runs unsuitable for speed comparisons. Original browser exits and observed cleanup pass, selected inputs remain unchanged, and no runtime or native source change was adopted. Compatibility, final resource admission and the representative 2× objective remain open.

## Declarative capability experiment on Linux

Selected native omissions work, but the complete per-test capability API remains a private prototype. The [compatible-worker experiment](../benchmarks/results/capability-worker-reuse-linux-2026-10-18.json) passes 360 functional and 720 timed original TodoMVC/SVGOMG test executions across both engines, one/four workers and reversed execution order. Both full and restricted profiles reuse one browser per compatible worker and create a fresh context per test. This removes the earlier prototype's extra browser launch per test from the comparison.

Restrictions omit painting/capture, unused DOM storage and service workers; TodoMVC also omits IndexedDB, while SVGOMG retains it because its application accesses it. Native construction traces confirm the selected objects are omitted and raster tasks disappear. Ordinary networking, JavaScript, layout and required input behavior remain enabled.

The table reports percentage reduction in complete-owner elapsed time for restricted versus full capabilities **within each engine**. Positive values mean faster; negative values mean slower. These two blocks are an engineering screen, not confidence intervals or a Flashwright-versus-Playwright ranking.

| Engine | Application | Workers | First block | Reversed block |
| --- | --- | ---: | ---: | ---: |
| flashwright | todomvc | 1 | -2.58% | +11.15% |
| flashwright | todomvc | 4 | +2.65% | +4.55% |
| flashwright | svgomg | 1 | -24.82% | +7.02% |
| flashwright | svgomg | 4 | +0.70% | -2.34% |
| playwright | todomvc | 1 | -0.02% | -0.07% |
| playwright | todomvc | 4 | +2.55% | +2.77% |
| playwright | svgomg | 1 | -0.12% | +4.65% |
| playwright | svgomg | 4 | +18.26% | +3.56% |

No cell meets the predeclared 20% reduction in both blocks. This does not show that removing optional browser work inherently slows execution: it shows that these exclusions have not delivered a consistent large complete-suite benefit on these applications. The cause of individual regressions remains unresolved. Removing the prototype's redundant browser launches separately saves roughly 48–64% in the longer-per-worker Flashwright cells; ordinary Playwright already reuses browsers, so that is not an engine advantage.

There is a separate positive result. In the [painting-density experiment](../benchmarks/results/capability-paint-density-linux-2026-10-18.json), disabling drawing reduces preparation-through-cleanup elapsed time by about 22–25% across both engines on the 4,096-tile synthetic workload, while the sparse workload is essentially unchanged. The later [compatible-worker backend checkpoint](../compatibility/evidence/capability-worker-backend-checkpoint-2026-10-19.json) passes 496 original tests and 24 direct isolation/violation control scopes. Its matched restricted profile disables painting/capture while retaining all storage and network: Playwright authentication-state restoration accesses service workers, and the earlier exclusion correctly failed. The corrected adapter also keeps each project worker’s recording directory independent.

The subsequent [backend timing screen](../benchmarks/results/capability-worker-backend-timing-linux-2026-10-20.json) passes 992 original tests in 16 fresh launches under a common four-core quota, 8 GiB memory ceiling and zero swap. Both declarations retain native worker journals and fresh contexts. Fresh PostgreSQL initialization, Mailpit, API, authentication, tests and ordinary shutdown are inside the measured interval; the original frontend build and source verification are outside for both. Primary elapsed time runs from native owner creation through original-owner wait and natural drain into an empty cgroup.

| Backend workers | Flashwright restricted/full, block 0 / reversed block 1 | Playwright restricted/full, block 0 / reversed block 1 | Same-full Playwright/Flashwright, block 0 / reversed block 1 |
| --- | --- | --- | --- |
| 1 | 0.9981 / 1.0004 | 1.0004 / 1.0117 | 1.0213 / 1.0130 |
| 4 | 1.0001 / 0.9897 | 0.9906 / 0.9927 | 0.9763 / 0.9709 |

Restricted/full below 1 means the exclusion is faster; Playwright/Flashwright above 1 means Flashwright is faster. Neither worker configuration reaches the declared 20% restriction benefit in both orders. Backend elapsed time is essentially unchanged; the dense synthetic painting benefit remains a separate result. Two reversed blocks do not establish population uncertainty or final performance acceptance.

All 56 original browser launches have initial argv/environment and executable-identity receipts from a brief original-parent exec stop, followed by detachment before browser code runs. That observation cost is included symmetrically; there is no steady-state tracing or continuous environment attestation. The preceding 992-test campaign remains unadmitted and separate because four browsers lacked usable initial-environment observations. Its freeze/analyzer failures and the observer control harness's initial declaration failure remain retained. This engineering screen uses the preserved capability browser before Idea 02 changes; it establishes neither public capability delivery nor complete process/resource custody.

Selected isolation, immutable-profile, retry and caught-violation controls pass. Native violations in the reused browser are currently attributed to the worker and fail suite teardown; exact per-attempt native attribution, bounded long-suite record retention, broader capability enforcement and public packaging remain unfinished. Sampled resource observations do not establish complete process custody. The representative majority-scenario 2× objective remains unmet.

## Chromium protection-removal experiment on Linux

The [Idea 02 checkpoint](../compatibility/evidence/idea02-partial-removal-checkpoint-2026-10-19.json) records a private Chromium build with selected V8 sandbox machinery, Linux OS sandbox paths, physical site-isolation policy and jail/citadel enforcement removed from source/build paths. Ordinary JIT/GC and logical origin, storage, network and frame behavior remain. This is partial removal: shared process-lock metadata, committed-origin tracking and frame/navigation routing remain. The browser reports a distinct custom identity, and unsupported configurations reject.

Five incremental screens each passed 480 original TodoMVC/SVGOMG tests across both engines, one/four workers and two reversed blocks. None met the declared 20% reduction in both blocks for any Flashwright application/worker cell. The [complete observations](../benchmarks/results/idea02-partial-removal-linux-2026-10-19.json) retain all stage ratios separately, including the early V8 screen's missing environment evidence and different timing boundary.

A separate cumulative screen compares the preserved browser from before Idea 02 with the final selected removals, using the same private driver and matched launch flags. Both profiles retain the existing `--no-sandbox` launch policy; the Linux OS stage tests source/build omissions beyond that runtime setting. All 480 original tests passed across 32 launches. The table shows candidate elapsed time divided by baseline elapsed time **within Flashwright**; below 1 means faster. Elapsed time includes owner startup and observed natural descendant drain.

| Application | Workers | First block | Reversed block |
| --- | ---: | ---: | ---: |
| TodoMVC | 1 | 0.949× | 1.019× |
| TodoMVC | 4 | 1.010× | 1.063× |
| SVGOMG | 1 | 0.976× | 1.195× |
| SVGOMG | 4 | 1.024× | 1.067× |

No cumulative cell improves in both orders. These selected removals have not delivered a consistent complete-suite speedup, and the unchanged cuts do not advance. Two blocks on a shared host cannot establish the cause of individual regressions or uncertainty bounds. Incremental ratios are not multiplied or pooled with the cumulative results.

Selected correctness gates pass: 116 native V8 cases, 22 upstream mjsunit files, 3,868 additional BigInt boundary assertions, 170 browser-semantic checks and 66 native process-security controls across enforcement-on/off builds. Counts overlap across stages and are not exhaustive conformance. The first cumulative campaign remains excluded after a malformed process-title sample; a corrected observer retains partial reads and still rejects unexpected launch flags. Its fresh full campaign and the failed originals are documented separately. Full site-isolation machinery removal, macOS coverage, public adoption, complete resource accounting and the representative 2× objective remain unfinished.

The subsequent [physical-origin attribution](../benchmarks/results/idea02-physical-origin-attribution-linux-2026-10-20.json) passes 60 original tests across four fresh single-worker launches, with one traced and one untraced launch per application. The instrumented browser also passes 33 selected native cases. All four original browser exits and both trace publications are verified.

| Traced application | Original tests | Resolver calls | Summed resolver spans | Within synchronous navigation dispatch |
| --- | ---: | ---: | ---: | ---: |
| TodoMVC | 24 | 2,143 | 7.374 ms | 4.675 ms |
| SVGOMG | 6 | 630 | 2.115 ms | 1.289 ms |

Every observed lookup found an empty physical isolated-origin registry. These small instrumented spans give no reason to prioritize the unchanged lookup-removal candidate for large suite gains. They do not measure the remaining shared process/frame machinery or establish achievable savings. Caller, resolver and lock spans nest and must not be added. JSON durations have microsecond precision; complete zero-duration events retain their counts.

Each trace includes startup, original application work and a deliberate idle wait for capture publication, ending before ordinary browser teardown. No comparative timing ratio is calculated. The earlier wrong-driver campaign and failed shutdown-trace campaign remain excluded; the latter passed test bodies but lacked a complete trace and original traced browser-exit receipt. Broader Idea 02 removal and the representative 2× objective remain open.

## Application compilation inherited by Linux renderers

The [application-code inheritance screen](../benchmarks/results/application-code-inheritance-linux-2026-10-20.json) tests a different preparation mechanism: compile the exact application source in a donor isolate, without executing it, then let ordinary browser compilation reuse the inherited code in fresh contexts. The private browser retains normal network loading and application execution. Native observations verify both the inherited shared-function identity and an explicit in-memory compilation-cache hit.

Before timing, 180 unchanged TodoMVC/SVGOMG tests pass across ordinary, virgin-donor and application-seeded profiles at one and four workers. Twelve direct fresh-context controls pass application behavior, trusted input and storage/global isolation. Twelve additional controls verify that changing source text, origin offset or host metadata prevents seed reuse while the original served application still works.

The subsequent screen passes 360 original tests across 24 cells and 60 browser launches, with 120 inherited application compilations. Both orders include application services, runner startup, all donor preparation and observed natural cleanup. Only the seeded profile pays manifest serialization. Each cell uses the same four-core quota, 8 GiB memory limit, zero swap, browser, driver and artifact policy. Ratios below are seeded elapsed time divided by the indicated control; below 1 means faster.

| Application | Workers | Seeded / ordinary, forward / reverse | Seeded / virgin donor, forward / reverse |
| --- | ---: | ---: | ---: |
| TodoMVC | 1 | 0.959 / 0.963 | 0.953 / 0.956 |
| TodoMVC | 4 | 1.031 / 1.021 | 1.031 / 0.971 |
| SVGOMG | 1 | 0.978 / 0.986 | 0.989 / 0.969 |
| SVGOMG | 4 | 0.967 / 0.975 | 0.989 / 0.976 |

No cell reaches the predeclared 20% reduction against both controls in both orders. The mechanism works in this tested slice, but the unchanged composition does not advance as a large-gain optimization. Every observed application hit uses the ordinary streaming path, which can perform background parsing before the final cache lookup. A hit therefore does not prove that all parsing was avoided. Separate component controls also show that explicit memory pressure clears the inherited default cache.

These are two observations per cell on a shared host, not confidence bounds, a stock-browser comparison or a Playwright speed ratio. The initial compiler failures and missing-driver foundation launch remain separate from successful campaigns. Exhaustive manifest validation, broader lifecycle/conformance, complete resource custody, public adoption and the representative 2× objective remain open.

The [streaming follow-up](../benchmarks/results/application-streaming-suppression-linux-2026-10-20.json) tests the remaining hypothesis directly: disable streaming for a declared donor-prepared script, then compile its full response through ordinary V8 cache validation. Initial-URL matching selects this policy; it never authorizes executing prepared source in place of a changed response. Source, origin and host-option mismatch controls retain normal compilation.

Before this change, eight diagnostic launches pass 120 unchanged tests and record current client-operation intervals. Ordinary TodoMVC navigation totals about 1.29–1.30 seconds over 24 tests, versus about 0.38 seconds for page creation. SVGOMG click intervals total about 0.66–0.68 seconds. These intervals include queueing, browser/application waits and cleanup; they do not identify removable work or CPU shares.

The follow-up passes 180 original tests and 28 direct fresh-context controls before its 360-test timing screen. The screen retains 60 original browser exits, 120 URL-policy suppression decisions and 120 matching inherited-cache hits through the non-streaming path. Its seeded streaming control supplies another 120 hits. Preparation, ordinary scheduling, HTTP/outcome contracts, resource limits and cleanup remain in the same complete-work comparison.

| Application | Workers | Deferred / ordinary, forward / reverse | Deferred / seeded streaming, forward / reverse |
| --- | ---: | ---: | ---: |
| TodoMVC | 1 | 0.965 / 0.941 | 1.023 / 0.972 |
| TodoMVC | 4 | 0.992 / 0.976 | 0.962 / 0.987 |
| SVGOMG | 1 | 1.281 / 1.091 | 1.277 / 1.009 |
| SVGOMG | 4 | 1.038 / 1.067 | 0.800 / 1.060 |

No cell reaches the declared 20% reduction against both controls in both orders. Retain the SVGOMG regression without inferring a universal cause or slowdown. Suppression markers count capped policy decisions, not avoided background tasks; off-thread code-cache consumption remains available. Independent source review found no blocking source-substitution or thread-ownership defect, but it did identify a stale header description.

Both application-compilation prototypes are now removed from the active native checkout. The restored browser and ten runtime companions match the pre-experiment bytes exactly; six additional launches pass twelve fresh application contexts, including obsolete flags with a nonexistent manifest. Tested patches, runtimes and failed or successful historical observations remain separately archived. Neither composition advances, and neither establishes stock-browser performance, final resource admission or the representative 2× objective.

## Matched nine-scenario Linux baseline — October 20

The [current-source baseline](../benchmarks/results/matched-nine-scenario-linux-2026-10-20.json) runs all nine declared scenarios on commit `784fe47b`: six controlled families, TodoMVC, SVGOMG and the real-service backend corpus. Both engines use stock full Chrome 148.0.7778.96 and Bun 1.4.2, with Playwright 1.60.0 as reference. All 72 captures share browser/driver identities. Across the campaign, 8,230 distinct selected source/dependency files stayed unchanged, with matching hashes wherever an input was repeated. The second block reverses both scenario-group and per-group execution order. This is a fresh diagnostic comparison, separate from the historical mixed-revision retained-evidence drafts.

Each complete interval starts at native command launch and ends after terminal waits, natural descendant drain and final cgroup counters. It includes fixture/service startup, runner startup, tests, diagnostics and shutdown; backend runs start fresh PostgreSQL, Mailpit and API processes inside that interval. Input hashing and the outside collector are excluded. Every capture receives a four-CPU quota, 8 GiB charged-memory limit and zero swap on the same Linux x64 host. The host exposes six logical CPUs on an AMD Ryzen 9 7900X3D and 32.7 GB physical memory; this is a shared controlled host, without an exclusive reservation or CPU pinning.

Ratios are **Flashwright time / Playwright time**; below 1 means faster. Medians contain only two complete-launch observations per engine/cell. No confidence interval or causal slowdown claim follows from these samples.

| Scenario | Workers | Playwright median (s) | Flashwright median (s) | FW / PW, blocks A / B |
| --- | ---: | ---: | ---: | ---: |
| application-backend-corpus | 1 | 49.374 | 48.328 | 0.989 / 0.969 |
| application-backend-corpus | 4 | 21.709 | 21.725 | 1.000 / 1.001 |
| application-svgomg | 1 | 2.296 | 2.322 | 1.015 / 1.008 |
| application-svgomg | 4 | 2.523 | 2.826 | 1.063 / 1.179 |
| application-todomvc | 1 | 4.547 | 4.750 | 1.080 / 1.009 |
| application-todomvc | 4 | 3.249 | 3.263 | 1.027 / 0.982 |
| runner-assertion | 1 | 1.560 | 1.696 | 1.082 / 1.093 |
| runner-assertion | 4 | 1.458 | 1.591 | 1.083 / 1.101 |
| runner-backend | 1 | 2.741 | 2.813 | 1.030 / 1.022 |
| runner-backend | 4 | 2.423 | 2.589 | 1.053 / 1.085 |
| runner-failure | 1 | 9.735 | 10.550 | 1.087 / 1.080 |
| runner-failure | 4 | 3.932 | 4.403 | 1.087 / 1.152 |
| runner-interaction | 1 | 2.318 | 2.525 | 1.158 / 1.019 |
| runner-interaction | 4 | 2.487 | 2.418 | 0.918 / 1.029 |
| runner-navigation | 1 | 1.669 | 1.725 | 1.034 / 1.033 |
| runner-navigation | 4 | 1.534 | 1.564 | 1.028 / 1.012 |
| runner-setup | 1 | 1.551 | 1.633 | 1.047 / 1.059 |
| runner-setup | 4 | 1.458 | 1.560 | 1.067 / 1.073 |

All 1,456 original outcomes verified: 1,336 passes and 120 intended failures with their 120 failure documents. No unexpected outcome occurred, and no capture was rerun. All 72 groups drained without caller-forced cleanup. The stricter native clean-teardown flag was true in 8 captures; the supervisor consumed 1,225 exited adopted descendants across the campaign. Those original distinctions and wait costs are retained, not relabelled as clean teardown.

**None of the 18 scenario/worker cells reaches 2× in both observed blocks.** The unchanged stock-browser implementation therefore has no demonstrated route to the representative 2× target from this baseline. Kernel charged CPU and memory are retained per run; charged memory is not simultaneous RSS, and cache charging can vary. Reviewed final Linux admission joins, eight independent pairs per cell, current release gates, other-platform coverage and broad competitor acceptance remain open. Raw originals and private harness receipts remain locally retained; this export is not a portable sealed release campaign.

## Earlier Linux controlled-family baseline

The [exit-notification baseline](../benchmarks/results/watchdog-notification-controlled-linux-2026-10-18.json) runs the six original controlled workload families through both native runner adapters on stock full Chrome 148.0.7778.96 and Bun 1.4.2. Both engines receive the same four-core CPU quota, 8 GiB memory limit, zero swap and artifact policy. Each launch includes 15 fresh-context test executions, preparation, runner startup, default failure diagnostics and cleanup.

The table shows Playwright elapsed time divided by Flashwright elapsed time, measured from original owner launch through its terminal wait. Greater than 1 means Flashwright is faster. The two blocks reverse execution order; they are individual observations, not confidence bounds.

| Controlled family | Workers | First block | Reversed block |
| --- | ---: | ---: | ---: |
| interaction | 1 | 0.812× | 1.021× |
| interaction | 4 | 0.965× | 0.995× |
| assertion | 1 | 1.196× | 0.922× |
| assertion | 4 | 0.945× | 0.885× |
| navigation | 1 | 0.973× | 0.981× |
| navigation | 4 | 0.868× | 1.007× |
| setup | 1 | 1.005× | 0.901× |
| setup | 4 | 0.911× | 0.860× |
| backend | 1 | 0.983× | 1.008× |
| backend | 4 | 0.956× | 1.002× |
| failure | 1 | 0.943× | 0.919× |
| failure | 4 | 0.977× | 0.941× |

All 48 launches completed 720 test executions: 600 passed and 120 produced their intended failure outcomes, with zero unexpected failures. No cell reaches 2× in both blocks. These controlled fixtures do not replace the application corpus or the final competitor campaign.

This matrix follows a measurement correction: Linux process-exit notification now wakes the supervisor without waiting for its 100 ms resource-sampling sleep. Twenty-four short-process controls reduced median final-event-to-wait delay from 52.6 ms to 1.7 ms. That is improved observation precision, not an engine speedup. The earlier 48-launch polling-based matrix remains separately retained in the same result file. Neither matrix establishes complete process/resource custody or final performance acceptance.

## Latest measured broad comparison

Eight rotated blocks ran on native macOS arm64 with full Chrome 148.0.7778.96. Bun 1.4.2 coordinated the run; every shared library workload used Node 22.22.0. Each library flow has three warmups and 12 measured observations per launch. Complete work includes preparation, warmup, semantic verification and cleanup; child process wall also includes imports and the sampling wrapper. Brackets below are 95% launch-clustered intervals.

| Engine | Version | Class | Startup ms | Complete ms | Child process wall ms | CPU s | Median launch peak RSS MiB | Maximum sampled RSS MiB | Failures |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| flashwright | development checkout | library-flow | 500.5 [413.2, 829.1] | 8478.8 [8317.0, 8872.5] | 9117.7 [8722.9, 9551.5] | 8.12 [7.79, 8.37] | 946.9 [942.6, 950.2] | 951.4 | 0 expected, 0 unexpected |
| playwright | 1.60.0 | library-flow | 523.2 [375.1, 579.7] | 8423.6 [8264.4, 9110.7] | 8940.3 [8715.8, 9493.2] | 8.87 [8.37, 8.95] | 930.9 [927.0, 936.2] | 937.0 | 0 expected, 0 unexpected |
| puppeteer | 25.13.0 | library-flow | 433.1 [386.2, 456.4] | 8695.8 [8409.2, 8806.2] | 8954.7 [8721.0, 9119.4] | 7.90 [7.68, 8.20] | 862.6 [853.6, 865.3] | 865.5 | 0 expected, 0 unexpected |
| cypress | 16.1.1 | runner-outcome | Not isolated | 17516.8 [16923.2, 18682.0] | 17833.5 [17297.0, 19002.1] | 25.45 [24.13, 26.00] | 1876.1 [1801.5, 1924.9] | 1932.0 | 120 expected, 0 unexpected |
| webdriverio | 10.0.2 | library-flow | 1824.4 [1670.4, 1911.3] | 53807.8 [53270.8, 55482.8] | 54073.2 [53450.5, 55783.5] | 66.86 [66.36, 69.56] | 2179.1 [2117.4, 2845.5] | 2855.2 | 0 expected, 0 unexpected |
| Bun.WebView | Bun 1.4.2 | separate Linux native observations | Unmeasured in this matrix | Unmeasured in this matrix | Unmeasured in this matrix | Unmeasured in this matrix | Unmeasured in this matrix | Unmeasured in this matrix | See native table below |

The Bun.WebView row was added after the historical five-engine run; it supplies no comparative measurements. Its Linux probe retains both the initial text-replacement failure and a subsequent complete outcome run using native Home/Shift+End selection. All seven categories completed twice, with two intended missing-selector failures and two real backend requests. Native input was trusted, but disabled-button clicks returned successfully after pointerdown, duplicate selectors selected the first match, and views shared cookies/localStorage. Fresh-view setup, native click-timeout diagnostics and SIGKILL-based browser shutdown remain distinct from the reference contracts. The process collector also rejected clean custody because it adopted four descendants. These observations cannot support a speed ranking.

The [Bun.WebView close probe](../compatibility/evidence/bun-webview-close-checkpoint-2026-10-17.json) verifies that raw `view.cdp("Browser.close")` resolves and rejects pending evaluations on the pinned native Linux backend. Twelve controls compare it with native closeAll, with and without pending work. Waiting for the original browser PID/start identity to disappear avoids browser-root adoption in the eight later controls, but every capture still fails the collector's clean-custody policy for adopted descendants; nine captures require collector termination of survivors. Preserve those interventions. Neither a CDP response nor view closure establishes complete process drain or CPU ownership. The native adapter remains unchanged, with no equivalent-work, resource or performance admission.

The four library-flow rows and Cypress runner-outcome row do not perform equivalent complete work. Puppeteer and WebdriverIO retain different input counts and failure diagnostics; WebdriverIO also retains its native ChromeDriver launch policy. Cypress uses synthetic input, its proxy/runner and per-test storage reset. Its 120 intentional failures remain actual failed tests. The complete table preserves all these distinctions; the numbers do not establish an overall ranking.

This frozen source precedes matcher accessibility diagnostics in `1a49a790`. The measured failure fixture checks method/selector text, not the full error context or automatic failure document. Those newer diagnostics need a fresh measurement after their own acceptance gates. Native Linux, contention and representative matched runner suites remain unverified.

## Bun.WebView native Linux observations

The [native sampling checkpoint](../benchmarks/results/bun-webview-native-linux-2026-10-21.json) adds eight independent Bun 1.4.2 launches using stock Chromium headless shell 148.0.7778.96. Each launch rotates the seven categories and records three warmups and twelve measured operations per category: 672 measured operations and 168 warmups in total. One preceding native control is retained separately. All outcomes, trusted-input assertions and independent HTTP counts pass; every measurement launch makes 36 document requests and 15 backend requests.

| Native category | Median of launch medians, ms | 95% launch-bootstrap interval, ms |
| --- | ---: | ---: |
| Evaluate constant | 0.113 | 0.097–0.153 |
| Click and text assertion | 16.688 | 16.639–16.697 |
| Delayed text assertion | 8.251 | 8.246–8.256 |
| Navigation and assertions | 3.783 | 3.736–3.906 |
| Fresh view, navigation, assertion and close request | 15.130 | 14.858–17.340 |
| Native text replacement, save and backend assertion | 49.994 | 49.933–50.023 |
| Missing-selector native click timeout | 33.331 | 33.328–33.335 |

Median complete command time through observed descendant drain is **2788.7 ms [2493.9, 2833.2]**. This includes all categories, warmups, preparation, verification, executable/source checks, fixture startup, report serialization and shutdown. Hashing warms file caches; this is not a cold-start result. Operation samples do not include the other categories or all launch costs. With 96 measured operations per category, the configured tail-sample minimums are not met.

These values belong to a separate native class, not the macOS comparison above. Views share storage, native launch flags and readiness differ, text uses an explicit MutationObserver helper, backend replacement uses native selection keys, and the missing-selector click is not the reference assertion failure. Native `closeAll()` force-kills Chrome. All eight original wrapper exits are zero and descendants drain without collector intervention, but the collector adopts four descendants per launch and rejects strict clean custody. Cgroup charged memory/CPU remain separately labelled observations, not admitted RSS or whole-tree CPU metrics. No cross-engine ratio or leadership claim follows from this table.

The new sampler and verifier are `benchmarks/bun-webview-sampling.mjs` and `tools/verify-bun-webview-sampling.mjs`. Run them with the pinned Bun runtime, an explicitly selected `FLASHWRIGHT_BROWSER_PATH`, a fresh report path and launch index 0–7. The sample verifier checks outcomes and selected source/runtime hashes; the external native collector must independently verify exits and drain. Retained measured source bytes precede one metadata-only correction clarifying that setup samples include their close requests; numeric boundaries were unchanged and no workload was rerun.

## Paired analysis of the broad blocks

[Recomputed paired results](../benchmarks/results/broad-matrix-2026-10-10-paired.json) use the same eight blocks, with each Playwright/Flashwright pair identified by its block index. The engines are not always adjacent. Values are milliseconds; ratios above 1 favor Flashwright.

| Metric | Playwright ms | Flashwright ms | Paired ratio | 95% interval |
| --- | ---: | ---: | ---: | --- |
| Complete run | 8423.648 | 8478.787 | 0.997 | 0.941–1.028 |
| Process wall | 8940.302 | 9117.717 | 1.004 | 0.940–1.022 |
| Cold browser launch | 523.215 | 500.461 | 0.946 | 0.556–1.334 |
| Noop | 0.337 | 0.318 | 1.035 | 0.740–1.587 |
| Interaction | 16.582 | 16.461 | 1.006 | 0.994–1.016 |
| Assertion | 25.554 | 10.657 | 2.423 | 2.276–2.438 |
| Navigation | 57.380 | 55.935 | 1.027 | 0.982–1.056 |
| Setup | 236.414 | 243.937 | 0.968 | 0.929–1.041 |
| Backend | 47.100 | 41.835 | 1.129 | 1.010–1.180 |
| Failure | 24.775 | 26.554 | 0.929 | 0.913–0.936 |

The complete-run estimate is unresolved: 0.997× with an interval spanning 0.941–1.028×. It fails the predeclared 10% material improvement target. Failure median latency breaches the 5% regression limit; observed maxima breach the 15% limit for interaction, setup, backend and failure. These maxima are individual observations, not population-tail estimates. Memory remains within policy. No p95/p99 claim follows from this sample count.

Setup accounts for about 44.0% of Flashwright complete time. Its delayed assertion flow is about 2.42× faster, but that gain does not produce a faster complete run. The paired CPU ratio is 1.072 with interval 1.039–1.117; sampled process-tree memory is slightly higher for Flashwright. The watchdog may miss short-lived or already-reparented processes.

The [portable manifest](../benchmarks/results/broad-matrix-2026-10-10/manifest.json) retains all 437 original files by original/exported hashes. Every numeric JSON/JSONL observation and the complete table remain unchanged. Core stdout may intentionally contain malformed protocol bytes; the exporter preserves those bytes outside exact path substitutions. The original and portable matrices pass the same recorded-source verifier. Paired analysis is byte-identical across Bun 1.4.2 and Node 22.22.0/24.15.0.

To recheck, retain or recreate the exact `70dc299f` checkout and its locked dependencies, then run from this checkout:

```sh
bun tools/broad-matrix-snapshot.mjs verify benchmarks/results/broad-matrix-2026-10-10 /absolute/path/to/recorded-checkout
bun tools/analyze-broad-pair.mjs benchmarks/results/broad-matrix-2026-10-10/evidence /absolute/path/to/recorded-checkout .cache/new-paired-analysis.json
```

The verifier deliberately uses the recorded checkout. These commands verify retained evidence; they do not verify current executable bytes or accept newer source revisions. The [export procedure](broad-matrix-export.md) describes custody and normalization.

## Earlier Bun paired baseline (`41cbdcea`)

The [measured checkpoint](../compatibility/evidence/current-performance-checkpoint-2026-10-10.json) passes all 144 core groups at 851 source hashes matching commit `41cbdcea`. The subsequent [16-launch snapshot](../benchmarks/results/current-paired-2026-10-10/summary.json) passes independent verification before and after path normalization. Both engines use Bun 1.4.2 and the same full Chrome 148.0.7778.96 executable and launch policy on the shared native Apple M3 Pro macOS host. This is one worker, seven library flows and artifacts off.

The subsequent [Download checkpoint](../compatibility/evidence/downloads-checkpoint-2026-10-10.json) passes 156 functional core groups. Those changes were not measured at that checkpoint; the newer Node22 broad comparison above includes them. The following Bun table applies to the earlier revision only. Native Linux measurements remain unverified.

Times below are milliseconds, expressed as medians of independent-launch medians. Each operation has 96 measured observations across eight launches, plus three warmups per launch. Ratios are paired Playwright/Flashwright values; above 1 favors Flashwright. Confidence intervals use the predeclared launch-clustered bootstrap. Complete runs include preparation, warmup, semantic verification and cleanup; process wall also includes runtime imports and the sampling wrapper.

| Metric | Playwright ms | Flashwright ms | Paired ratio | 95% interval |
| --- | ---: | ---: | ---: | --- |
| Complete run | 8075.777 | 7873.119 | 1.019 | 1.001–1.036 |
| Process wall (imports and wrapper included) | 8450.858 | 8311.049 | 1.014 | 0.988–1.037 |
| Cold browser launch | 378.876 | 386.064 | 0.975 | 0.941–1.143 |
| Noop | 0.244 | 0.282 | 0.874 | 0.705–1.059 |
| Interaction | 16.522 | 16.492 | 1.003 | 0.994–1.007 |
| Assertion | 25.080 | 10.401 | 2.401 | 2.349–2.513 |
| Navigation | 54.562 | 53.570 | 1.008 | 0.973–1.070 |
| Setup | 231.069 | 234.431 | 0.990 | 0.936–1.013 |
| Backend | 41.745 | 41.663 | 1.002 | 0.993–1.028 |
| Failure | 24.492 | 25.841 | 0.949 | 0.941–0.957 |

Median sampled process-tree CPU was 8.30 seconds for Playwright and 7.60 for Flashwright. Maximum sampled concurrent RSS was 944.59 MiB and 919.42 MiB respectively; the memory policy passes. These resource observations include the descendant tree, with the watchdog's documented risk of missing short-lived or reparented children.

The paired complete-run estimate is about 1.9% less elapsed time, below the configured 10% target. Noop and failure medians still breach the regression policy; no observed maximum does. All launches complete with zero unexpected failures and clean owned-process exit. There are too few independent launches for p95/p99 claims. The setup workload accounts for about 45.7% of Flashwright complete time, supporting further setup and preparation research. This snapshot does not rank the broader contender set or complete runner-suite, contention, native Linux or release gates.

The separate [four-launch instrumented profile](../benchmarks/results/current-attribution-2026-10-10/summary.json) also passes independent verification. Flashwright sends 1,048–1,049 browser commands per launch versus Playwright’s 2,189–2,280. Flashwright’s setup-phase median target-creation acknowledgements take about 75–78ms, `Page.enable` about 55–56ms, and navigation about 41–44ms. These intervals include proxy, transport and scheduling costs and can overlap; they do not isolate browser CPU. Instrumented observations are excluded from the ordinary timing table.

Recheck exported observations with `bun tools/verify-paired.mjs benchmarks/results/current-paired-2026-10-10`. The [core report and logs](../compatibility/evidence/current-core-2026-10-10/report.json) bind the measured binary, sources and browser. Original and normalized hashes are recorded in the checkpoint; numeric observations are unchanged.

## Puppeteer functional admission

The [admission checkpoint](../compatibility/evidence/competitor-admission-checkpoint-2026-10-10.json) records exact browser flags, package/dependency bytes, application outcomes, context isolation and watchdog cleanup. The [retained reports](../benchmarks/results/competitor-admission-2026-10-10/manifest.json) include all four Node passes and the failed Bun attempt, with workstation paths normalized. This run uses the existing real HTTP fixture and seven flow categories. It retains elapsed observations for diagnosis, but those observations are excluded from comparative performance acceptance. Partial reports survive unexpected failures, and a failure stops the remainder of that admission attempt.

Puppeteer uses its native locators with ordinary viewport, visibility, enabled and stability checks. ARIA selectors find buttons and the labelled input. The small text/title predicate helper uses `page.waitForFunction` with mutation polling; it is specific to these unique, plain-text fixture targets. It does not implement general Playwright assertions. These choices follow the available [locator APIs](https://pptr.dev/guides/page-interactions) and [waitForFunction API](https://pptr.dev/api/puppeteer.frame.waitforfunction).

Two differences prevent treating the complete seven-flow run as equivalent work:

- Native fill emits 126 trusted input events across 15 backend iterations; the reference fill contract expects 15. Both produce the expected saved values and backend requests, but applications can observe the different event sequence.
- The missing-element case uses Puppeteer's native visibility-selector timeout. It does not perform the same diagnostic work as a failing Playwright assertion.

The admitted Node configurations cover Chromium 148.0.7778.96 headless shell and full Chrome. The Puppeteer package version is independently pinned; this local fixture evidence is not a claim that all of its APIs support that older browser revision. Bun remains the dependency installer and harness host. The tested Puppeteer locator interaction times out when the browser workload itself runs on Bun 1.4.2; retained Node execution passes. The exact cause of that runtime-specific behavior is unresolved.

To reproduce, use Bun 1.4.2, the separately installed pinned browser and Node 22.22.0 or 24.15.0. Install the competitor in an isolated directory so it cannot change the project dependency graph:

```sh
competitor_directory="$(mktemp -d)"
cp benchmarks/competitors/puppeteer/package.json benchmarks/competitors/puppeteer/bun.lock "$competitor_directory/"
(cd "$competitor_directory" && bun install --frozen-lockfile --ignore-scripts)
export FLASHWRIGHT_COMPETITOR_DIRECTORY="$competitor_directory"
export FLASHWRIGHT_COMPETITOR_RUNTIME="$(command -v node)"
export FLASHWRIGHT_BROWSER_PATH="/absolute/path/to/pinned/chromium"
bun tools/run-competitor-admission.mjs .cache/new-competitor-admission
bun test ./tools/test-competitor-contract.mjs
```

The output directory must be new. The harness records every installed dependency file, selected browser and harness input before execution, verifies they remain unchanged, and rejects missing work, untrusted events, leaked storage or processes, altered launch flags and obsolete resource accounting. The raw reports and final admission decision are retained together.

## WebdriverIO functional admission

WebdriverIO uses its native WebDriver BiDi commands through ChromeDriver 148.0.7778.96. Separate BiDi user contexts provide cookie/localStorage isolation. Native ARIA element commands perform clicks and typing; fixture-specific text/title checks use `waitUntil` with its ordinary 500ms polling interval. The missing-element flow uses `waitForDisplayed`. These are application-outcome checks, not general Playwright assertion or actionability parity.

ChromeDriver adds automation/logging switches, disables two additional features and creates its bootstrap page. The reference `--no-startup-window` switch is removed. The [declared driver policy](../benchmarks/configurations/webdriverio-launch-policy.json) and actual launch arguments remain visible; launch-policy equivalence is explicitly false. Native typing emits 126 trusted input events over 15 saves, and failure diagnostics differ. Complete equivalent-work performance remains unmeasured.

The [WebdriverIO checkpoint](../compatibility/evidence/webdriverio-admission-checkpoint-2026-10-10.json) and [retained reports](../benchmarks/results/webdriverio-admission-2026-10-10/manifest.json) cover native protocol negotiation, browser/driver/runtime/dependency hashes, request and input counts, isolation and cleanup. Verbose ChromeDriver protocol logging is enabled for this admission audit, so timings and resource observations are diagnostic only. The large protocol logs remain private by hash; exported samples retain actual launch arguments and all numeric observations. Earlier failed probes and the Node package-metadata lookup failure remain recorded in the checkpoint.

For macOS arm64 reproduction, install `benchmarks/competitors/webdriverio/package.json` and its `bun.lock` into a new isolated directory with `bun install --frozen-lockfile --ignore-scripts`, as in the Puppeteer example. Obtain ChromeDriver 148.0.7778.96 from the matching [Chrome for Testing manifest](https://googlechromelabs.github.io/chrome-for-testing/148.0.7778.96.json), and compare its archive/executable hashes with the checkpoint. Set `FLASHWRIGHT_COMPETITOR_DIRECTORY`, `FLASHWRIGHT_BROWSER_PATH` and `FLASHWRIGHT_CHROMEDRIVER_PATH`, then run:

```sh
bun tools/run-competitor-admission.mjs .cache/new-webdriverio-admission webdriverio
```

Bun is the default workload runtime; `FLASHWRIGHT_COMPETITOR_RUNTIME` selects an absolute Node executable for compatibility checks. Supplying both browser and driver paths prevents automatic browser/driver selection, as described by WebdriverIO's [driver setup documentation](https://webdriver.io/docs/driverbinaries). Its [protocol documentation](https://webdriver.io/docs/automationProtocols) explains BiDi negotiation; the verifier rejects fallback to classic WebDriver.

With the snapshot's recorded source checkout, verify exported hashes and independently recheck every functional admission using `bun tools/verify-competitor-snapshot.mjs benchmarks/results/webdriverio-admission-2026-10-10`. This verifier intentionally rejects changed source bytes and does not confer performance acceptance.

## Cypress runner outcome admission

The macOS arm64 checkpoint runs Cypress 16.1.1 with 105 ordinary isolated runner tests on Bun 1.4.2, Node 22.22.0 and Node 24.15.0 with full Chrome 148.0.7778.96. Each run produces 90 passes and 15 intentional missing-element failures, with no unexpected failures or skipped tests. The failure cases remain actual runner failures. Each run makes 120 fixture document requests and 15 real backend requests, verifies cookie/local/session storage reset, and finishes with clean process cleanup.

The [checkpoint](../compatibility/evidence/cypress-admission-checkpoint-2026-10-10.json) and [retained reports](../benchmarks/results/cypress-admission-2026-10-10/manifest.json) include every test, event count, duration and resource observation. The first attempt failed in the harness's process-capture hook; that failed report is retained. Source, installed dependency, complete Cypress application bundle, browser and runtime bytes are recorded and checked before and after each run.

Default `click` and `type` dispatch untrusted events here. Cypress's native proxy, launch policy and per-test storage reset differ from the native-input, fresh-context library flows. Every case includes runner page preparation. Proposed launch options and the owned browser command are recorded separately. These are outcome-admission results; equivalent-operation admission and performance acceptance remain false. This follows Cypress's documented [event behavior](https://docs.cypress.io/app/core-concepts/interacting-with-elements), [test isolation](https://docs.cypress.io/app/core-concepts/test-isolation) and [browser launch hook](https://docs.cypress.io/api/node-events/browser-launch-api).

For macOS arm64 or Linux x64 reproduction, copy `benchmarks/competitors/cypress/package.json` and `bun.lock` into a new isolated directory and run `bun install --frozen-lockfile --ignore-scripts`. Explicitly install the pinned Cypress binary using its CLI with an owned `CYPRESS_CACHE_FOLDER`, as described in [advanced installation](https://docs.cypress.io/app/references/advanced-installation). Set `FLASHWRIGHT_COMPETITOR_DIRECTORY` to that dependency directory, `FLASHWRIGHT_CYPRESS_BUNDLE` to its `16.1.1/Cypress.app` on macOS or `16.1.1/Cypress` on Linux, and `FLASHWRIGHT_BROWSER_PATH` to full Chrome 148.0.7778.96. Run:

```sh
bun tools/run-cypress-admission.mjs workbench/new-cypress-admission
bun test ./tools/test-cypress-contract.mjs
bun tools/test-cypress-linux.mjs
bun tools/verify-cypress-snapshot.mjs benchmarks/results/cypress-admission-2026-10-10
bun tools/verify-competitor-snapshot.mjs benchmarks/results/cypress-admission-2026-10-10/regressions
```

`FLASHWRIGHT_COMPETITOR_RUNTIME` selects an absolute Node executable; Bun is the default. The snapshot verifier needs its recorded source checkout and checks normalized exported bytes independently. The expanded Cypress configuration stays private by hash because it contains environment-specific configuration; the public curated report preserves every test and observation. The retained macOS snapshot remains platform-specific. Headless shell remains unmeasured for this Cypress class.

On Linux, install Xvfb and the X11 client library used by Python's `ctypes` readiness check. The harness selects native `Xvfb` from PATH, or an absolute executable through `FLASHWRIGHT_XVFB_PATH`; shell wrappers are rejected. If that executable needs a private library directory, set `FLASHWRIGHT_XVFB_LIBRARY_PATH`. The harness hashes the selected display executable and private libraries before and after the run and applies that private library path only to Xvfb. It creates an owned display and isolated HOME/XDG directories, waits for both original children, and rejects forced cleanup or leftover display sockets.

The Linux collector preserves either the exact NUL-separated command bytes or Chromium's rewritten process title. A rewritten title cannot prove original argument boundaries. Linux Chromium can overwrite the original environment storage when rewriting that title; the harness verifies the exact source-defined overwritten bytes and runner launch environment, while explicitly leaving the relocated live browser environment unobserved. Paths containing spaces and browser symlink selections are supported; ambiguous flag-delimiter text inside rewritten-title paths is rejected.

The [native Linux checkpoint](../compatibility/evidence/native-linux-cypress-checkpoint-2026-10-16.json) records two complete Bun runs with 105 tests each: 90 passes, 15 intended failures, no skipped or unexpected failures, and clean shutdown. The final run verifies the source and retained output hashes after the byte-comparison correction. It exercises a Chrome symlink and an output directory containing a space. Node 22 is covered by synthetic rejection controls only.

Linux support here is the standalone outcome-admission command. The broad matrix coordinator and historical snapshot verifier still select the macOS launch policy and have not been admitted for Linux. Passing this command establishes neither equivalent native input/fresh-context behavior nor comparative performance.

## Backend application functional gates

The [backend functional checkpoint](../compatibility/evidence/backend-corpus-functional-checkpoint-2026-10-11.json) records the original 62 tests from pinned `fastapi/full-stack-fastapi-template` commit `7257e606cb94eada1dca40173e2b7f99dd549bc6`, including auth setup. Test and helper bodies are unchanged. Both engines used Bun 1.4.2 and full Chrome 148.0.7778.96 on native macOS arm64, with fresh PostgreSQL 18.4, Mailpit and four FastAPI server workers.

| Engine / execution class | 1 test worker | 4 test workers |
| --- | --- | --- |
| Playwright 1.60.0 / installed reference functional check | 62 passed; no skips or retries | 62 passed; no skips or retries |
| Flashwright / development alias functional diagnosis only | 62 passed; no skips or retries | 62 passed; no skips or retries |
| Flashwright / selected packed alias, installed release-build driver | 62 passed; no skips or retries | 62 passed; no skips or retries |

The first candidate run had 61 passes and one navigation failure in the reset-password link flow. Its original evidence remains retained. A navigation repair prevented an outgoing same-document event from interrupting `page.goto('/login')`; subsequent fresh runs passed. The failed development-diagnosis run used a release driver; its repaired development-alias passes used a development/debug driver. These functional cells cannot supply a speed comparison. Successful runs retained unchanged bound inputs, clean observed process shutdown and temporary-state removal. Reported overlap does not establish complete owned worker/resource coverage.

The development-alias cells are single functional launches using then-unmerged request source. The reference cells used installed Playwright 1.60.0. These earlier functional cells do not establish packed installation, shipped public request support, release acceptance or comparative performance. Raw evidence remains private; the checkpoint publishes identities, hashes, outcomes and limits. All functional runs used trace/video/screenshots off. The draft final-goal backend policy still selects `on-first-retry` tracing and requires fresh admission and measurements before sealing. Historical numeric tables above are unchanged. Native Linux remains unverified.

The later [packed backend checkpoint](../compatibility/evidence/backend-corpus-packed-checkpoint-2026-10-11.json) independently matches all original 62 test IDs, titles, files and lines at both worker counts. One fresh packed alias test consumer retained 118 unchanged frontend files and a declared test-only `package.json` adaptation. It used the actual common prebuilt frontend, fresh PostgreSQL 18.4/Mailpit 1.31.4 state, four FastAPI server workers and the installed release-build driver. Two driver spawn/clean-close pairs at one worker and five at four workers were retained; all 7,724 frozen files and nine exact tree inventories stayed unchanged. This admits the selected packed backend functionality only. Current full-core, native Linux, release publication and performance acceptance remain pending. Original failed evidence and historical numeric tables remain unchanged.

## Remaining comparison work

Actual runner startup, retries, hooks, artifacts and parallel execution still need representative suite comparisons across the declared contenders.

To reproduce the historical comparisons, verify the recorded Flashwright binary and sources, run matched independent launches with rotated execution order, and apply the [predeclared statistical and regression policy](../benchmarks/configurations/baseline.json). Include complete preparation and cleanup, uncertainty, CPU/concurrent memory, unexpected failures and contention. A functional pass, one favorable run or a different input contract does not satisfy that gate.

Current goal acceptance follows the [draft final-goal contract](../benchmarks/configurations/final-goal.json). Its nine scenarios each have two worker cells; all 18 cells remain unmeasured for final admission, and the contract remains unsealed. Native Linux remains unverified.

Linux resource measurement is under development. The [policy and namespace checkpoint](../compatibility/evidence/linux-cgroup-policy-checkpoint-2026-10-16.json) verifies a bounded reader for visible ancestor restrictions and a namespace wrapper compatible with Bun.WebView's native Chrome launch. It retains the browser's storage/action differences and rejection for four adopted descendants. Cgroup CPU, terminal-wait CPU and sampled memory remain distinct observations; this checkpoint adds no comparative timing results or resource admission.

For diagnostic Linux captures, `tools/linux_cgroup_capture.py` joins the declared input inventory, visible ancestor policies and native cgroup receipt. Its caller must first create a fresh delegated leaf with CPU/memory accounting, keep the supervisor outside that leaf, and own an independent outer deadline and service/group cleanup. Build `tools/linux-cgroup-command.c` as described in its header, then invoke the coordinator with absolute paths:

```sh
python3 -B tools/linux_cgroup_capture.py \
  --leaf "$FRESH_CGROUP_LEAF" --collector "$NATIVE_COLLECTOR" \
  --inputs "$CAPTURE_INPUT_REQUEST" --output "$FRESH_WORKBENCH_DIRECTORY" \
  --timeout-ms 30000 -- "$BUN_EXECUTABLE" "$WORKLOAD_SCRIPT"
```

The input request uses the existing `CaptureContext.collect_inputs` schema described in SPECS S6. Output contains exclusive before/after snapshots, stdout/stderr, the unchanged native receipt and `capture.json`. Input/tool hashing happens outside the command interval. The original Python wait belongs to the collector; the native wait belongs to bubblewrap, which launches the declared runtime. Neither CPU receipt becomes a complete tree total. A coordinator exit of zero means the diagnostic evidence was captured: a workload exit of seven or a native timeout can still be recorded successfully. Read the separate wrapper exit, timeout, adoption and clean-teardown fields. Changed inputs/policies or a missing original wait reject the capture. Every receipt remains unadmitted for resources and performance; the caller must still stop its owned service and remove the original cgroups, including after rejected captures.

The [integration checkpoint](../compatibility/evidence/linux-cgroup-capture-checkpoint-2026-10-16.json) retains 16 host tests, six final native controls and the earlier attempts. The browser smoke passes, while its fourteen adopted descendants remain a failed teardown condition. No comparative timing samples were collected.

The later [application accounting checkpoint](../compatibility/evidence/linux-application-cgroup-checkpoint-2026-10-16.json) connects the capture to actual complete application work: 24 TodoMVC and six SVGOMG tests pass on each engine. Fixture startup/shutdown and runner execution are inside the measured group. Declared outputs are hashed at capture completion; the verifier independently reconstructs the original corpus and engine entrypoints. All four groups drain without collector killing, with three already-exited adopted descendants each. The native clean flag remains false, while the separate drained-membership observation is true. This distinction permits reading the kernel charges without pretending that terminal-wait CPU covered the whole tree.

Read those observations with `python3 -B tools/linux_cgroup_resources.py CAPTURE_DIRECTORY/capture.json`. Its CPU fields are cgroup microseconds; memory is kernel charged peak, including cache-ownership effects, rather than simultaneous process RSS. These metrics follow the [kernel cgroup interfaces](https://docs.kernel.org/admin-guide/cgroup-v2.html). The macOS wait/RSS adapter remains separate. The application checkpoint is a functional integration check with one execution per cell, not repeated comparative sampling or a speed ranking.

The experimental [broad matrix coordinator](../benchmarks/broad-matrix.mjs) prepares eight independent launches for its original five engines. Bun.WebView is declared but not yet implemented by this coordinator. Inspect its requirements without starting a browser:

```sh
bun benchmarks/broad-matrix.mjs --plan
bun benchmarks/broad-matrix.mjs --plan --sample-library
bun test ./tools/test-broad-matrix.mjs
```

Its default collection mode repeats the existing admission probes. Puppeteer and WebdriverIO retain per-iteration report writes and an extra isolation probe; WebdriverIO also retains verbose protocol logging. Cypress measures its ordinary isolated runner tests and records intentional failures. These are diagnostic engineering observations, excluded from broad equivalent-work speed claims. Representative matched runner suites remain necessary for a production comparison.

Puppeteer and WebdriverIO also have a separate library sampling mode. Append an independent-launch index to the admission wrapper, for example `bun tools/run-competitor-admission.mjs .cache/new-puppeteer-sample puppeteer 3`. It rotates the workload order using the same index as the reference, preserves native readiness and all outcome checks, omits the extra isolation probe, and writes the retained report in the parent after the child exits. Browser/driver binary verification also runs in the parent. WebdriverIO uses warning-level ChromeDriver logs and observes the owned browser process's launch command once during startup. These startup observations and final workload telemetry remain part of complete work. Ordinary admission without an index retains its original diagnostic behavior.

A sampling receipt reports `samplingOutcomesPassed`, while `functionalAdmissionPassed` and `performanceAccepted` remain false. Separate current-source isolation admission is still required. The broad coordinator's `--sample-library` mode runs and retains that admission first for both engines, then binds it to every sample's source, package, runtime and binary identities. Failed admission stops collection before measurements. Admission attempts remain in `admission-progress.json`; their durations and resources are excluded from the sampling table. Incomplete or interrupted sampling runs retain stdout/stderr and watchdog evidence even when no complete JSON report can be parsed.

Independently recheck a sampling run using `bun tools/verify-competitor-sampling.mjs RETAINED_DIRECTORY`. It verifies original source hashes, the retained-file inventory, binary identity records, raw stdout, workload order, outcomes and process cleanup. For WebdriverIO it also checks that the captured browser PID belongs to the watchdog's observed process tree and that the driver log contains no info/debug protocol stream. This verification does not establish a comparative performance result.

For a coordinated run, set `FLASHWRIGHT_BROAD_RUNTIME` to one absolute runtime executable for every measured child, and supply `FLASHWRIGHT_VERIFICATION_REPORT`, `FLASHWRIGHT_DRIVER_PATH`, and `FLASHWRIGHT_BROWSER_PATH` for a passed core report with exactly matching sources, runtime, browser and driver. Install the pinned competitors in separate directories and set `FLASHWRIGHT_PUPPETEER_DIRECTORY`, `FLASHWRIGHT_WEBDRIVERIO_DIRECTORY`, `FLASHWRIGHT_CYPRESS_DIRECTORY`, `FLASHWRIGHT_CHROMEDRIVER_PATH`, and `FLASHWRIGHT_CYPRESS_BUNDLE`. The coordinator itself uses Bun. The initial Cypress adapter requires macOS; native Linux remains unverified.

Only after coordinating exclusive measurement time, run `FLASHWRIGHT_BROAD_RUN=1 bun benchmarks/broad-matrix.mjs --sample-library` for library sampling, or omit the flag for repeated diagnostic admission. Both retain every attempted launch and any failures in a new result directory. Engine order rotates, with Playwright/Flashwright order alternating. All process-wall cells use the common watchdog's child interval, so parent dependency verification does not inflate competitor times. A complete admitted run produces `summary.json` and `table.md`, including all seven workloads, preparation-inclusive totals, launch-clustered uncertainty, sampled CPU and concurrent memory, intentional failures, instrumentation and semantic differences. Cypress startup and preparation-inclusive workload intervals remain explicitly unisolated.

Recheck a collected run using `bun tools/verify-broad-matrix.mjs RETAINED_DIRECTORY` from its recorded source checkout. The verifier checks retained hashes, core logs, runtime/dependency identities, every original semantic admission and the recomputed statistics/table. The retained 40-launch matrix above uses its library sampling mode; it does not establish broad performance leadership. Raw outputs can contain workstation paths and must be normalized and reverified before public retention under S19.i.

## Native runner fixture suite

`bun tools/run-runner-suite.mjs NEW_DIRECTORY playwright|flashwright [LAUNCH_INDEX]` executes one common test source through the selected engine's actual runner. Build the checkout's packages and driver first; set `FLASHWRIGHT_BROWSER_PATH` and `FLASHWRIGHT_DRIVER_PATH`. Bun is the default runtime; `FLASHWRIGHT_RUNNER_RUNTIME` selects an absolute Node executable for compatibility checks. Every copied test body must match the checked-in source hash. The generated import adapter and configuration are recorded separately and checked for changes during execution.

The suite contains 105 ordinary tests with one worker, fresh context/page fixtures, no retries, and trace/video/screenshots off. It covers the seven baseline workload groups, rotates their order by launch index, verifies cookie/local/session storage isolation, and records trusted input and backend request counts. Fifteen missing-element assertions remain actual failed tests with runner exit code 1. They are expected by the outer harness; they are not caught inside tests or converted with `test.fail`. Normal failed-worker restarts and resulting browser launches remain in the complete work and resource totals. Default failure diagnostic attachments are retained and listed explicitly.

The pinned reference emits an `error-context` Markdown snapshot for each of the 15 failed tests. Initial native runner probes produced none for Flashwright. With default failure documents implemented, a [retained 25 ms pair](../compatibility/evidence/runner-diagnostic-stress-checkpoint-2026-10-10.json) produced all 15 documents in both engines, but one Flashwright case had no retained predicate observation and used a later private-AI page snapshot. Its static page content and source linkage were useful; they could not establish equivalent predicate work. The planned matrix stopped after that pair, without performance acceptance.

The complete-runner profile now uses `benchmarks/configurations/runner-suite.json` with a 250 ms failure budget shared by both engines. Every cold context, page and assertion preparation step remains inside complete-suite time. The 25 ms baseline remains unchanged as a separate stress class. Admission requires actual content: every failure must retain its original predicate observation, selector/method/timeout, missing-element result, original user call site, complete common source frame and exact fixture accessibility tree. It rejects later fallback, omissions, borrowed attachments and missing observations. Public diagnostic wording and repeated private call-log lines may differ under SPECS S4.g. These checks are specific to the controlled fixture and do not establish general artifact parity.

The raw JSON reporter retains per-test durations, statuses, errors, annotations and attachments. An afterEach annotation records the operation interval, isolation, native input, viewport, focus, browser version and worker identity. That interval includes the transition into afterEach; complete work also includes fixtures, diagnostic reporting, worker restarts and cleanup. The verifier checks all 105 test identities, all actual failures, original browser launch flags, worker process ownership and watchdog cleanup. The native backend guard remains enabled in Flashwright's configuration and workers. When runner stderr is both forwarded and retained in JSON, both copies must agree before launches are counted. Stderr chunks are reassembled without inserting bytes; terminal control sequences are removed only while parsing, with the raw streams retained. Collection explicitly disables terminal progress rendering.

Run `bun test ./tools/test-runner-family-contract.mjs ./tools/test-runner-suite-contract.mjs ./tools/test-runner-suite-diagnostics.mjs` for corruption checks and `bun tools/verify-runner-suite.mjs RETAINED_DIRECTORY` for independent verification against the recorded source, installed packages, binary identities and actual diagnostic content. The supplemental `diagnosticAdmission` receipt preserves the original conservative outcome-only fields; `performanceAccepted` remains false. This is a controlled fixture suite, not the representative application corpus or a matched comparison with Cypress's synthetic input and per-test reset. Runner startup attribution, representative applications, retries/artifacts/concurrency comparisons and native Linux remain open.


The later [native Linux controlled-family checkpoint](../compatibility/evidence/linux-runner-family-checkpoint-2026-10-20.json) selects each of the six final controlled families from the unchanged workload source. Its 24 functional captures cover both engines at one/four workers: 300 passing tests, 60 actual failed tests, and 60 verified original failure documents. Fixture startup, runner work, diagnostic document retention, fixture shutdown and natural descendant drain are inside the original native command interval. The verifier also checks the actual generated configuration, adapter and runner bytes and stable reported worker slots. The first stderr-parsing failure and two later verifier corrections remain recorded. This is functional and diagnostic evidence, with no timing comparison, callback/native-context custody or final resource admission; the Linux final campaign remains unsealed. The [portable reconstruction checkpoint](../compatibility/evidence/linux-runner-family-portability-checkpoint-2026-10-20.json) verifies the same 24 captures through retained input/output manifests and two complete nine-scenario draft declarations. All 360 reported outcomes and 60 failure documents reconstruct with no historical-path access or new browser execution. The verifier checks exact generated configuration/adapter bytes and rejects changed sources, borrowed captures/documents, malformed inventories and duplicate JSON keys. This adds reproducible evidence loading, without a new timing result or admission claim.

The [retained complete-runner matrix](../benchmarks/results/runner-matrix-2026-10-10/table.md) contains all eight alternating pairs, 840 tests and 120 original failure documents per engine. Every run passed outcome, diagnostic-content and process-cleanup admission. It uses the frozen `dbc58afe` harness, Bun 1.4.2 and full Chromium 148.0.7778.96, with the exact driver from the 179-group core checkpoint. The reviewed harness changes did not change the engine, library, runner or common workload source. This is a separate class from the five-engine library-flow table.

| Complete native runner measurement | Playwright | Flashwright |
| --- | ---: | ---: |
| Median complete suite time | 47.223 s | 49.306 s |
| Median observed process-tree CPU | 52.560 s | 53.535 s |
| Median sampled concurrent peak RSS | 1077.742 MiB | 1105.758 MiB |
| Actual tests across all launches | 840 | 840 |
| Original failure documents admitted | 120 | 120 |

The median paired complete-time ratio is 0.9573 (Playwright / Flashwright), with a 95% launch-paired interval of 0.8263–0.9692. The material-improvement and timing-regression gates fail. The largest observed concurrent RSS grows by 8.11%, within the 10% memory limit. Retain the slower late launches; no observation was removed or rerun. These are descriptive measurements: the agent created an export workspace during candidate launch 1, potentially competing for CPU and filesystem resources. That recorded overlap independently prevents performance acceptance. The report preserves this limitation alongside the complete observations, rather than treating matching test outcomes as a speed result.

The [portable manifest](../benchmarks/results/runner-matrix-2026-10-10/manifest.json) retains original and normalized byte hashes. Export normalizes declared environment paths, the private workspace-operation identifier, reporter stream chunk encoding and affected artifact hash links. Reporter chunks retain their count and joined content except approved path replacements; original chunk boundaries and encoding remain bound by the original file hashes. Source, dependency and executable identities and numeric observations remain unchanged. The independent portable verifier recomputes every outcome, original diagnostic and matrix decision from the retained reports and documents. It verifies historical custody, not the current bytes of installed dependencies or executables.

```sh
bun tools/verify-runner-matrix-snapshot.mjs benchmarks/results/runner-matrix-2026-10-10
bun test ./tools/test-runner-matrix-contract.mjs ./tools/test-runner-matrix-snapshot.mjs
```

The opt-in `--natural-drain` flag on the Linux coordinator lets descendants finish within the original command timeout after the wrapper exits. Its schema 2 native receipt retains the absolute deadline, every terminal wait and the original strict cleanup flag. The resource reader includes this interval and accepts naturally drained membership while still rejecting timeout, killing and cleanup errors. The default policy and historical receipts retain their interpretation.

The [natural-drain checkpoint](../compatibility/evidence/linux-natural-drain-checkpoint-2026-10-17.json) passes 35 parser/join checks, 29 native controls and six capture integration controls. Four new Bun.WebView lifecycle probes drain without collector intervention; native closeAll still kills Chrome itself, and its two cases require about 0.3 seconds of post-wrapper drain. This is measurement infrastructure, with no new comparative performance or context-isolation claim.

The [owned Linux backend checkpoint](../compatibility/evidence/owned-backend-linux-checkpoint-2026-10-17.json) passes 248 original backend tests across both engines at one/four workers. PostgreSQL, Mailpit and the API now execute as owned child processes inside the same measured cgroup as the runner and browser. Fresh database initialization, migrations, seeding and all shutdown work are included. Every group drains without collector killing. The common policy uses a private loopback network, a four-core group quota, 8 GiB memory ceiling and zero swap.

The [current backend capture checkpoint](../compatibility/evidence/linux-backend-capture-checkpoint-2026-10-20.json) verifies 248 further original tests across both engines at one/four workers using the current Linux capture coordinator. Its expanded boundary inventory includes backend source, effective configuration, base Python and selected startup libraries. All four native workloads exit zero and drain cleanly; retained copies reconstruct their resources and all 44 captured outputs. Preserve the earlier selected-input-only batch and the final controller's launch-list ordering rejection: an independent unique-PID/full-record join verifies the original runs without rerunning them. Backend source/configuration and outcome integration into the final campaign loader remains unfinished. Loaded-library custody, packed release, final resource admission and comparative performance remain unverified.

The [backend portability checkpoint](../compatibility/evidence/linux-backend-portability-checkpoint-2026-10-20.json) closes retained-byte backend reconstruction for this pinned development profile. Two complete nine-scenario drafts reconstruct 36 original captures, 728 test outcomes and 60 failure documents across one/four workers, without new native workloads. The backend join verifies the corrected consumer sources, executed configuration, stock-browser identity, authentication, reported services and original runner wait. Per-run byte snapshots keep each draft within the existing 512 MiB read budget. Historical source states remain distinct and every run remains noncomparable for final performance acceptance; the 2× goal is still unproven.

These are single diagnostic runs with local development aliases and on-first-retry tracing, with no retries. Their whole-command times remain similar between engines; they establish no 2× improvement. Keep them separate from historical Docker-service measurements because the native PostgreSQL build/locale and resource policy changed. The checkpoint preserves the initial service-drain failure and a controller error after the first successful suite; its original outcomes and completed captures were independently verified without rerunning that suite. Final campaign and release admission remain open.

The [backend CPU attribution](../benchmarks/results/backend-cpu-attribution-linux-2026-10-17.json) retains six complete launches with 372 passing original tests. Half-millisecond profiles put roughly 58–59% of observed user-mode samples in browser processes and about 1.5% in the candidate Rust driver. They also expose native password-hashing work missed by the coarser five-millisecond profiles, where thousands of threads finish too quickly to be sampled. An independent reader reconstructs 133,206 samples and selected native function ranges. These are diagnostic sample shares, not elapsed-time savings or an admitted comparison.

The subsequent [native browser profile](../benchmarks/results/native-browser-functions-linux-2026-10-17.json) retains eight fresh TodoMVC/SVGOMG launches and 120 passing original tests. The existing custom Chromium binary supplies function symbols without a rebuild. An independent reader recounts 22,786 samples, and LLVM checks 982 sampled/caller address controls against the ELF resolver. TodoMVC's largest recurring native function is V8's scanner: 248/500 and 253/513 of its samples have source-position collection in their captured ancestry, often with console reporting. This is partly stack-location work, so attributing all parsing to initial application compilation would be misleading. SVGOMG has a broader profile including raster work. Truncated callchains, folded aliases, unresolved and external addresses remain explicit. No optimization or speed claim is adopted; earlier unsuccessful cache, compiler-tier and eager-source-position screens remain relevant.

The [eager-compilation screen](../benchmarks/results/eager-compilation-linux-2026-10-17.json) tests a different composition: disabling lazy script, eval and streaming compilation while generating source-position tables eagerly. All 120 original tests pass across eight fresh stock full-Chrome launches. TodoMVC takes about 5–7% less elapsed time, but SVGOMG takes about 18% more in both comparisons. Neither application meets the predeclared 20% reduction gate, so ordinary compilation defaults remain selected. Separate bytecode-output controls confirm that unused network/eval functions compile under the eager policy without being invoked. This is a rejected engineering screen, not a Playwright comparison or an admitted performance result.

## Independent process runner engineering comparison

The [native Linux comparison](../benchmarks/results/independent-process-comparison-linux-2026-10-21.json) retains two opposite-order blocks: 24 complete commands and 360 passing TodoMVC/SVGOMG tests. Both Flashwright arms use the same private renderer-reuse and classic-frame browser composition; their test scheduler differs. The reference uses pinned Playwright and stock headless shell. Every run includes HTTP fixture startup, runner/browser work and shutdown under the same four-core quota and 8 GiB limit.

Each cell shows block 0 / block 1 in seconds. Ratios are Playwright time divided by independent-runner time.

| Application | Workers | Playwright | Existing Flashwright scheduler | Independent process runner | Ratio |
| --- | ---: | ---: | ---: | ---: | ---: |
| TodoMVC | 1 | 3.877 / 3.932 | 3.091 / 2.941 | 2.347 / 2.122 | 1.652× / 1.853× |
| TodoMVC | 4 | 2.827 / 2.768 | 3.330 / 3.589 | 2.270 / 2.278 | 1.245× / 1.215× |
| SVGOMG | 1 | 2.043 / 1.678 | 1.993 / 2.011 | 1.205 / 1.216 | 1.695× / 1.380× |
| SVGOMG | 4 | 2.157 / 2.350 | 2.927 / 2.988 | 1.789 / 2.489 | 1.205× / 0.944× |

The candidate takes 16.7–39.5% less time than the existing Flashwright scheduler in these observations. It does **not** meet the 2× objective. The second four-worker SVGOMG run is 5.9% slower than Playwright; it remains in the result. This is a two-application engineering screen with a private adapter, not the final eight-pair campaign, a public runner release, an incremental comparison against the earlier Bun-test bridge, or final resource admission. Public configuration, compatible deadlines and reporter/artifact integration remain open.

## Video decoder initialization and renderer retirement

The [Linux startup comparison](../benchmarks/results/video-initialization-linux-2026-10-21.json) records two separate 32-command, 480-test screens. Appending `--disable-gpu` did not consistently improve complete Flashwright runs. GPU startup traces instead localized a long pause to pre-sandbox initialization, whose Linux path initializes hardware video decoding. With `--disable-accelerated-video-decode`, instrumented GPU initialization fell from 1.05–1.10 seconds to 0.19–0.24 seconds. These diagnostic spans are separate from complete-command timing.

The second screen applies that decoder setting equally to Playwright and Flashwright, preserving software decoding. Each cell below shows block 0 / block 1 in seconds. The ratio compares the two engines with the **same changed setting**, including their original service startup and teardown.

| Application | Workers | Flashwright default | Flashwright software decoding | Playwright software decoding | Matched ratio |
| --- | ---: | ---: | ---: | ---: | ---: |
| TodoMVC | 1 | 2.088 / 2.163 | 1.963 / 1.991 | 3.809 / 3.787 | 1.940× / 1.902× |
| TodoMVC | 4 | 2.298 / 2.339 | 1.766 / 1.733 | 2.049 / 2.057 | 1.160× / 1.187× |
| SVGOMG | 1 | 1.251 / 1.208 | 0.974 / 1.016 | 1.736 / 1.731 | 1.781× / 1.704× |
| SVGOMG | 4 | 1.794 / 2.058 | 1.348 / 1.327 | 1.371 / 1.494 | 1.017× / 1.126× |

Flashwright takes 6.0–35.5% less time in these observations. Playwright also improves, and no cell reaches 2× in both blocks. These two-application engineering screens do not replace the final nine-scenario, eight-pair campaign or establish a public runner release.

Selected controls retain Canvas 2D/WebGL pixels, software video playback, screenshots, fresh storage and trusted input on moving targets. They also expose a **renderer-retirement resource failure**: after video-bearing contexts retire, the private reuse composition consumes roughly 9.7 CPU-seconds in a three-second idle window. Disabling the custom deadline change and frame uncapping does not resolve it. Disabling renderer reservation while retaining the fast scheduling and software-decoder settings reduces the same window to 0.21 CPU-seconds. The exact native loop remains unproved; source inspection identifies video paths that fail to retain their original broker authority and assumes a stable physical client ID across logical reuse.

Neither private composition is admitted for public adoption. Preserve these failed controls alongside the speed measurements; an inner functional report does not override its controller's failed idle-resource check. Default public launch policy remains unchanged, and graphics/codec coverage beyond the selected controls remains open.

The subsequent [video owner checkpoint](../compatibility/evidence/video-owner-reuse-linux-checkpoint-2026-10-21.json) fixes a selected reuse defect with a [native patch](../tools/chromium/video-original-owner.patch). Video submission retains its original document broker; shared frame-sink bundles are keyed by broker lifetime and client identity, and retired owners cannot start GPU recovery. The patch requires the existing private ownership implementation identified by its source hashes; it is not a standalone upstream Chromium patch.

Direct comparison against the preserved pre-fix binary reproduces both blank video in the second/third reused contexts and roughly 3.15–3.17 mean CPU cores during a three-second idle window. The corrected browser displays the red video in all three contexts and uses 0.070–0.074 mean cores, with both default and explicit software-decoder settings. Native records confirm that the same physical renderer still transfers between distinct logical hosts. All 50 focused native tests and 60 original TodoMVC/SVGOMG tests at one/four workers pass, with natural process cleanup.

This also corrects the earlier graphics evidence: decoded video pixels and a CSS screenshot pixel passed, but video presentation in the screenshot had not been checked. The retained old screenshots show that failure. The new checks inspect the actual video region. These results close the selected ended-video regression; live MediaStream/WebRTC, closure during playback, wider codec coverage, full resource admission and the final performance campaign remain open.

## Shared browser across independent workers

The [shared-browser screen](../benchmarks/results/shared-browser-linux-2026-10-21.json) tests one suite-owned browser instead of one browser per worker. Each worker keeps its own Rust driver and CDP connection through a private pipe-to-WebSocket bridge. Fresh contexts retain dispose-on-detach, and closing one worker's browser lease leaves other workers running. Selected controls verify same-origin storage isolation, independent client closure and cleanup after abrupt client death.

The matched screen includes browser/server startup, original test callbacks and all shutdown work under the same four-core quota and 8 GiB limit. Shared-browser startup overlaps ordinary suite discovery. Both arms use the corrected custom browser, physical renderer reuse, fast frame scheduling and explicit software video decoding. Each timing cell shows two opposite-order observations in seconds.

| Application | Workers | Separate browsers | Shared browser | Shared elapsed change |
| --- | ---: | ---: | ---: | ---: |
| TodoMVC | 1 | 2.008 / 1.991 | 2.259 / 2.252 | 12.5% / 13.1% slower |
| TodoMVC | 4 | 1.666 / 1.775 | 2.269 / 2.356 | 36.2% / 32.8% slower |
| SVGOMG | 1 | 0.982 / 0.981 | 1.020 / 1.030 | 3.9% / 5.0% slower |
| SVGOMG | 4 | 1.852 / 1.339 | 1.251 / 1.151 | 32.5% / 14.0% faster |

All 240 matched test executions pass. Sharing reduces four-worker sampled RSS by roughly 39–43%, but fails the declared speed gate: at least 20% less complete time for both four-worker applications in both orders, without more than 5% regression at one worker. Separate browsers remain selected. This comparison includes transport-bridge overhead; it does not isolate browser count or rule out every native shared-browser architecture.

The evidence also retains 120 preliminary test executions, the initial transport's approximately five-second shutdown delay, and a launch-receipt collision in the first isolation harness. The corrected transport exits after its WebSocket closes; every matched native browser exits normally with no remaining contexts. These are engineering observations, not a Playwright comparison, final resource admission or the nine-scenario performance gate.


## Direct shared-browser transport and context-scoped reuse

The [direct shared-browser screen](../benchmarks/results/direct-shared-browser-linux-2026-10-21.json) removes each worker's Bun WebSocket bridge and makes native renderer retention specific to its original context. Inspection of the preceding shared-browser reports found that the browser-global admission guard prevented reuse under concurrent workers: each four-worker TodoMVC run had 23 ineligible contexts and only one transfer. The new runs retain all 24 transfers and 20 successor claims. This is a combined transport and reuse-admission change; the measurements do not isolate either component.

The same native browser and Rust driver serve both Flashwright arms, with lazy VAAPI discovery and normal hardware-decoder policy. Every test still gets a fresh context. The complete clock includes suite-owned browser startup, fixture startup, original tests, shutdown and artifact cleanup. Startup overlaps normal suite discovery. Each cell below contains two reversed-order observations in seconds under the same four-core quota and 8 GiB memory limit.

| Application | Workers | Playwright | Separate browsers | Direct shared browser | Playwright / shared |
| --- | ---: | ---: | ---: | ---: | ---: |
| TodoMVC | 1 | 3.820 / 3.848 | 1.967 / 1.973 | 1.951 / 1.945 | 1.958× / 1.978× |
| TodoMVC | 4 | 2.826 / 2.731 | 1.732 / 1.684 | 1.507 / 1.516 | 1.875× / 1.801× |
| SVGOMG | 1 | 2.009 / 1.992 | 0.894 / 0.967 | 0.880 / 0.898 | 2.283× / 2.219× |
| SVGOMG | 4 | 2.379 / 2.427 | 1.237 / 1.290 | 1.008 / 1.084 | 2.359× / 2.240× |

All 360 original application test executions pass across 24 captures. Sharing reduces four-worker TodoMVC elapsed time by 10.0–13.0% and SVGOMG by 16.0–18.5%, with sampled RSS about 45% lower. It **fails the predeclared advancement gate** of at least 20% less complete time in both four-worker applications and both orders. One-worker runs do not regress. The candidate is preserved as an experiment; separate browsers remain selected. Two observations per cell do not establish the final confidence or nine-scenario performance gate.

Controls cover distinct Rust workers, fresh storage, same-name downloads with distinct bytes, peer survival after lease closure, abrupt JavaScript/Rust death and client detachment during held native adoption stages. Eight media contexts pass decoded-video and actual screenshot-pixel checks, Canvas/WebGL, moving-target trusted input and post-retirement idle CPU controls. Hardware decoder first use and broader backend coverage remain open.

The transport control initially reproduced a buffered terminal reply being overtaken by WebSocket EOF. The corrected parser drains buffered input before publishing closure; the new 1,000-event terminal-reply control and 23 existing connection tests pass. A separate receipt check initially failed because concurrent stderr writes interleaved. Repeating the worker controls with separate log files verified ten exact context/host/process joins and eight successor claims. Killing a driver leaves one artifact directory that the suite owner removes after native browser exit. Both failures and their corrections remain in the evidence.

Sampled RSS is not charged peak memory. The inner owner's cgroup CPU interval excludes some outer shared-browser startup and shutdown, so this screen makes no complete charged-CPU reduction claim. Source recovery patches and their exact upstream revisions are retained in the [Linux source checkpoint](../tools/chromium/recovered-linux-2026-10-21/README.md); preservation does not make the experimental browser a released default.


## Native composition across controlled scenario families

The [controlled-family screen](../benchmarks/results/native-controlled-families-linux-2026-10-21.json) extends the separate-browser native composition beyond the two application suites. It retains the six original controlled families, 15 tests per capture, one/four workers, fresh contexts and the intentional 250 ms assertion failures with ordinary worker replacement. The independent runner uses renderer reuse, classic uncapped frame scheduling and lazy VAAPI discovery; Playwright uses stock Chromium. Original test bodies are unchanged.

A complete 24-capture functional preflight precedes 48 matched captures in two reversed-order blocks. The matched comparison verifies 600 passing outcomes, 120 intentional failures and 220 original browser-launch receipts. All original owners drain without cleanup intervention. These are observed speedup ratios against Playwright, including fixture/browser/runner startup, original callbacks, failure documents and shutdown:

| Family | Workers | Block 0 | Block 1 |
| --- | ---: | ---: | ---: |
| Interaction | 1 | 2.119× | 2.109× |
| Interaction | 4 | 2.803× | 2.392× |
| Assertion | 1 | 1.419× | 1.441× |
| Assertion | 4 | 1.544× | 1.575× |
| Navigation | 1 | 1.431× | 1.372× |
| Navigation | 4 | 1.608× | 1.447× |
| Setup | 1 | 1.498× | 1.357× |
| Setup | 4 | 1.586× | 1.585× |
| Backend | 1 | 1.712× | 1.684× |
| Backend | 4 | 2.585× | 2.358× |
| Failure | 1 | 1.232× | 1.252× |
| Failure | 4 | 1.411× | 1.347× |

Only interaction exceeds 2× in both worker counts and both blocks. Backend exceeds 2× at four workers but falls short at one. The result does not meet the majority-scenario goal, establish confidence from eight pairs, or replace the requirement for two real application wins. It shifts the next attribution work toward fresh-document initialization and context teardown.

Two separate diagnostic library runs each create 15 fresh contexts and add one repeated assertion per context. Across the 14 warm contexts in each run, median context closure is 12.02 / 11.97 ms, first assertion is 8.69 / 8.64 ms, and repeated assertion is 0.68 / 0.63 ms. These API intervals include scheduling and downstream work; they do not isolate browser CPU or prove removable savings. Source inspection finds three sequential CDP calls for first assertion: isolated-world creation, evaluation of a combined 373,154-byte runtime, then the resident assertion. The existing realm is reused on the repeat. Context teardown also performs the serial native renderer-transfer protocol; this measurement does not isolate garbage collection.

Two preflight identity-check failures are retained: the verifier first required the stock browser version for the custom browser, and its first correction selected the stock alternative from the driver admission list. The final verifier freezes the unique exact custom version already accepted by that driver. Two diagnostic import failures occurred before any server/browser work; the completed diagnostic runs use the public facade. None of these attempts contributes to the timing ratios. Complete charged-resource custody, broader diagnostic conformance and final performance admission remain open.

## Locator initializer source-reference experiment

The [source-reference screen](../benchmarks/results/locator-source-reference-linux-2026-10-21.json) targets repeated transmission of the 373,712-byte locator initializer. Separate diagnostics measured about 6.6 ms for the injection command and about 0.6 ms inside native V8 conversion/evaluation. Retaining an unbound compiled script produced 14 cache hits without improving first-assertion time. A refined candidate retains only source text and sends a short content reference; it preserves the ordinary debugger evaluation path and creates fresh state in the original unique context.

The source-reference diagnostic reduced warm first-assertion median from 8.45 to 2.86 ms across one pair of 15-context runs. That local result is distinct from complete-suite improvement. Final-build controls passed 180 controlled outcomes, including 30 intentional failures, 60 original application tests, two realm-control runs and eight graphics/media contexts with verified screenshot pixels. The timed screen then passed all 900 original tests in 60 captures, with the same candidate binaries off/on, stock Playwright, both worker counts and two reversed orders. Audit logging was disabled.

Positive percentages below mean less complete time than the same candidate with source caching disabled. Negative percentages mean regressions.

| Family | Workers | Reduction, block 0 | Reduction, block 1 | Playwright / cached, block 0 | Playwright / cached, block 1 |
| --- | ---: | ---: | ---: | ---: | ---: |
| setup | 1 | 11.10% | 14.50% | 1.635× | 1.616× |
| setup | 4 | 2.43% | 0.77% | 1.684× | 1.491× |
| assertion | 1 | 1.19% | 2.43% | 1.444× | 1.480× |
| assertion | 4 | 3.80% | 3.84% | 1.678× | 1.592× |
| navigation | 1 | 22.65% | 0.34% | 1.540× | 1.446× |
| navigation | 4 | 4.17% | 3.88% | 1.683× | 1.494× |
| todomvc | 1 | 7.61% | 10.90% | 2.045× | 2.264× |
| todomvc | 4 | 2.00% | 1.07% | 1.699× | 1.663× |
| svgomg | 1 | 0.27% | 7.48% | 2.237× | 1.804× |
| svgomg | 4 | -0.06% | -28.15% | 1.811× | 1.440× |

The predeclared gate required at least 10% reduction in setup, assertion and navigation at both worker counts in both orders, with no application regression over 5%. It failed. Single-worker setup improves consistently, but most four-worker savings are small, navigation varies sharply, and the second four-worker SVGOMG observation regresses 28.15%. That observation remains included; its cause is not established. Neither application exceeds 2× at both worker counts in both orders.

The [patches and reconstruction notes](../tools/chromium/locator-source-reference.md) remain experimental. The preceding sources and known baseline executables are restored. The native browser rebuild is byte-identical to its preceding baseline; the Rust rebuild succeeds but has a different digest, so restoration explicitly uses the preserved known baseline driver. No source-cache adoption, larger unchanged campaign, final confidence/resource admission or release claim follows from this screen.

## Worker startup and CPU-affinity attribution

The [startup and affinity checkpoint](../benchmarks/results/worker-startup-affinity-linux-2026-10-21.json) profiles 12 complete native runs with 180 passing original outcomes. Parent-observed worker collection commonly takes about 50 ms; workers 1–3 start after worker 0 finishes collection. Browser startup overlaps part of that interval. Framework-only process prewarming would require separating framework readiness from user-config/test collection, preserving assignment identities, environment inheritance, retries and unused-process shutdown. It is not selected as the next large-gain experiment.

The four-worker application diagnostics also record frequent CPU-quota throttling. A separate screen tests whether restricting affinity from CPUs 0–5 to CPUs 0–3 helps under the unchanged four-core quota, 8 GiB memory limit and zero swap. Both Playwright and Flashwright receive each policy. Ten functional preflight captures pass 150 outcomes before 40 timed captures pass another 600 original tests. The owner records its actual affinity and resource settings; the complete clock includes startup and natural drain.

Positive reductions mean the four-CPU affinity is faster than six-CPU affinity. These are four-worker observations in two reversed blocks:

| Family | Flashwright reduction, blocks 0 / 1 | Playwright reduction, blocks 0 / 1 | Playwright / Flashwright at four CPUs, blocks 0 / 1 |
| --- | ---: | ---: | ---: |
| setup | -0.25% / -2.25% | 0.09% / -2.04% | 1.629× / 1.465× |
| assertion | -6.27% / 0.96% | 0.09% / -1.09% | 1.486× / 1.573× |
| navigation | -4.20% / 1.15% | -1.37% / -1.69% | 1.510× / 1.671× |
| todomvc | 6.05% / -3.42% | -5.84% / -0.88% | 1.794× / 1.649× |
| svgomg | 25.32% / -4.79% | -0.50% / -2.32% | 1.957× / 1.818× |

The declared gate requires at least 10% candidate improvement in both applications in both orders and no controlled-family regression over 5%. It fails. The favorable first SVGOMG observation does not survive reversed order. Reduced aggregate throttled time is not equivalent to recovered wall-clock time. Keep the existing benchmark policy; this result does not establish a new engine speedup or final performance/resource acceptance.

An earlier diagnostic used Bun's process-relative `hrtime` values, which cannot align different worker PIDs. Those 12 passing captures remain separately retained for within-process use only. The corrected captures use UTC milliseconds for cross-process chronology and monotonic intervals within each process; their maximum within-process elapsed discrepancy is below 1 ms. All five instrumented generated JavaScript modules were restored byte-for-byte before timing. No product, browser or Rust implementation changed.
