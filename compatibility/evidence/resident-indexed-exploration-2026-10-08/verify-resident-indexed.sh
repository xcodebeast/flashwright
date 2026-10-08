#!/usr/bin/env bash
set -euo pipefail
export PLAYWRIGHT_SKIP_BROWSER_GC=1
export PATH="$PWD/.tools/node-v24.15.0-darwin-arm64/bin:$PATH"
export FLASHWRIGHT_DRIVER_PATH="$PWD/target/release/flashwright-driver"
export FLASHWRIGHT_CONDITION_INSTRUMENTATION=0
export FLASHWRIGHT_RESIDENT_ASSERTIONS=1
export FLASHWRIGHT_BROWSER_PATH='/Users/P/Library/Caches/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-mac-arm64/chrome-headless-shell'
npm run verify:core > .cache/resident-indexed-headless-on.log 2>&1
python3 .cache/archive-resident-load-core.py .cache/resident-indexed-headless-on.log indexed-headless-on
export FLASHWRIGHT_RESIDENT_ASSERTIONS=0
npm run verify:core > .cache/resident-indexed-headless-off.log 2>&1
python3 .cache/archive-resident-load-core.py .cache/resident-indexed-headless-off.log indexed-headless-off
export FLASHWRIGHT_RESIDENT_ASSERTIONS=1
export FLASHWRIGHT_BROWSER_PATH='/Users/P/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'
npm run verify:core > .cache/resident-indexed-full-chrome-on.log 2>&1
python3 .cache/archive-resident-load-core.py .cache/resident-indexed-full-chrome-on.log indexed-full-chrome-on
export PATH="$PWD/.tools/node-v22.22.0-darwin-arm64/bin:$PATH"
{
 npm run test:assertions
 npm run test:lifecycle
 npm run test:conditions
} > compatibility/evidence/resident-indexed-node22-2026-10-08.txt 2>&1
