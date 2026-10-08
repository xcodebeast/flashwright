#!/usr/bin/env bash
set -euo pipefail
mkdir -p /workspace /output
tar -C /source --exclude=.git --exclude=.tools --exclude=.cache --exclude=node_modules --exclude=target --exclude='packages/*/dist' --exclude=test-results --exclude=benchmarks/results --exclude=compatibility/evidence -cf - . | tar -C /workspace -xf -
cd /workspace
mkdir -p .cache compatibility/evidence
export PATH="$HOME/.cargo/bin:$PATH"
archive_results() {
 mkdir -p /output/evidence
 cp -R compatibility/evidence/. /output/evidence/
 if [ -f /workspace/portable/flashwright-driver ]; then
  cp /workspace/portable/flashwright-driver /output/flashwright-driver-linux-x64
  sha256sum /output/flashwright-driver-linux-x64 > /output/driver-sha256.txt
 fi
 rustc --version > /output/rust-version.txt
}
trap archive_results EXIT
npm ci --ignore-scripts --no-audit --no-fund
python3 tools/watchdog.py --timeout 600 --report-directory compatibility/evidence/resources -- cargo test --workspace --locked --no-run
mkdir -p /workspace/portable
cp /source/.cache/portable-linux-runtime-058/flashwright-driver-linux-x64 /workspace/portable/flashwright-driver
unset FLASHWRIGHT_RESIDENT_ASSERTIONS
export FLASHWRIGHT_CONDITION_INSTRUMENTATION=0
export FLASHWRIGHT_DRIVER_PATH=/workspace/portable/flashwright-driver
export FLASHWRIGHT_TEST_NODE="$(command -v node)"
node tools/build-packages.mjs
cp /source/.cache/verify-platform-runtime-platform.mjs .cache/verify-platform-runtime-platform.mjs
python3 tools/watchdog.py --timeout 900 --report-directory compatibility/evidence/resources -- node .cache/verify-platform-runtime-platform.mjs compatibility/evidence/platform-runtime-portable-linux
