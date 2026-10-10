# Default failure documents

Failed attempts now attach `error-context.md` by default, including expected failures. Successful attempts produce no failure document. The document contains the test identity, error details, available matcher accessibility diagnostics and a source frame. When a matcher did not supply a diagnostic, Flashwright can capture the first eligible page body before context closure or at final teardown.

The [focused checkpoint](../compatibility/evidence/failure-context-checkpoint-2026-10-10.json) verifies 14 shared cases against Playwright1.60.0 on macOS arm64. Fresh Bun-installed packages pass with Bun1.4.2 and Node22.22.0/24.15.0, including tracing and failure screenshots. The completed document embedded in each trace matches the reporter attachment byte for byte. This is focused development acceptance; the broader merged core and release gates remain open.

| Behavior | Verified scope |
| --- | --- |
| Default policy | Independent of trace and screenshot settings |
| Matcher diagnostics | Original failing observation survives later page mutations |
| Fallback | Single main document; ordinary text matches the pinned AI snapshot renderer |
| Context closure | Original context stays associated with its attempt; successor pages cannot replace it |
| Hooks and retries | Final publication follows all hooks; retry success inherits no failure artifact |
| `PLAYWRIGHT_NO_COPY_PROMPT` | Suppresses fallback capture while retaining the document and matcher diagnostics |
| Optional failures | Preserve the test outcome and attach bounded `error-context-error` diagnostics |
| Trace integration | Final document bytes appear in the original attempt's trace |

Rendered child-frame composition is not supported by this fallback. Flashwright reports that omission instead of publishing a partial tree. Public ARIA snapshot modes have a separate capability contract.

The document is limited to256KiB,16 formatted errors and32768 UTF-16 units per diagnostic or stack. Source files are limited to8MiB with a64KiB retained window. Fallback snapshot text is limited to16384 UTF-16 units including its truncation marker. These are output and retained-data limits, not a bound on DOM traversal work. Fallback capture shares one five-second attempt budget; its optional trace preparation shares the original trace export deadline.

Playwright can attach the same document path twice when suite hooks share a test record. Flashwright publishes it once after all hooks. Direct browser closure and ordinary page closure do not introduce extra fallback captures.

Reproduce the shared gate after building and configuring `FLASHWRIGHT_BROWSER_PATH` and `FLASHWRIGHT_DRIVER_PATH`:

```sh
bun tools/run-failure-context-tests.mjs .cache/failure-context
FLASHWRIGHT_FAILURE_CONTEXT_ARTIFACTS=1 bun tools/run-failure-context-tests.mjs .cache/failure-context-packed --packed
PLAYWRIGHT_NO_COPY_PROMPT=1 bun tools/run-failure-context-tests.mjs .cache/failure-context-no-copy
python3 tools/watchdog.py --timeout 60 -- bun tools/test-failure-context-operation.mjs
```

Use a new output directory for each run. Node compatibility runs use the same commands with the selected Node executable and `FLASHWRIGHT_BUN_PATH` pointing to the pinned Bun package manager. Raw documents, traces and screenshots remain private because they contain local source paths; their hashes are retained in the portable checkpoint. No performance claim follows from these functional checks.
