#!/usr/bin/env python3
# Samples /proc every 5ms while a command runs and attributes CPU time by process kind and thread name.
# Usage: python3 bench/thread-cpu.py <command...>
import os, subprocess, sys, time, collections
tick = os.sysconf('SC_CLK_TCK')
def kind(cmd):
    if 'chrome' in cmd or 'headless_shell' in cmd:
        for t in ('renderer', 'gpu-process', 'utility', 'zygote'):
            if f'--type={t}' in cmd:
                return 'chrome:' + t
        return 'chrome:browser'
    if 'workerProcessEntry' in cmd: return 'node:worker'
    if 'node' in cmd: return 'node:main'
    return 'other'
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
kinds = {}
while proc.poll() is None:
    for pid in descendants(proc.pid):
        try:
            with open(f'/proc/{pid}/cmdline') as f: cmd = f.read().replace('\0', ' ')
            if cmd.strip(): kinds[pid] = kind(cmd)
            for tid in os.listdir(f'/proc/{pid}/task'):
                with open(f'/proc/{pid}/task/{tid}/stat') as f: data = f.read()
                name = data[data.index('(') + 1:data.rindex(')')]
                parts = data.rsplit(')', 1)[1].split()
                seen[(pid, tid)] = (name, (int(parts[11]) + int(parts[12])) / tick * 1000)
        except Exception: pass
    time.sleep(0.005)
totals = collections.Counter()
for (pid, tid), (name, ms) in seen.items():
    totals[(kinds.get(pid, '?'), name)] += ms
for (k, name), v in totals.most_common(30): print(f'{v:8.0f} ms  {k:18s} {name}')
