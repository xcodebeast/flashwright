# Shared browser, source cache and scheduling composition

The [native Linux screen](../../benchmarks/results/shared-runtime-composition-linux-2026-10-21.json) measures six existing patches together. It changes no public default.

Apply these patches to the restored private renderer-reuse foundation identified by the screen's preimage hashes:

1. `direct-shared-browser-native.patch` and `direct-shared-browser-rust.patch`
2. `locator-source-reference-native.patch` and `locator-source-reference-rust.patch`
3. `paced-uncapped-frames.patch`
4. `early-retirement-recheck.patch`

Native patches apply at the Chromium source root; Rust patches apply at the private Rust checkout. All six patches reconstruct the measured outputs exactly across sixteen disjoint paths. The [recovered Linux sources](recovered-linux-2026-10-21/README.md) include the direct-sharing changes already; reverse those deltas first to obtain this experiment's baseline. Do not apply the same delta twice.

Both native comparison arms use the same browser and driver binaries, physical renderer reuse, lazy VAAPI discovery and the classic uncapped scheduler with early idle deadlines. The combined arm uses one suite-owned browser, independent worker connections and original context leases; enables `FLASHWRIGHT_CACHE_LOCATOR_SCRIPT=1` and `FLASHWRIGHT_PACED_UNCAPPED_FRAMES=1`; and adds `FlashwrightEarlyRetirementRecheck` to the native feature list. The separate baseline disables those additions. Keep the optional pointer-readiness hint and cache auditing off during timing. No retry delay was changed.

The suite owner starts the shared browser concurrently with normal runner discovery and closes it after all workers finish. The complete watchdog interval includes fixture/browser/runner startup and observed natural drain. The outer-owner charged CPU interval includes shared-browser startup/shutdown but excludes outer module imports, final report writes and watchdog drain. Endpoint product validation is not executable attestation; original suite-owned executable/argument receipts supply the selected launch identity.

Twelve selected control captures and 33 Rust transport/connection tests pass. Controls cover client death, held native adoption, fresh storage, downloads, retiring workers, realm ownership, moving targets, trusted input and actual media/screenshot pixels. All 540 original application outcomes pass, including 180 preflight outcomes. Reported context/host/process identities join 180 transfers and 150 successor claims. These controls do not establish full native race, callback, GPU or resource custody.

TodoMVC exceeds 2× stock Playwright in both worker counts and both orders. Four-worker SVGOMG also exceeds 2× twice, but single-worker SVGOMG reaches 1.816× and 2.310×. Consequently the prospectively declared requirement for every application/worker pair fails. Every cell improves versus the separate-browser baseline, with outer-owner CPU reductions of 15.5–40.1%. Preserve these gains without attributing them to individual components or treating seven favorable pairs as final acceptance.

Do not adopt this candidate or repeat its unchanged larger campaign on this evidence. The selected patches remain available for a distinct follow-up. Original sources and byte-identical rebuilt baseline browser/driver are restored. Broader conformance, the unchanged nine-scenario confidence gate, release and other-platform verification remain open.

A subsequent [controlled-family checkpoint](../../compatibility/evidence/shared-runtime-controlled-checkpoint-2026-10-21.json) verifies the same candidate on all six original families at one/four workers against stock Playwright. It retains 300 passes and 60 intentional failures, ordinary worker replacement and all 60 original diagnostic documents. The shared browser survives 30 failing candidate worker lifetimes, and all captures drain naturally. This adds selected functional coverage only, with no comparative timing claim or change to the failed application gate. Broader retry/configuration/artifact and native-custody coverage remains open.
