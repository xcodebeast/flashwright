#!/usr/bin/env python3
# Like proc-cpu.py, but counts every process on the machine while the command runs: a warm session's
# runner, workers and browsers are not descendants of the `playwright test` process.
import os, subprocess, sys, time, collections
tick = os.sysconf('SC_CLK_TCK')
def kind(cmd):
    if 'chrome' in cmd or 'headless_shell' in cmd:
        for t in ('renderer', 'gpu-process', 'utility', 'zygote'):
            if f'--type={t}' in cmd:
                return 'chrome:' + t + (':network' if 'network' in cmd else '')
        return 'chrome:browser'
    if 'workerProcessEntry' in cmd: return 'node:worker'
    if '--flashwright-session' in cmd: return 'node:session'
    if 'node' in cmd: return 'node:main'
    return 'other:' + cmd.split(' ')[0].split('/')[-1]
def snap():
    out = {}
    for pid in os.listdir('/proc'):
        if not pid.isdigit(): continue
        try:
            with open(f'/proc/{pid}/stat') as f: parts = f.read().rsplit(')', 1)[1].split()
            out[int(pid)] = (int(parts[11]) + int(parts[12])) / tick * 1000
        except Exception: pass
    return out
def stat_total():
    v = list(map(int, open('/proc/stat').readline().split()[1:]))
    return (sum(v) - v[3] - v[4]) / tick * 1000
base = snap(); kinds = {}
t0 = stat_total(); w0 = time.time()
proc = subprocess.Popen(sys.argv[1:], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
last = {}
while proc.poll() is None:
    for pid, ms in snap().items():
        last[pid] = ms
        if pid not in kinds or not kinds[pid]:
            try:
                with open(f'/proc/{pid}/cmdline') as f: cmd = f.read().replace('\0', ' ')
                kinds[pid] = kind(cmd) if cmd.strip() else kinds.get(pid)
            except Exception: pass
    time.sleep(0.005)
wall = (time.time() - w0) * 1000; sys_cpu = stat_total() - t0
totals = collections.Counter(); counts = collections.Counter()
for pid, ms in last.items():
    d = ms - base.get(pid, 0)
    if d > 0 and kinds.get(pid):
        totals[kinds[pid]] += d; counts[kinds[pid]] += 1
for k, v in totals.most_common(12): print(f'{v:8.0f} ms  x{counts[k]:<3} {k}')
print(f'{sum(totals.values()):8.0f} ms  sampled total; system busy {sys_cpu:.0f} ms over {wall:.0f} ms wall = {sys_cpu/wall:.2f} cores')
