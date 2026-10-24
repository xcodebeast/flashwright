# Idea 01: Per-test browser capability contracts

Status: proposal; no implementation or performance claim. Main-build requirements remain in [SPECS.md](../SPECS.md); adoption requires updating its affected sections.

## Goal

Let tests declare required browser capabilities before browser/context creation. A specialized backend may omit optional subsystem initialization, allocations and work outside that contract. Default execution remains unchanged.

## Illustrative API

```ts
test.defineFeatures({
  navigation: true,
  javascript: true,
  eventListeners: true,
  layout: true,
  painting: false,
  screenshots: false,
  storage: ["localStorage"],
  network: ["document", "fetch"],
});
```

Names/granularity are provisional. Declarations cover application code, dependencies, frames, workers and test operations—not only explicit test actions.

## Contract

- Opt-in strict mode: omitted capabilities are excluded; reject unknown entries. Resolve documented dependency closure before launch; reject explicit conflicts (e.g. screenshots enabled with painting disabled).
- Freeze the resolved contract for each attempt, including retries. Isolate incompatible contracts; never reuse state that violates one.
- Undeclared dependency causes a typed failure with capability, operation and available page/script location before its effects. Never silently ignore calls, fabricate success or automatically broaden the contract.
- Preserve API availability/probing semantics where supported; detect dependencies through feature probes and implicit browser behavior as well as API calls. Reject configurations whose exclusions cannot be enforced without silently changing the tested behavior.
- Layout, painting and capture are separate capabilities. Preserve required actionability, hit testing, input, event ordering and scheduling; reduced rendering needs evidence that these remain valid.
- Discovery mode uses the full backend to record observed use and suggest a declaration. Suggestions require review and are not proof of future coverage; strict enforcement remains active on every run.
- Separate capability restrictions from transparent execution optimizations. Report restricted runs as validating the declared environment, not unrestricted browser compatibility.
