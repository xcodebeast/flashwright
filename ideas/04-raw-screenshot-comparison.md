# Compare screenshot pixels before encoding them

**Priority:** high for visual suites · **Scope:** screenshot assertions and capture-heavy runs · **Effort:** large; full path requires browser changes.

Research proposal, 2026-10-29. No new performance claims. Faster PNG encoding and identical-image fast paths already exist in this fork.

## Remaining cost

[`CRPage.takeScreenshot`](../packages/playwright-core/src/server/chromium/crPage.ts) gets layout metrics, asks Chromium to encode a screenshot, receives base64, then converts it to a Buffer. [`compareImages`](../packages/utils/comparators.ts) checks encoded equality, otherwise decodes both images and compares pixels. It allocates a diff image before knowing whether the mismatch is tolerated. [`Page.expectScreenshot`](../packages/playwright-core/src/server/page.ts) may repeat this during stabilization.

The [CDP screenshot schema](https://github.com/ChromeDevTools/devtools-protocol/blob/master/pdl/domains/Page.pdl) exposes encoded image data, not a raw-pixel comparison result. Thus the complete encode/transfer/decode removal needs a new browser interface. Existing fast PNG work does not already solve it.

## Proposed mechanism

Add a private raw-capture/comparison path for `toHaveScreenshot()`:

1. Decode the expected baseline once per content/version and comparison configuration, in a bounded cache.
2. Capture pixels at the existing screenshot boundary, using the same compositor readback, scale, clipping, masks, style and animation handling.
3. Compare in the browser process or a small native comparison service. If external, transfer a read-only shared-memory buffer with an explicit lifetime instead of base64 PNG. A native Node addon or WASM SIMD comparator is a useful intermediate step, but alone does not remove encoding/readback costs.
4. Return a small match result on success. Encode actual/previous/diff images only when required for a failure, attachment, baseline generation or public screenshot Buffer.

A count-only first comparison pass can avoid constructing diffs for tolerated mismatches. Generate the final diff from the **same captured pixels**, not a later recapture. Cache keys include baseline content and image dimensions; changing a file in place must invalidate it.

Keep the existing capture and stabilization sequence. A DOM mutation counter cannot certify an unchanged picture: canvas, video, fonts, animations, transforms and GPU content can change independently. Compositor damage information is only a hint unless it proves every relevant surface is unchanged. Hash equality alone must not silently accept a mismatch.

## Functional contract

Match the current comparator exactly, including alpha/color conversion, antialiasing, thresholds, size errors, tolerated differences, negated expectations and `ssim-cie94`. Vectorized floating-point changes require careful differential tests around decision thresholds. Preserve the first-capture baseline-match fast path and the subsequent consecutive-capture stabilization rules, screenshot locking/restoration, full-page and element captures, device scale and baseline PNG bytes. Public `page.screenshot()` still returns an encoded Buffer.

## Payoff and decision test

**First experiment:** cache decoded baselines and defer diff allocation in the existing comparator, using stock capture. Measure matching byte-identical PNGs separately: they already bypass decoding, so this milestone cannot help that path. Attribute encoding/readback before committing to a browser extension.

The removable work is image encoding, base64 transfer, repeated baseline decoding and unnecessary diff generation; rendering/readback remains. Visual suites may benefit greatly, and lower copying/allocation can reduce CPU and memory. Raw buffers are larger than PNGs, so share them only when doing so lowers total cost and release them promptly.

Later, measure matching, tolerated-mismatch and failed assertions at several resolutions, with one and four workers; compare current-fork PNG fast paths as well as stock. Use the [full-suite evaluation rule](01-browser-native-actions.md#payoff-and-decision-test), especially capture/screenshot matrix rows. Run upstream `tests/page` on `chromium-page`, screenshot library tests and [`to-have-screenshot.spec.ts`](../tests/playwright-test/to-have-screenshot.spec.ts) against pristine upstream. Keep the browser extension only if complete-suite time improves with identical pixels, outcomes and diagnostics.
