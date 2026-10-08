from pathlib import Path
import datetime,json,os,shutil,subprocess,tempfile
profiles={
 'flashwright-chromium-125cde':'browser-watchdog-interrupt-2c14e730c82446dabb2ef54730f3ea61.json',
 'flashwright-chromium-YQNMor':'browser-watchdog-failed-owner-859abefa3ad84d2386c89b82eea5f050.json',
 'flashwright-chromium-uuJ04H':'browser-watchdog-failed-owner-55fa5626fe1b4d799885110c49d29c54.json',
 'flashwright-chromium-Y8jyZu':'browser-watchdog-interrupt-cf31c6f34a2c41d8a3b6389e17df79b8.json',
 'flashwright-chromium-YtwWNi':'browser-watchdog-stopped-driver-bcdfae4312954b41bfca12b940a348f1.json',
 'flashwright-chromium-3TomzP':'browser-watchdog-stopped-worker-ca3d9728cfe2444e9e71da228306d531.json',
}
commands=subprocess.check_output(['ps','-axo','args='],text=True)
destination=Path('.cache/console-cleanup-001/recovered-profiles'); destination.mkdir()
records=[]
for name,report_name in profiles.items():
 source=Path(tempfile.gettempdir())/name
 assert str(source) not in commands and ('--user-data-dir='+str(source)) not in commands, name
 report_path=Path('compatibility/evidence/resources')/report_name
 report=json.loads(report_path.read_text()); assert not report['remainingObservedProcesses']
 first=min(datetime.datetime.strptime(process['started'].strip(), '%a %b %d %H:%M:%S %Y').astimezone().timestamp() for process in report['processes'])
 stat=source.stat(); assert first<=stat.st_birthtime<=first+report['elapsedSeconds']+2, name
 lock=source/'SingletonLock'; lock_target=os.readlink(lock) if lock.is_symlink() else None
 if lock_target: assert int(lock_target.rsplit('-',1)[1]) in {process['process'] for process in report['processes']}
 target=destination/name
 records.append({'original':str(source),'retainedAt':str(target),'birthTime':stat.st_birthtime,'lastModified':stat.st_mtime,'resourceReport':str(report_path),'singletonLock':lock_target})
 shutil.move(source,target)
Path('.cache/console-cleanup-001/recovered-profiles.json').write_text(json.dumps({'scope':'Six temporary profiles left by the failed original watchdog and diagnostic-pipe probes. Matched to recorded test windows, checked for active use, and moved reversibly into ignored development storage. These failures are not claimed as successful automatic cleanup.','profiles':records},indent=2)+'\n')
print('Retained six failed-run profiles in ignored recovery storage; no active profile or process was modified.')
