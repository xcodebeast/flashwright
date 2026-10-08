#!/usr/bin/env bash
set -euo pipefail
export PATH="$PWD/.tools/node-v24.15.0-darwin-arm64/bin:$PATH"
export FLASHWRIGHT_DRIVER_PATH="$PWD/target/release/flashwright-driver"
export FLASHWRIGHT_CONDITION_INSTRUMENTATION=0
export FLASHWRIGHT_RESIDENT_ASSERTIONS=1
export FLASHWRIGHT_BROWSER_PATH='/Users/P/Library/Caches/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-mac-arm64/chrome-headless-shell'
npm run verify:core > .cache/resident-coalescing-final-headless-on.log 2>&1
python3 .cache/archive-resident-load-core.py .cache/resident-coalescing-final-headless-on.log coalescing-final-headless-on
export FLASHWRIGHT_RESIDENT_ASSERTIONS=0
npm run verify:core > .cache/resident-coalescing-final-headless-off.log 2>&1
python3 .cache/archive-resident-load-core.py .cache/resident-coalescing-final-headless-off.log coalescing-final-headless-off
export FLASHWRIGHT_RESIDENT_ASSERTIONS=1
export FLASHWRIGHT_BROWSER_PATH='/Users/P/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'
npm run verify:core > .cache/resident-coalescing-final-full-chrome-on.log 2>&1
python3 .cache/archive-resident-load-core.py .cache/resident-coalescing-final-full-chrome-on.log coalescing-final-full-chrome-on
export PATH="$PWD/.tools/node-v22.22.0-darwin-arm64/bin:$PATH"
{
 npm run test:assertions
 npm run test:lifecycle
 npm run test:conditions
} > compatibility/evidence/resident-coalescing-final-node22-2026-10-08.txt 2>&1
