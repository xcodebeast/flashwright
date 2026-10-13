# AGENTS.md

## G1 Entry point

Flashwright is the Rust browser-testing engine and TypeScript library specified in [SPECS.md](SPECS.md). The retired experiments aren't part of the main build

a. Before implementation, read [SPECS.md](SPECS.md) S1–S6, then load the sections named for the active milestone
b. For development environment and packaging, use [SPECS.md](SPECS.md) S18
c. For code changes and verification, follow [SPECS.md](SPECS.md) S19
d. Keep requirements in SPECS.md; this file routes agents to that source of truth

## G2 Workbench

a. Put all temporary files, private experiments, scratch scripts, raw runs and unpublished artifacts in ignored `workbench/`; keep product source and reviewed, sanitized release evidence in their normal paths
b. Before clearing `workbench/`, stop dependent jobs and unmount any volumes inside it
