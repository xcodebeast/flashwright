# Linux source recovery checkpoint

This checkpoint preserves the recovered native renderer-reuse foundation and the private Rust integration as they existed during the direct shared-browser experiment on 2026-10-21. The original Mac checkout is no longer available. These are the actual Linux sources; equality with the original Mac sources is not claimed.

The three patches cover 515 changed files, including new source files. Each patch was applied to the recorded upstream file preimages in an isolated directory, and every resulting file was checked against the working source SHA-256. The manifest records those hashes, the 153 checked-out Git dependency revisions and the exact build arguments. This verifies source recovery, not a fresh full browser rebuild or release readiness.

To reconstruct the source:

1. Create a Chromium checkout using `gclient.config` as `.gclient`, with `src` at the Chromium base commit in `manifest.json`. Sync its pinned dependencies, checking their revisions against the manifest.
2. From `src`, check and apply `chromium.patch` using `git apply --check` followed by `git apply`. From `src/v8`, do the same with `v8.patch`.
3. In a separate Flashwright checkout at the product base commit in the manifest, check and apply `rust.patch`.
4. Use the preserved `args.gn` with the repository's S18 configure/build helpers. Preserve upstream licenses and notices. Downloaded toolchains, non-Git dependencies and build outputs are not bundled here.

These patches are full deltas from their recorded upstream bases. Do not apply earlier incremental experiment patches on top: their changes are already included. The separate `direct-shared-browser-native.patch` and `direct-shared-browser-rust.patch` in the parent directory describe only that final experiment; reversing those deltas recovers its preceding baseline.

The snapshot includes conditional experiments, test probes and the custom protection-removal configuration used in those experiments. Some comments in the captured build arguments describe earlier stages and are historical. Inclusion here does not select any experiment for the public package. The shared-browser candidate missed its declared advancement gate; the normal development checkout was subsequently restored to the preceding experimental baseline. See the [comparison evidence](../../../benchmarks/results/direct-shared-browser-linux-2026-10-21.json) for measurements and limitations.
