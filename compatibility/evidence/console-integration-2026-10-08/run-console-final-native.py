from pathlib import Path
import json, os, shutil, subprocess
root=Path.cwd()
core=root/'.cache/console-core-003';core.mkdir()
base={**os.environ,'PLAYWRIGHT_SKIP_BROWSER_GC':'1','FLASHWRIGHT_RESIDENT_ASSERTIONS':'0','FLASHWRIGHT_CONDITION_INSTRUMENTATION':'0','FLASHWRIGHT_DRIVER_PATH':str(root/'target/debug/flashwright-driver')}
node24=root/'.tools/node-v24.15.0-darwin-arm64/bin/node'
node22=root/'.tools/node-v22.22.0-darwin-arm64/bin/node'
native={**base,'PATH':str(node24.parent)+os.pathsep+os.environ['PATH'],'FLASHWRIGHT_TEST_NODE':str(node24),'FLASHWRIGHT_BROWSER_PATH':'/Users/P/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'}
command=['python3','tools/watchdog.py','--timeout','900','--report-directory',str(core/'resources'),'--',str(node24),'tools/verify-core.mjs']
(core/'command.json').write_text(json.dumps(command,indent=2))
with (core/'run.log').open('w') as log:
    result=subprocess.run(command,env=native,stdout=log,stderr=subprocess.STDOUT)
if result.returncode: raise SystemExit(result.returncode)
shutil.copy2(root/'target/debug/flashwright-driver',core/'flashwright-driver')
subprocess.run(['python3','.cache/archive-console-core.py',str(core/'run.log'),'console-003'],check=True)
node_environment={**base,'PATH':str(node22.parent)+os.pathsep+os.environ['PATH'],'FLASHWRIGHT_TEST_NODE':str(node22),'FLASHWRIGHT_BROWSER_PATH':'/Users/P/Library/Caches/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-mac-arm64/chrome-headless-shell'}
command=['python3','tools/watchdog.py','--timeout','600','--report-directory','.cache/console-node22-002-resources','--',str(node22),'.cache/verify-console-platform.mjs','.cache/console-node22-002']
with (root/'.cache/console-node22-002.log').open('w') as log:
    result=subprocess.run(command,env=node_environment,stdout=log,stderr=subprocess.STDOUT)
raise SystemExit(result.returncode)
