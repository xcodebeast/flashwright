# Reclaim discarded test heaps by lifetime instead of mixing them into long-lived heaps

Scope: large applications repeatedly creating and discarding DOM/JavaScript state in warm renderers. Effort: monumental, spanning V8 and Blink GC. Priority: exploratory; target large heaps, not an assumed TodoMVC win.

Research, 2026-10-31, against `c4c3583b` and retained design evidence. No profiling or runtime changes.

## Where the work is

[`BrowserContext._resetForRecycle`](../packages/playwright-core/src/server/browserContext.ts) retires application pages while keeping useful renderer warmth. Application objects can survive young-generation collections and enter older heap storage before the page closes. Repeated large applications can therefore generate reclamation and fragmentation work alongside persistent engine state.

V8 already makes short-lived objects cheap through generational GC. [Orinoco's design](https://v8.dev/blog/trash-talk) includes concurrent/parallel collection; [Oilpan](https://v8.dev/blog/oilpan-library) integrates Blink's C++ graph with JavaScript reachability. The opportunity is not to invent those features or assume every dead object is individually traversed.

Earlier [ordinary-retirement GC controls](../workbench/ordinary-retirement-gc-001/decision.json) were deprioritized after a small diagnostic difference. This proposal changes allocation ownership for large promoted heaps, rather than repeating a forced-GC timing adjustment. Those old controls do not establish its benefit.

## Proposed change

Allocate eligible application objects into regions associated with a test context's lifetime. Keep engine code, shared immutable resources and objects with uncertain ownership in the ordinary heap. An allocation made while handling a callback needs a correct owner; the current stack's page alone is not sufficient evidence.

Track references entering a region through write barriers, native roots and cross-component handles. When the attempt ends, first stop its producers and retire its documents. If the collector proves that a region has no live incoming references, release its pages in bulk. If anything outside can still reach it, retain or collect it normally. A test boundary is a useful lifetime hint, never proof of unreachability.

Start with a narrow class of document-owned Blink allocations, using existing GC integration. Extend to JavaScript old-space allocations only if that first milestone shows enough remaining cost. Account for JS wrappers, ephemerons and cross-thread references before broadening the eligible set.

This differs from [storage generations](02-context-reset-epochs.md): those isolate cookies/databases; these regions organize in-memory objects. It also differs from application checkpoints: every test still runs application initialization with fresh globals.

## Compatibility boundary

Preserve reachable objects, detached nodes retained by another live page, opener/frame references, JSHandles, pending callbacks, shared resources and external buffers. Shared workers and uncertain native roots initially force ordinary collection. Do not weaken GC tracing or free a region merely because its original page closed.

Weak references, finalization, native destructors and resource shutdown must retain supported behavior. Finalization timing is observable even where nondeterministic; document any deliberate change and retain normal collection as the opt-out. Coverage/debugger roots must continue keeping their required objects alive.

Bound retained regions and fragmentation. An external reference that pins one small object must not silently retain gigabytes indefinitely; fall back to ordinary tracing/evacuation. Include all deferred sweeping and shutdown in resource accounting.

## Payoff and first decision

The target is less repeated tracing, promotion/copying and fragmentation across many discarded large applications, while retaining warm compiled code. Metadata and write barriers can instead make every allocation slower. This is only attractive if a material cost lies in promoted, soon-to-be-discarded state.

First attribute that cost later on large SPA/data-grid/editor workloads. Compare normal GC against one limited region implementation, including cross-page retention and adversarial escaped references. Reject it early if young-generation collection already removes most of the relevant work or region bookkeeping costs more.

Build on separate capacity. Run V8/cppgc lifetime and weak-reference tests, browser handle/frame/worker coverage, `tests/page` on `chromium-page` and `tests/playwright-test`, comparing failures against pristine upstream in `workbench/pw-src`. Report cold/warm, one/four-worker and large-heap cases beside the full [benchmark matrix](../bench/README.md), under the [shared rules](01-browser-native-actions.md#payoff-and-decision-test). No experiments now.
