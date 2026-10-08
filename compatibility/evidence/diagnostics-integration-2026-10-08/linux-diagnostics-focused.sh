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
 if [ -f target/debug/flashwright-driver ]; then
  cp target/debug/flashwright-driver /output/flashwright-driver-linux-x64
  sha256sum /output/flashwright-driver-linux-x64 > /output/driver-sha256.txt
 fi
 rustc --version > /output/rust-version.txt
}
trap archive_results EXIT
npm ci --ignore-scripts --no-audit --no-fund
python3 tools/watchdog.py --timeout 600 --report-directory compatibility/evidence/resources -- cargo test --workspace --locked --no-run
cargo build --workspace --locked
export FLASHWRIGHT_DRIVER_PATH=/workspace/target/debug/flashwright-driver
node tools/build-packages.mjs
cp /source/.cache/verify-diagnostics-platform.mjs .cache/verify-diagnostics-platform.mjs
python3 tools/watchdog.py --timeout 900 --report-directory compatibility/evidence/resources -- node .cache/verify-diagnostics-platform.mjs compatibility/evidence/diagnostics-focused-linux
