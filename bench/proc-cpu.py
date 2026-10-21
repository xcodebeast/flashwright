#!/usr/bin/env python3
# Samples /proc every 5ms while a command runs and attributes CPU time (utime+stime) by process kind.
import os, subprocess, sys, time, collections
tick = os.sysconf('SC_CLK_TCK')
def kind(cmd):
    if 'chrome' in cmd or 'headless_shell' in cmd:
        for t in ('renderer', 'gpu-process', 'utility', 'zygote'):
            if f'--type={t}' in cmd:
                return 'chrome:' + t + (':network' if 'network' in cmd else '')
        return 'chrome:browser'
    if 'workerProcessEntry' in cmd: return 'node:worker'
    if 'node' in cmd: return 'node:main'
    return 'other:' + cmd.split(' ')[0].split('/')[-1]
proc = subprocess.Popen(sys.argv[1:], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
seen = {}
def descendants(root):
    children = collections.defaultdict(list)
    for pid in os.listdir('/proc'):
        if not pid.isdigit(): continue
        try:
            with open(f'/proc/{pid}/stat') as f: parts = f.read().rsplit(')', 1)[1].split()
            children[int(parts[1])].append(int(pid))
        except Exception: pass
    out, stack = [], [root]
    while stack:
        p = stack.pop(); out.append(p); stack.extend(children.get(p, []))
    return out
while proc.poll() is None:
    for pid in descendants(proc.pid):
        try:
            with open(f'/proc/{pid}/stat') as f: parts = f.read().rsplit(')', 1)[1].split()
            with open(f'/proc/{pid}/cmdline') as f: cmd = f.read().replace('\0', ' ')
            # Exited (zombie) processes have an empty command line; keep the kind seen earlier.
            k = seen[pid][0] if pid in seen and not cmd.strip() else kind(cmd)
            seen[pid] = (k, (int(parts[11]) + int(parts[12])) / tick * 1000)
        except Exception: pass
    time.sleep(0.005)
totals = collections.Counter(); counts = collections.Counter()
for k, ms in seen.values(): totals[k] += ms; counts[k] += 1
for k, v in totals.most_common(): print(f'{v:8.0f} ms  x{counts[k]:<3} {k}')
print(f'{sum(totals.values()):8.0f} ms  total (sampled; misses the last few ms of short-lived processes)')
