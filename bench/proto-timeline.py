import re, sys, json
from datetime import datetime
lines = open(sys.argv[1]).read().splitlines()
t0 = None; sent = {}
start = sys.argv[2] if len(sys.argv) > 2 else None
active = start is None
for line in lines:
    m = re.match(r'(\S+Z) pw:(protocol|api) (.*)', line)
    if not m: continue
    ts = datetime.fromisoformat(m.group(1).replace('Z', '+00:00')).timestamp() * 1000
    kind, rest = m.group(2), m.group(3)
    if not active and start in rest: active = True
    if not active: continue
    if t0 is None: t0 = ts
    rel = ts - t0
    if kind == 'api':
        print(f'{rel:8.1f}  API {rest[:110]}'); continue
    direction = 'SEND' if 'SEND' in rest else 'RECV'
    try: msg = json.loads(rest[rest.index('{'):])
    except Exception: continue
    if direction == 'SEND':
        sent[msg.get('id')] = (rel, msg.get('method'))
        print(f'{rel:8.1f}  -> {msg.get("id")} {msg.get("method")} {str(msg.get("params",{}))[:70]}')
    elif 'id' in msg:
        st, meth = sent.get(msg['id'], (rel, '?'))
        print(f'{rel:8.1f}  <- {msg["id"]} {meth} ({rel-st:.1f}ms)')
    else:
        print(f'{rel:8.1f}  ev {msg.get("method")}')
