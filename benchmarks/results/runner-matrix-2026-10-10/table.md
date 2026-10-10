Controlled native runner matrix.

8 ordered independent launch pairs; 840 tests and 120 default failure documents per engine. Every original failure passed controlled diagnostic admission. No launch or observation was excluded.

The 16 recorded runner start times and measured durations verify the declared alternating order without overlapping runner intervals. This verification covers recorded runner intervals; it does not establish complete watchdog or exclusive host occupancy. Start and end values remain in the machine-readable analysis, including fractional measured end milliseconds.

Performance acceptance: not accepted.

| Metric | Unit | Samples per engine | Playwright launch median | Flashwright launch median | Paired ratio (Playwright / Flashwright) | Paired ratio confidence interval | Playwright observed maximum | Flashwright observed maximum |
| --- | --- | ---: | ---: | ---: | ---: | --- | ---: | ---: |
| completeMilliseconds | milliseconds | 8 | 47222.763 | 49305.730 | 0.957 | 0.826 to 0.969 | 60864.346 | 73657.662 |
| runnerMilliseconds | milliseconds | 8 | 46777.081 | 48844.485 | 0.961 | 0.823 to 0.973 | 59928.194 | 72810.030 |
| peakConcurrentRssBytes | bytes | 8 | 1130094592.000 | 1159471104.000 | 0.982 | 0.951 to 1.006 | 1161609216.000 | 1255849984.000 |
| observedCpuSeconds | seconds | 8 | 52.560 | 53.535 | 0.976 | 0.950 to 0.978 | 61.380 | 64.600 |
| noop/operationMilliseconds | milliseconds | 96 | 0.929 | 0.873 | 1.093 | 0.933 to 1.190 | 3.319 | 2.704 |
| noop/testMilliseconds | milliseconds | 96 | 230.250 | 236.750 | 0.959 | 0.911 to 1.125 | 925.000 | 658.000 |
| interaction/operationMilliseconds | milliseconds | 96 | 31.486 | 32.796 | 0.981 | 0.919 to 1.064 | 96.465 | 104.776 |
| interaction/testMilliseconds | milliseconds | 96 | 271.250 | 287.500 | 0.995 | 0.873 to 1.146 | 481.000 | 476.000 |
| assertion/operationMilliseconds | milliseconds | 96 | 15.135 | 16.102 | 0.948 | 0.926 to 0.972 | 24.964 | 142.516 |
| assertion/testMilliseconds | milliseconds | 96 | 241.750 | 265.250 | 0.940 | 0.896 to 0.997 | 1192.000 | 957.000 |
| navigation/operationMilliseconds | milliseconds | 96 | 64.907 | 65.632 | 1.005 | 0.928 to 1.043 | 150.240 | 1073.399 |
| navigation/testMilliseconds | milliseconds | 96 | 298.000 | 309.500 | 0.956 | 0.929 to 0.994 | 796.000 | 2043.000 |
| setup/operationMilliseconds | milliseconds | 96 | 14.274 | 15.223 | 0.930 | 0.879 to 0.951 | 36.612 | 22.320 |
| setup/testMilliseconds | milliseconds | 96 | 242.000 | 259.750 | 0.942 | 0.812 to 0.982 | 498.000 | 590.000 |
| backend/operationMilliseconds | milliseconds | 96 | 62.818 | 59.398 | 1.059 | 1.032 to 1.096 | 127.554 | 112.921 |
| backend/testMilliseconds | milliseconds | 96 | 304.500 | 309.500 | 0.979 | 0.953 to 1.002 | 405.000 | 482.000 |
| failure/operationMilliseconds | milliseconds | 96 | 256.985 | 256.841 | 1.001 | 0.997 to 1.003 | 284.237 | 262.164 |
| failure/testMilliseconds | milliseconds | 96 | 598.000 | 616.750 | 0.995 | 0.917 to 1.021 | 1052.000 | 1624.000 |

Acceptance requires at least 10% complete-time reduction and a paired ratio confidence interval excluding parity; timing median regression must stay within 5% and observed-maximum regression within 15%; largest observed sampled concurrent resident memory growth across all launches must stay within 10%.

Timing median regressions: assertion/operationMilliseconds, assertion/testMilliseconds, setup/operationMilliseconds, setup/testMilliseconds. Observed-maximum regressions: completeMilliseconds, runnerMilliseconds, assertion/operationMilliseconds, navigation/operationMilliseconds, navigation/testMilliseconds, setup/testMilliseconds, backend/testMilliseconds, failure/testMilliseconds. Largest observed sampled resident memory change: 8.113%; median sampled peak change: 2.599%.

Complete time includes cold preparation, successful tests, all warmups, real failures, diagnostic capture and teardown. Workload rows use only measured samples; each has 96 correlated observations across eight independent launches. Warmups and all original values remain in the machine-readable analysis. Confidence intervals resample paired launch medians, not individual tests. Observed maxima are descriptive observations; 96 observations do not support p95 or p99 claims.

External watchdog samples the observed descendant process tree, including separately grouped browser processes. Short-lived processes between samples may be missed; report this limitation.

Sampled concurrent resident memory is bytes; observed CPU is seconds across the observed process tree. Short-lived processes between samples may be missed. Zero observed CPU values retain descriptive statistics but have no positive paired ratio.

Original predicate, common source, accessibility snapshot, normalized source frame and call site admission is scoped to the controlled fixture. Error wording and Markdown bytes may differ. This evidence does not establish general diagnostic parity.

Recorded environmental confounds force descriptive and functional use only; timing acceptance remains blocked:

- Agent initiated a managed Git checkout for evidence tooling while the candidate launch ran. Checkout and registration could compete for filesystem/CPU resources. Affected launch: pair-01-flashwright. Policy: Retain the full planned matrix and every sample; do not selectively exclude or rerun this launch. Functional admission remains independently required. No release performance acceptance from this matrix..

Controlled native runner fixture with original intentional failures, worker restarts and admitted default diagnostics. No representative application, broad competitor, Linux or performance leadership claim.
