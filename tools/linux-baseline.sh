#!/usr/bin/env bash
set -euo pipefail

mkdir -p /workspace
tar -C /source --exclude=.git --exclude=.tools --exclude=.cache --exclude=node_modules --exclude=target --exclude=test-results --exclude=benchmarks/results -cf - . | tar -C /workspace -xf -
cd /workspace
ln -s /results benchmarks/results
npm ci --ignore-scripts --no-audit --no-fund
result_directory="/results/$(python3 -c 'from datetime import datetime,timezone;import uuid; print(datetime.now(timezone.utc).strftime("%Y-%m-%dT%H-%M-%SZ") + "-linux-x64-" + uuid.uuid4().hex[:8])')"
export FLASHWRIGHT_RESULT_DIRECTORY="$result_directory"
python3 tools/watchdog.py --timeout 1200 --report "${result_directory}-resources.json" -- node benchmarks/run.mjs
node tools/verify-baseline.mjs "$result_directory"
