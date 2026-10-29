# Build reports while results arrive instead of rebuilding at exit

**Scope:** large suites, step-heavy tests, blob reports and HTML reports. **Effort:** medium to large. **Priority:** strong candidate for reducing end-of-run latency and memory together.

Research proposal, 2026-10-29. No measurements. This targets runner reporting, independently of [browser trace capture](07-incremental-trace-recording.md). Trace-off suites can still generate expensive reports.

## Evidence and opportunity

[`BlobReporter`](../packages/playwright/src/reporters/blob.ts) retains every serialized event in `_messages`. At `onEnd`, it maps the complete list to JSON strings, then feeds those strings to a ZIP stream. `Readable.from(lines)` does not avoid the prior full-list string allocation. Event objects and serialized lines can coexist at the finish.

[`HtmlBuilder`](../packages/playwright/src/reporters/html.ts) constructs report data from results, serializes per-file data, processes attachments and writes the final report. Some output is already streamed, including base64 encoding, so replacing the whole writer with another generic stream is insufficient. The opportunity is less retained/repeated representation and less mandatory work after the final test.

## Design

Start with blob reporting: append serialized events to a private bounded spool as they arrive, preserving exact order and schema. At finish, add the spool as `report.jsonl` to the existing archive, rather than materializing a second full in-memory representation. A later stage can compress incrementally if it preserves final archive and error behavior.

Serialize in bounded batches to avoid adding a write syscall per step. Keep queue ownership explicit, and propagate write failures through the reporter's normal failure path. Spooling alone may add I/O; first establish whether lower allocation/GC and exit latency outweigh that cost on representative storage.

For HTML, incrementally prepare immutable result fragments and attachment metadata only after their relevant lifecycle is complete. Maintain a small final index for outcomes, retries, sorting and project/file summaries. Final assembly must retain the existing viewer format and sorting. Do not declare an entire file finished merely because one worker completed a group: retries, other projects and later events may still update it.

Keep arbitrary custom reporters on their existing callback/object model. Built-in report preparation must not delay, reorder or clone away custom reporter observations. Early serialization can change behavior if result objects or attachment files are modified later; establish supported mutation boundaries from the current reporter pipeline and retain late materialization wherever required. Begin with the built-in blob event representation before attempting shared immutable records across all reporters.

## Compatibility boundary

Preserve event IDs, step nesting, stdout/stderr order, attachments, errors, retries, annotations, shard metadata and merge-reports behavior. Keep artifact lookup/deletion timing equivalent: copying an attachment early may capture different bytes than today's end-of-run read. Do not silently change that to claim an overlap win.

Preserve output-directory cleanup, filename conflict behavior and reporter exit/error semantics. Use a private staging location, publish final output at the established point, and clean up on cancellation. Required writes/compression must finish before `onEnd` resolves; no work hidden after CLI exit. Queue limits must apply backpressure rather than dropping records.

## Payoff and later validation

Potential wins are reduced resident report data, fewer allocation spikes and a smaller final reporting tail. Work is only overlapped when spare resources exist; continuous compression on a saturated machine can slow tests. Keep small-report buffering if it is faster, and limit any auxiliary worker concurrency.

First implement a blob event spool and compare decoded JSONL/attachments exactly with the existing reporter. Then measure full command duration, report-finalization time, peak RSS, GC and disk traffic on large step-heavy suites; include interrupted runs and disk failures.

Later run reporter/blob/HTML/merge suites in `tests/playwright-test`, `tests/page` on `chromium-page`, and artifact/trace integration against pristine upstream in `workbench/pw-src`. Add reporter-heavy rows beside `node bench/run.mjs todomvc 1 15 stock,fork` and `node bench/matrix.mjs 15`, plus a current-fork baseline. Follow the [shared evaluation rules](01-browser-native-actions.md#payoff-and-decision-test), counting every final flush and cleanup.
