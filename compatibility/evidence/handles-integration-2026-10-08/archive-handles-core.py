import hashlib,json,re,shutil,sys
from pathlib import Path
log=Path(sys.argv[1]); label=sys.argv[2]
match=re.search(r'Core verification passed: (.+/report.json)',log.read_text()); assert match,log
path=Path(match.group(1));report=json.loads(path.read_text());assert report['status']=='passed' and len(report['checks'])==33
for check in report['checks']:assert hashlib.sha256((path.parent/check['log']).read_bytes()).hexdigest()==check['logSha256']
for source,digest in report['sources'].items():assert hashlib.sha256(Path(source).read_bytes()).hexdigest()==digest,source
artifacts=path.parent/'artifacts';artifacts.mkdir(exist_ok=True)
for name in ['navigation','assertions','benchmark-contract','keyboard','locators','migration-todomvc','native-runner','packed-library','packed-runner','pointer']:
 source=Path('compatibility/evidence')/(name+'-darwin-arm64-24.15.0.json');shutil.copy2(source,artifacts/source.name)
for source in Path('compatibility/evidence').glob('resident-registry-darwin-arm64-24.15.0-*.json'):
 if json.loads(source.read_text())['sources']==report['sources']:shutil.copy2(source,artifacts/source.name)
Path('.cache/resident-core-'+label+'-path.txt').write_text(str(path)+'\n')
print(label,path,len(report['sources']),report['driverSha256'])
