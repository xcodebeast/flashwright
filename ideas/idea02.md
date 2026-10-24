# Idea 02: Remove Chromium protection subsystems

Status: proposal. Main-build requirements remain in [SPECS.md](../SPECS.md); adoption requires updating S4/S13/S18/S19.

## Requirements

- Remove OS sandbox setup, policies, enforcement integrations and sandbox-only broker paths for supported platforms; replace dependencies needed for ordinary browser operations.
- Remove site-isolation policy, enforcement and isolation-only process/IPC machinery. Refactor shared machinery to preserve required frame/navigation behavior; document remaining process boundaries. Removal does not require single-process execution.
- Remove V8 sandbox-specific memory cages, indirection, checks and supporting machinery; adapt affected representations and allocation paths. Retain JIT compilation, garbage collection and unrelated memory mechanisms.
- Preserve CORS, CSP, same-origin rules, TLS validation, permissions, application scheduling, trusted input and test/context storage isolation.
- Identify the custom build explicitly in configuration and reports. Reject unsupported builds/platforms; do not substitute a stock browser with disabling flags.
