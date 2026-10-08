from pathlib import Path
import json,os,re,subprocess
root=Path.cwd(); destination=root/'.cache/event-path-profiles-001';destination.mkdir()
node=root/'.tools/node-v24.15.0-darwin-arm64/bin/node'
verification=Path('.cache/event-profile-native-001/core-path.txt').read_text().strip()
environment={**os.environ,'PATH':str(node.parent)+os.pathsep+os.environ['PATH'],'PLAYWRIGHT_SKIP_BROWSER_GC':'1','FLASHWRIGHT_DRIVER_PATH':str(root/'target/release/flashwright-driver'),'FLASHWRIGHT_TEST_NODE':str(node),'FLASHWRIGHT_BROWSER_PATH':'/Users/P/Library/Caches/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-mac-arm64/chrome-headless-shell','FLASHWRIGHT_RESIDENT_ASSERTIONS':'0','FLASHWRIGHT_CONDITION_INSTRUMENTATION':'0','FLASHWRIGHT_VERIFICATION_REPORT':verification}
results=[]
for label,script,verifier in [('default-first','benchmarks/paired.mjs','tools/verify-paired.mjs'),('default-replication','benchmarks/paired.mjs','tools/verify-paired.mjs'),('attribution','benchmarks/attribution.mjs','tools/verify-attribution.mjs')]:
    command=['python3','tools/watchdog.py','--timeout','600','--report-directory',str(destination/'resources'),'--',str(node),script]
    with (destination/f'{label}.log').open('w') as log:
        result=subprocess.run(command,env=environment,stdout=log,stderr=subprocess.STDOUT)
    entry={'label':label,'command':command,'exitCode':result.returncode};results.append(entry)
    (destination/'attempts.json').write_text(json.dumps(results,indent=2))
    if result.returncode:raise SystemExit(result.returncode)
    text=(destination/f'{label}.log').read_text();match=re.search(r'"destination": "([^"]+)"',text);assert match
    entry['directory']=match.group(1)
    with (destination/f'{label}-verification.log').open('w') as log:
        checked=subprocess.run([str(node),verifier,entry['directory']],env=environment,stdout=log,stderr=subprocess.STDOUT)
    entry['verificationExitCode']=checked.returncode
    (destination/'attempts.json').write_text(json.dumps(results,indent=2))
    print(json.dumps(entry),flush=True)
    if checked.returncode:raise SystemExit(checked.returncode)
