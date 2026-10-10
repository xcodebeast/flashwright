Repeated engineering observations; instrumented and outcome-only rows are excluded from equivalent-work speed claims.

| Engine | Version | Class | Startup ms | Complete ms | Child process wall ms | CPU s | Median launch peak RSS MiB | Maximum sampled RSS MiB | Failures |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| flashwright | development checkout | library-flow | 500.5 [413.2, 829.1] | 8478.8 [8317.0, 8872.5] | 9117.7 [8722.9, 9551.5] | 8.12 [7.79, 8.37] | 946.9 [942.6, 950.2] | 951.4 | 0 expected, 0 unexpected |
| playwright | 1.60.0 | library-flow | 523.2 [375.1, 579.7] | 8423.6 [8264.4, 9110.7] | 8940.3 [8715.8, 9493.2] | 8.87 [8.37, 8.95] | 930.9 [927.0, 936.2] | 937.0 | 0 expected, 0 unexpected |
| puppeteer | 25.13.0 | library-flow | 433.1 [386.2, 456.4] | 8695.8 [8409.2, 8806.2] | 8954.7 [8721.0, 9119.4] | 7.90 [7.68, 8.20] | 862.6 [853.6, 865.3] | 865.5 | 0 expected, 0 unexpected |
| cypress | 16.1.1 | runner-outcome | Not isolated | 17516.8 [16923.2, 18682.0] | 17833.5 [17297.0, 19002.1] | 25.45 [24.13, 26.00] | 1876.1 [1801.5, 1924.9] | 1932.0 | 120 expected, 0 unexpected |
| webdriverio | 10.0.2 | library-flow | 1824.4 [1670.4, 1911.3] | 53807.8 [53270.8, 55482.8] | 54073.2 [53450.5, 55783.5] | 66.86 [66.36, 69.56] | 2179.1 [2117.4, 2845.5] | 2855.2 | 0 expected, 0 unexpected |

Cells show medians of 8 independent-launch medians [95% launch-clustered intervals]. Complete runs include preparation, warmup, verification and cleanup. Child wall time uses the common watchdog interval and excludes parent dependency verification.

| Engine | Workload | Operation ms | Preparation-inclusive workload ms | Observed operation maximum ms |
| --- | --- | ---: | ---: | ---: |
| flashwright | noop | 0.3 [0.3, 0.4] | 285.5 [250.9, 325.8] | 1.6 |
| flashwright | interaction | 16.5 [16.3, 16.6] | 562.5 [534.7, 644.8] | 48.9 |
| flashwright | assertion | 10.7 [10.4, 11.8] | 448.9 [393.1, 486.1] | 22.2 |
| flashwright | navigation | 55.9 [53.9, 58.1] | 1144.0 [1107.1, 1179.6] | 86.9 |
| flashwright | setup | 243.9 [230.5, 255.5] | 3786.4 [3548.1, 3955.3] | 469.1 |
| flashwright | backend | 41.8 [41.6, 42.3] | 931.7 [894.1, 1135.4] | 106.9 |
| flashwright | failure | 26.6 [26.2, 26.7] | 673.3 [644.4, 700.9] | 39.4 |
| playwright | noop | 0.3 [0.3, 0.5] | 246.9 [219.7, 292.5] | 3.5 |
| playwright | interaction | 16.6 [16.4, 16.9] | 519.0 [502.4, 577.5] | 22.3 |
| playwright | assertion | 25.6 [25.3, 26.0] | 658.3 [633.7, 668.8] | 32.7 |
| playwright | navigation | 57.4 [55.2, 58.6] | 1169.4 [1108.8, 1229.3] | 75.9 |
| playwright | setup | 236.4 [224.5, 257.6] | 3609.3 [3486.4, 3784.0] | 310.1 |
| playwright | backend | 47.1 [43.0, 49.3] | 990.5 [969.7, 1016.2] | 54.9 |
| playwright | failure | 24.8 [24.2, 24.9] | 633.0 [607.2, 658.0] | 26.3 |
| puppeteer | noop | 0.2 [0.2, 0.2] | 280.5 [253.0, 315.7] | 2.4 |
| puppeteer | interaction | 33.3 [33.1, 33.4] | 778.3 [747.5, 854.9] | 43.5 |
| puppeteer | assertion | 9.9 [9.6, 10.3] | 387.3 [378.0, 420.3] | 13.3 |
| puppeteer | navigation | 49.9 [48.9, 53.7] | 1038.4 [1008.1, 1069.2] | 76.4 |
| puppeteer | setup | 222.8 [208.4, 225.9] | 3425.6 [3153.6, 3453.2] | 299.8 |
| puppeteer | backend | 83.5 [83.5, 83.9] | 1562.8 [1500.4, 1587.3] | 112.0 |
| puppeteer | failure | 27.3 [27.1, 27.4] | 677.0 [640.0, 712.2] | 47.3 |
| cypress | noop | 2.8 [1.8, 3.4] | Not isolated | 6.4 |
| cypress | interaction | 74.4 [73.8, 74.8] | Not isolated | 79.7 |
| cypress | assertion | 20.2 [19.9, 20.4] | Not isolated | 22.9 |
| cypress | navigation | 47.8 [45.6, 50.0] | Not isolated | 77.3 |
| cypress | setup | 3.4 [3.2, 3.7] | Not isolated | 4.6 |
| cypress | backend | 205.0 [204.8, 205.5] | Not isolated | 228.0 |
| cypress | failure | 21.1 [21.1, 21.1] | Not isolated | 26.2 |
| webdriverio | noop | 29.2 [26.8, 29.5] | 678.0 [600.3, 715.2] | 65.8 |
| webdriverio | interaction | 694.3 [691.4, 711.0] | 10211.6 [10057.5, 10279.4] | 835.6 |
| webdriverio | assertion | 334.7 [328.7, 343.9] | 5355.3 [5224.7, 5639.2] | 560.6 |
| webdriverio | navigation | 252.5 [249.4, 256.9] | 4491.9 [4389.5, 4568.0] | 384.3 |
| webdriverio | setup | 368.3 [364.3, 379.6] | 5755.8 [5556.3, 5974.1] | 462.6 |
| webdriverio | backend | 1666.7 [1648.9, 1737.7] | 24732.9 [24155.5, 25781.2] | 1892.2 |
| webdriverio | failure | 37.7 [35.8, 41.1] | 1021.5 [961.2, 1084.2] | 65.5 |

| Engine | Selection rationale | Recorded differences and instrumentation |
| --- | --- | --- |
| flashwright | Candidate implementation | None in the measured fixture contract |
| playwright | Compatibility reference and established end-to-end runner; existing matched library-flow baseline. | None in the measured fixture contract |
| puppeteer | Direct Chrome automation contender with native locator readiness and low-level browser control; useful for testing whether the independent engine beats an automation library as well as a runner. | failure: Native visibility-selector timeout does not establish equivalent Playwright assertion diagnostics or failure work.; backend: Native fill emitted 126 trusted input events; reference fill expects 15. |
| cypress | Integrated end-to-end runner with browser-side command execution and retrying assertions; its event model and runner costs require a separate suite comparison. | Default Cypress click/type dispatch untrusted events; this does not pass native-input equivalence.; Ordinary testIsolation clears DOM, cookies, localStorage and sessionStorage per test; this does not establish fresh browser-context isolation.; Every case is an isolated runner test with page preparation. It is not the warmed library-flow layout.; Cypress retains its native proxy, runner and launch policy. Proposed arguments and the owned browser process command are recorded separately.; Missing-element cases are actual failed runner tests with Cypress diagnostics. They are expected failures, not suppressed or relabelled passes.; Per-test observation tasks; browser-clock operation interval includes afterEach queueing |
| webdriverio | WebDriver/BiDi ecosystem contender with native user interactions and standalone or runner execution; record the actual negotiated protocol and browser driver. | failure: Native visibility-selector timeout does not establish equivalent Playwright assertion diagnostics or failure work.; backend: Native fill emitted 126 trusted input events; reference fill expects 15.; all: ChromeDriver owns launch and the BiDi mapper bootstrap page. Retain its native defaults and report the difference from the reference pipe-only/no-startup-window policy. Launch-policy equivalence is not established.; Startup process-command observation |

The library-flow rows and Cypress runner-outcome row do not measure the same complete work. Diagnostic admission rows retain the instrumentation listed above. Native Linux, contention and representative matched runner suites remain open. No broad performance ranking follows from this table.
