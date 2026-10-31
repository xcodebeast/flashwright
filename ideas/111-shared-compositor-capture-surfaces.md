# Share one captured surface among compatible image consumers

Scope: high-resolution suites combining screenshots, visual assertions, trace screenshots and recording. Effort: very large compositor/automation integration. Potential: avoid repeated pixel readback and encoding for consumers observing the same frame.

Research, 2026-10-31, against `913231d4`, the live worktree and Chromium main. No captures or frame traces collected. Engine integration requires revision matching.

## Evidence and distinction

The existing [`Screencast`](../packages/playwright-core/src/server/screencast.ts) already distributes one frame stream to several clients. Trace/video fan-out alone is therefore not a new opportunity. However, [`Tracing._captureScreenshot`](../packages/playwright-core/src/server/trace/recorder/tracing.ts) requests ordinary still screenshots, and [`Screenshotter`](../packages/playwright-core/src/server/screenshotter.ts) has a separate preparation/capture path.

Chromium's [`PageHandler`](https://raw.githubusercontent.com/chromium/chromium/main/content/browser/devtools/protocol/page_handler.cc) implements still capture and screencasting through distinct control paths. This does not prove duplicate GPU copies on every request; the proposal is conditional on compatible consumers actually causing redundant work below the existing fan-out.

[Idea 04](04-raw-screenshot-comparison.md) avoids encoding pixels merely to compare them. [Idea 17](17-direct-video-encoding.md) removes the video JPEG intermediate. [Idea 97](97-damage-aware-screenshot-capture.md) reuses unchanged regions across frames. This proposal shares a completed surface across different consumers of the same frame, without inferring that a later frame is unchanged.

## Proposed change

Add a browser-owned capture coordinator. Each request declares its required frame boundary, crop, scale, color/alpha format, overlays and screenshot preparation state. After the ordinary lifecycle/capture fence, the coordinator can lease one immutable raw surface to compatible consumers.

One consumer may encode PNG, another compare raw pixels, and another feed video. Identical encoding requests can also share an encoded result. Different resolutions or formats share earlier work only where that preserves the exact existing conversion and resampling pipeline. A low-resolution JPEG screencast cannot stand in for a full-resolution PNG screenshot.

Start with overlapping identical still-capture requests that reach the same verified surface/frame token and preparation generation. Then investigate sharing with recording. Do not add an artificial wait to collect a batch. If there is no matching completed or already-required capture, perform the ordinary capture immediately.

The current screenshot queue serializes temporary page changes. Preserve that coordination: masks, hidden carets, animations, injected styles, transparent backgrounds and full-page viewport adjustments all contribute to compatibility. Sharing must happen beneath correct preparation, not by bypassing the queue.

Keep leases short and reference counted. A slow encoder must not pin an unlimited sequence of surfaces or delay a visual assertion. Use bounded storage and copy/fallback when retention would cost more than a fresh capture.

## Functional boundary

Every consumer retains its required observation boundary and normal completion/error behavior. Equal dimensions or nearby timestamps do not establish the same frame. Navigation, cross-process frame composition, video surfaces, overlays and color changes require exact tokens or fallback.

Do not collapse two stability-check samples into one observation. Do not shift trace before/after images across the action they describe. Preserve recording timestamps, acknowledgements, capture cancellation and screenshot pixels. Unsupported combinations keep independent capture.

## Payoff and later decision

The target is physical readbacks, raw buffers and identical encodes per eligible frame. Single-consumer suites should gain nothing and must not pay substantial coordinator overhead. Different masks, sizes or capture moments can make the overlap rate too small to justify this.

Later count compatible requests and actual underlying copies, then compare combined recording/trace/visual workloads with each feature alone. Require pixel identity, separate stability observations and correct artifact timing. Follow the [full matrix/upstream regression procedure](01-browser-native-actions.md#payoff-and-decision-test), including peak leased memory and slow-consumer cases. Reject gains obtained by silently dropping observations.

**Assessed 2026-10-31:** deferred: browser-internal (compositor), needs a custom Chromium. Capture is frame-bound (16.7 ms whether PNG or JPEG); the screenshot work that pays today is avoiding captures (4d05034a), not sharing them.
