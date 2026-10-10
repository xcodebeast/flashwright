# Third party notices

## L1 Playwright

The compatibility declaration inventory, copied runner source references and selected migration test sources derive from Microsoft Playwright 1.60.0, copyright Microsoft Corporation, under Apache License 2.0

The [license](compatibility/upstream/LICENSE.playwright) and [upstream notice](compatibility/upstream/NOTICE.playwright) are retained verbatim. Source identities and changes appear in [reference-manifest.json](compatibility/reference-manifest.json) and [migration provenance](compatibility/migration-projects/provenance.json). The generated inventory changes declarations into classified JSON entries; copied reference and migration source files are unmodified

The runtime URL glob matcher adapts three pure helpers from the pinned npm distribution. [URL matcher provenance](compatibility/upstream/url-match-provenance.json) records the source hash and changes. Its Apache-2.0 license and upstream notice are included in packed Flashwright artifacts

The resident selector and actionability runtime retains the decoded Playwright 1.60.0 injected bundle unchanged. Flashwright's typed locator construction adapts the pinned text, attribute, regular-expression and role selector helpers. [Selector provenance](compatibility/upstream/selector-provenance.json) records source hashes, retained extracts and adaptations; it also records the pointer targeting, input sequencing and navigation-barrier adaptations in Rust and the resident wrapper. The same Apache-2.0 license and notice apply to the bundled Rust runtime

The native keyboard implementation uses generated descriptions from the pinned US layout, key aliases and macOS editing-command table. [Keyboard provenance](compatibility/upstream/keyboard-provenance.json) retains the pure source extract and generated hashes; the Apache-2.0 license and notice also apply to these Rust-bundled tables

The native Chromium launch policy uses generated default argument lists from the pinned switch builder and CDP browser implementation. [Launch policy provenance](compatibility/upstream/chromium-launch-policy-provenance.json) retains those extracts, the default configuration and generated hashes under the same Apache-2.0 license and notice

The assertion wrapper calls the pinned injected matcher predicates and adapts expected-text serialization and matcher options. The native fixture adapter uses the pinned runner root and public fixture/expect extension points; its fixture option precedence follows the retained upstream source. These adaptations are recorded in [selector and assertion provenance](compatibility/upstream/selector-provenance.json). The canonical runner packages an owned Playwright 1.60.0 runtime copy with one original-attempt trace startup hook in its worker bundle; [owned runner provenance](compatibility/upstream/owned-runner-provenance.json) records every original file and the adaptation. The copy retains the original license and third-party notices plus its modification notice. The isolated dependency also supplies declaration types. The plain library does not load the runner. Chromium binaries are acquired separately and are not redistributed by this repository

Cookie URL rewriting and filtering adapt the pinned network helpers. [Cookie helper provenance](compatibility/upstream/cookie-helpers-provenance.json) records the retained extract, hashes and validation changes under the same Apache-2.0 license and notice.

The native API cookie jar adapts the pinned cookie store and response-cookie parsing rules. [API cookie provenance](compatibility/upstream/api-request-cookies-provenance.json) records complete retained source sections and native ownership changes under the same Apache-2.0 license and notice.

Native API cookie expiry adapts the V8 date-string grammar retained in Node 22.22.0. [Date parser provenance](compatibility/upstream/api-request-date-provenance.json) records the complete upstream files, hashes and Rust translation. The original V8 [BSD license and attribution](compatibility/upstream/LICENSE.v8-date-parser) are retained and must accompany redistributed binaries containing this parser.

Snapshot reconstruction and HAR trace-entry conventions adapt the pinned viewer and recorder contracts. [Snapshot provenance](compatibility/upstream/snapshot-provenance.json) and [network trace provenance](compatibility/upstream/network-trace-provenance.json) retain the exact source extracts, implementation hashes and changes under the same Apache-2.0 license and notice. The native collector and resource ownership are independently implemented.

## L2 Other dependencies

Cargo.lock and bun.lock pin the development dependency graphs. Their upstream license files remain in the installed packages. Release packaging must generate and verify the complete notices for the binaries and JavaScript packages it actually distributes, as required by SPECS.md S18.i

## L3 Native API request transport

The native API transport uses Hyper 1.11.1 under the MIT license. The complete published crate is retained in [vendor/hyper](vendor/hyper), including its [license](vendor/hyper/LICENSE). [Transport provenance](vendor/hyper-provenance.json) records the published archive checksum, retained file checksums and a five-file patch. The patch adds an opt-in bounded copy of initial HTTP/1 response fields for original field order, casing and reason-phrase bytes; it does not change HTTP framing or TLS. A separate opt-in feature retains the original transport memory allowance through response-body drop, covering queued data and response-head extraction in the native API consumer. HTTP/1 trailer declarations retain their original header values and defer name matching until actual trailers arrive, avoiding per-token allocations while preserving client and server filtering.

Hyper Util 0.1.20 is also retained in full in [vendor/hyper-util](vendor/hyper-util), including its [MIT license](vendor/hyper-util/LICENSE). [Connection custody provenance](vendor/hyper-util-provenance.json) records the published archive, retained files and four-file opt-in patch. The patch carries an opaque lifetime guard outside the complete HTTP dispatcher future so its memory allowance survives teardown, and a separate guard through the final pool-table drop. The same connection guard follows returned response bodies until their actual drop. Pool keys retain compact authority text instead of entire request URLs; waiter queues release excessive historical capacity after cancellation or delivery. Outstanding pooled, connecting and idle-timer owners retain the original pool allowance through teardown. Its explicit `cancel_unused_connects` option drops a losing speculative connection when pool reuse wins, preserving request-scoped cancellation. Its explicit `without_upgrades` option keeps upgrade I/O and buffered bytes inside that guarded task; the default upgrade behavior is unchanged.

Cargo.lock pins Hyper Rustls, Rustls, Tokio and the remaining transport dependencies. Their licenses must also be included in the complete binary release notices required by S18.i.

The response decoder uses unmodified flate2 1.1.10 (MIT or Apache-2.0), zlib-rs 0.6.8 (Zlib), and brotli-decompressor 5.0.3 (published BSD-3-Clause/MIT metadata; the retained license contains the BSD three-clause terms). [Decoder provenance](compatibility/upstream/api-request-decoder-provenance.json) records archive checksums, reviewed source identities, selected features and retained license files. Flashwright implements its own bounded allocation and cancellation wrapper. These notices supplement the complete dependency notices required for binary releases.
