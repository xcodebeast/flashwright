#!/usr/bin/env bash
set -euo pipefail
export PLAYWRIGHT_SKIP_BROWSER_GC=1
export PATH="$PWD/.tools/node-v24.15.0-darwin-arm64/bin:$PATH"
export FLASHWRIGHT_DRIVER_PATH="$PWD/target/release/flashwright-driver"
export FLASHWRIGHT_BROWSER_PATH='/Users/P/Library/Caches/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-mac-arm64/chrome-headless-shell'
export FLASHWRIGHT_CONDITION_INSTRUMENTATION=0
export FLASHWRIGHT_VERIFICATION_REPORT
run_profile() {
 local profile="$1"
 local label="$2"
 local result_path
 npm run "benchmark:$profile" > ".cache/evaluation-helper-$label.log" 2>&1
 result_path=$(python3 - "$label" <<'PYTHON'
from pathlib import Path
import re,sys
label=sys.argv[1]
text=Path('.cache/evaluation-helper-'+label+'.log').read_text()
path=re.findall(r'"destination": "([^"]+)"',text)[-1]
Path('.cache/evaluation-helper-'+label+'-path.txt').write_text(path+'\n')
print(path)
PYTHON
)
 node "tools/verify-$profile.mjs" "$result_path" > ".cache/evaluation-helper-$label-verification.log" 2>&1
}
export FLASHWRIGHT_RESIDENT_ASSERTIONS=0
FLASHWRIGHT_VERIFICATION_REPORT=$(cat .cache/resident-core-evaluation-helper-headless-off-path.txt)
run_profile paired off-first
run_profile paired off-replication
export FLASHWRIGHT_RESIDENT_ASSERTIONS=1
FLASHWRIGHT_VERIFICATION_REPORT=$(cat .cache/resident-core-evaluation-helper-headless-on-path.txt)
run_profile paired on-first
run_profile paired on-replication
run_profile attribution attribution
