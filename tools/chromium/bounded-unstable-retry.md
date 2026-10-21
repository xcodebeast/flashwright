# Bounded unstable-pointer retry experiment

This private Rust patch applies to the renderer-reuse driver source identified by the [screen](../../benchmarks/results/bounded-unstable-retry-linux-2026-10-21.json). It includes the exact diagnostic instrumentation used in the tested build. It does not change Chromium or a public default.

`FLASHWRIGHT_POINTER_WAIT_AUDIT=1` buffers up to 256 timestamped events per action and emits them when that action returns or is dropped. Resolution, input-lock acquisition, preparation, cleanup and retry pauses are recorded separately. Logging is disabled during the application comparison. One perpetual-motion control exceeds the buffer; its truncation is retained.

`FLASHWRIGHT_EXPERIMENT_UNSTABLE_RETRY=1` caps a host retry pause at 16 ms only when the reason is exactly `error:unstable`, aggregate delivery remains `NotDispatched`, and the retry index is below 32. The first zero delay stays zero. Every later case retains the original schedule. Each attempt still resolves its target and performs fresh consecutive-frame stability, targeting, native input and completion checks. Cleanup and input-lock release precede the pause. Operation deadlines and cancellation remain unchanged. The older resident-readiness hint is disabled.

Eight diagnostic application captures pass 48 original outcomes. No 500 ms pause is observed, so the prior half-second SVGOMG variation remains unexplained. Two four-worker “Reset all” actions spend about 225 ms in shorter existing pauses after instability; this is an interval observation, not proof that all that waiting is removable.

Both policies pass the existing pointer differential against Playwright on the same custom browser and three focused moving-target lifecycle controls. Another 540 original application outcomes pass with audit disabled. Four-worker SVGOMG improves 2.9% and 22.0% in reversed blocks, missing the declared 10% requirement in both. One single-worker SVGOMG run increases owner-interval charged CPU by 8.8%, exceeding the regression bound. Keep this candidate unadopted and do not repeat its unchanged application screen.

The original Rust source and exact baseline driver are restored; the native browser is unchanged. Full-current-core, native race coverage, final confidence/resource admission and release remain open.
