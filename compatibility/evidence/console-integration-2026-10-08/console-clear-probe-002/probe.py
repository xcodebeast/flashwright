import json
from pathlib import Path
from test_driver_protocol import OwnedDriverCase
case=OwnedDriverCase(); case.setUp()
try:
 case.request('page.console.subscribe', {'page':case.page,'enabled':True})
 case.request('page.evaluate', case.evaluation('console.log({answer:42})'))
 event=next(event['parameters'] for event in case.events if event['event']=='console')
 case.request('page.evaluate', case.evaluation('console.clear()'))
 case.send(case.command('handle.dispose', {'page':case.page,'handle':event['handles'][0]['identifier']}))
 Path('.cache/console-clear-probe-002/report.json').write_text(json.dumps(case.receive(),indent=2)+'\n')
finally: case.doCleanups()
