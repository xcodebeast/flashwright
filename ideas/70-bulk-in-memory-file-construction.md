# Construct uploaded files without a JavaScript callback for every byte

Scope: buffer-based setInputFiles calls with megabyte-scale files. Effort: small to medium for native decoding; very large for direct Blob transfer. Priority: a strong focused candidate with a stock-browser first step.

**Assessed 2026-10-31:** implemented (`9f40ad01`): the injected script decodes upload buffers with `Uint8Array.fromBase64` (or a plain loop) instead of a callback per byte. `setInputFiles` with a buffer: 1 MB 75 -> 28 ms, 5 MB 298 -> 79 ms, 20 MB 1115 -> 250 ms; uploaded bytes verified identical on Chromium and Firefox.

Research, 2026-10-31, against `2bc2768b` plus the live worktree. No files uploaded or buffers decoded.

## Evidence and opportunity

[`prepareFilesForUpload`](../packages/playwright-core/src/server/fileUploadUtils.ts) converts payload Buffers to base64. [`InjectedScript.setInputFiles`](../packages/injected/src/injectedScript.ts) reconstructs each with `Uint8Array.from(atob(file.buffer), c => c.charCodeAt(0))`, then creates a File and DataTransfer. A large file therefore runs a JavaScript mapping callback for every decoded byte, besides allocating the intermediate binary string.

Local path uploads already use a different native path. [Idea 37](37-content-addressed-remote-upload-fixtures.md) avoids retransmitting remote files, and [idea 57](57-binary-route-response-bodies.md) changes fulfilled network responses. Neither removes this in-memory File-construction loop.

## Proposed change

First use a verified native `Uint8Array.fromBase64` implementation where available, retaining the existing fallback. The [TC39 algorithm](https://tc39.es/proposal-arraybuffer-base64/spec/#sec-uint8array.frombase64) decodes into a typed array directly. Select support per execution realm/browser; do not assume every supported engine implements it correctly merely because the property exists.

Keep File creation, metadata, DataTransfer assignment and event dispatch unchanged. The input here is framework-generated canonical base64, so broad differences in malformed-input handling need not become a new user API. Still preserve existing behavior for altered builtins or unsupported execution environments where required.

For a larger second stage, add a browser command that supplies immutable byte segments to Blob/File construction without embedding their contents in an evaluated script. Send metadata and a byte-source lease, then construct the same Files at the existing operation boundary. This needs browser integration and explicit ownership; generic binary CDP alone does not remove base64 embedded inside the evaluation argument.

Do not implement the larger stage by writing a temporary file and calling native file selection without checking semantics. That can change MIME inference, lastModified, event trust and file lifetime. Use the same File metadata and existing synthetic input/change behavior, including their order and flags.

## Compatibility boundary

Preserve selection validation, the current payload size limit, file order, names, MIME types, bytes, lastModified and detached-input errors. Directory and local-path behavior remain on their existing paths. Application code must see the same File objects and event properties.

Capture user Buffer contents at the current boundary; a shared-memory lease must not let later mutations change the upload. Retain Blob backing bytes while a page keeps a File reference, even after input selection changes. Release staging on navigation, cancellation and context disposal without invalidating still-live objects prematurely.

## Payoff and later decision

Native decoding removes per-byte JS execution and an intermediate string. The larger design also removes base64 expansion and protocol copies. Neither removes the application's later upload or File reads. Small payloads may see no benefit; the native-decode step must be measured separately before funding the browser extension.

Later compare complete setInputFiles calls and browser-observed bytes/metadata/events for empty, small and near-limit payloads. Include repeated selections, retained Files, page close and one/four workers. Run input-file tests and upstream page/runner suites against pristine upstream, reporting targeted rows, current-fork controls and the full [matrix](../bench/README.md) under the [shared rules](01-browser-native-actions.md#payoff-and-decision-test). No execution now.
