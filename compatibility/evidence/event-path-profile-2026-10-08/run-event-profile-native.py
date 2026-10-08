from pathlib import Path
import json,os,re,shutil,subprocess
root=Path.cwd(); destination=root/'.cache/event-profile-native-001'
node=root/'.tools/node-v24.15.0-darwin-arm64/bin/node'
environment={**os.environ,'PATH':str(node.parent)+os.pathsep+os.environ['PATH'],'PLAYWRIGHT_SKIP_BROWSER_GC':'1','FLASHWRIGHT_DRIVER_PATH':str(root/'target/release/flashwright-driver'),'FLASHWRIGHT_TEST_NODE':str(node),'FLASHWRIGHT_BROWSER_PATH':'/Users/P/Library/Caches/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-mac-arm64/chrome-headless-shell','FLASHWRIGHT_RESIDENT_ASSERTIONS':'0','FLASHWRIGHT_CONDITION_INSTRUMENTATION':'0'}
commands=[('build',['python3','tools/watchdog.py','--timeout','300','--report-directory',str(destination/'resources'),'--','cargo','build','--workspace','--release','--locked']),('core',['python3','tools/watchdog.py','--timeout','900','--report-directory',str(destination/'resources'),'--',str(node),'tools/verify-core.mjs'])]
for label,command in commands:
    (destination/f'{label}-command.json').write_text(json.dumps(command,indent=2))
    with (destination/f'{label}.log').open('w') as log:
        result=subprocess.run(command,env=environment,stdout=log,stderr=subprocess.STDOUT)
    if result.returncode: raise SystemExit(result.returncode)
match=re.search(r'Core verification passed: (.+/report.json)',(destination/'core.log').read_text());assert match
report_path=Path(match.group(1));report=json.loads(report_path.read_text());assert report['status']=='passed'
(destination/'core-path.txt').write_text(str(report_path)+'\n')
shutil.copy2(root/'target/release/flashwright-driver',destination/'flashwright-driver')
artifacts=report_path.parent/'artifacts';artifacts.mkdir(exist_ok=True)
for name in ['navigation','assertions','benchmark-contract','keyboard','locators','migration-todomvc','native-runner','packed-library','packed-runner','pointer']:
    source=root/'compatibility/evidence'/f'{name}-darwin-arm64-24.15.0.json';shutil.copy2(source,artifacts/source.name)
print(report_path,report['driverSha256'],flush=True)
