# Remove the intermediate JPEG stage from video recording

**Scope:** video-enabled CI and high-resolution recordings. **Effort:** very large for direct capture integration. **Priority:** high for video users; no intended benefit with video disabled.

Research proposal, 2026-10-29. No experiments. This concerns continuous recording, not [screenshot comparison](04-raw-screenshot-comparison.md) or trace DOM snapshots.

## Evidence and opportunity

[`CRPage.startScreencast`](../packages/playwright-core/src/server/chromium/crPage.ts) requests JPEG frames; `_onScreencastFrame` decodes base64 and forwards them to the shared screencast service. [`FfmpegVideoRecorder`](../packages/playwright-core/src/server/videoRecorder.ts) wraps JPEG frames in timestamped Matroska, pipes them to FFmpeg, and encodes VP9/WebM.

The implementation already uses realtime codec settings, explicit timestamps, FFmpeg frame duplication and pixel-rate-dependent threads/bitrate. Tuning those same knobs is not the new idea. The avoidable chain is JPEG encoding in the browser, base64/string transfer, JPEG decoding in FFmpeg and per-recording process setup before the final video codec does its work.

## Design

Create a browser capture consumer that sends captured surfaces directly to a compatible video encoder, either inside a bounded browser utility service or through shared buffers to a native encoder service. Keep the existing capture cadence and use frame-swap timestamps. Deliver compressed WebM data or a finalized artifact to Node instead of JPEGs for Node to relay.

Separate capture, timeline and codec responsibilities. A long-lived service may reuse process initialization, but every recording gets independent codec/muxer state, timestamps, output ownership and error handling. This must not enable context recycling for video contexts by itself; lifecycle isolation is a separate issue.

A smaller first milestone sends the existing JPEG stream directly to an encoder service, retaining exact input frames and codec parameters. It tests transport/process overhead before touching image content. The full raw-surface path then removes JPEG encode/decode. Trace and live-view clients that still require JPEG can keep their existing path; do not force duplicate capture work when sharing is possible.

## Compatibility boundary and difference

Removing lossy JPEG can change decoded output pixels even with the same final VP9 parameters. Treat the raw path as an explicit opt-in until its artifact difference is documented in README, with the current recorder as the opt-out. Do not claim byte-identical videos. The intended contract is equivalent timing and at least equivalent diagnostic fidelity, verified on text, gradients, scrolling and rapid transitions.

Preserve dimensions, scaling, padding/cropping, configured FPS, action overlays, first-frame behavior, the existing final hold and empty-recording behavior. `video.path()`, `saveAs`, delete and context close must obey current completion rules. Hardware encoding is a later choice, not an assumed universal win or excuse to lower quality.

Use bounded buffers and an explicit overload policy matching the supported recording contract. No silent frame loss introduced to improve benchmarks. Service crashes must produce usable errors and clean up every affected recording; retained encoder state must never leak frames across tests.

## Payoff and later validation

Video adds repeated work throughout a test and may delay context close. Removing an entire codec stage can be substantial, but raw-frame bandwidth or CPU contention can erase the gain. Measure capture, transport, codec and finalization separately; include service startup and all drain time.

Later compare one/four-worker video suites, multiple pages, 800×450 and 1080p, static and moving content, and trace-plus-video. Decode outputs to inspect dimensions, timestamps, duration and visual fidelity. Run video library tests, `tests/page` on `chromium-page` and `tests/playwright-test` artifact coverage against pristine upstream in `workbench/pw-src`. Report video rows separately alongside the unchanged `node bench/matrix.mjs 15`, `node bench/run.mjs todomvc 1 15 stock,fork` and current-fork comparisons under the [shared rules](01-browser-native-actions.md#payoff-and-decision-test).
