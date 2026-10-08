#!/usr/bin/env bash
set -euo pipefail
export PLAYWRIGHT_SKIP_BROWSER_GC=1
export PATH="$PWD/.tools/node-v24.15.0-darwin-arm64/bin:$PATH"
cargo fmt --all
mkdir -p .cache/output-limits-002
cargo build --workspace --locked > .cache/output-limits-002/debug-build.log 2>&1
cargo build --release --workspace --locked > .cache/output-limits-002/release-build.log 2>&1
cp target/release/flashwright-driver .cache/output-limits-002/flashwright-driver
shasum -a 256 .cache/output-limits-002/flashwright-driver > .cache/output-limits-002/driver-sha256.txt
export FLASHWRIGHT_DRIVER_PATH="$PWD/target/release/flashwright-driver"
export FLASHWRIGHT_CONDITION_INSTRUMENTATION=0
export FLASHWRIGHT_RESIDENT_ASSERTIONS=1
export FLASHWRIGHT_BROWSER_PATH='/Users/P/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'
npm run verify:core > .cache/output-limits-002/full-chrome-on.log 2>&1
python3 .cache/archive-storage-core.py .cache/output-limits-002/full-chrome-on.log output-limits-full-chrome-on
export FLASHWRIGHT_RESIDENT_ASSERTIONS=0
export FLASHWRIGHT_BROWSER_PATH='/Users/P/Library/Caches/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-mac-arm64/chrome-headless-shell'
npm run verify:core > .cache/output-limits-002/headless-off.log 2>&1
python3 .cache/archive-storage-core.py .cache/output-limits-002/headless-off.log output-limits-headless-off
