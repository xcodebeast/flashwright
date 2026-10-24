#!/usr/bin/env python3
# Reads Chromium traces recorded with BENCH_CHROME_TRACE (run.mjs) and attributes thread CPU time
# (the events' tdur) by process, thread and what each task was doing.
# Usage: python3 bench/chrome-trace.py <trace.json or directory> [--self] [--top N]
#   default: top-level tasks, labelled by the DevTools command, mojo interface or posting location
#   --self:  self time of every event name, for categories such as devtools.timeline or v8
# Tasks of the tracing service itself are left out. Tracing slows Chromium down several times:
# compare shares, and take absolute CPU from thread-cpu.py.
import collections, glob, json, os, sys

args = [a for a in sys.argv[1:] if not a.startswith('--')]
self_mode = '--self' in sys.argv
top = int(sys.argv[sys.argv.index('--top') + 1]) if '--top' in sys.argv else 15
files = sorted(glob.glob(os.path.join(args[0], '*.json'))) if os.path.isdir(args[0]) else [args[0]]

def label(task, children):
  # The most telling event inside a top-level task.
  for e in children:
    a = e.get('args', {})
    if e['name'] == 'DevToolsSession::HandleCommand in Browser' or e['name'] == 'DevToolsSession::DispatchToAgent' and 'method' in a:
      return 'CDP ' + a.get('method', '?')
    if e['name'] == 'api_call':
      return 'CDP ' + a.get('method_name', '?')
  for e in children:
    info = e.get('args', {}).get('chrome_mojo_event_info', {})
    tag = info.get('mojo_interface_tag') or info.get('watcher_notify_interface_tag')
    if tag:
      return 'mojo ' + tag
  a = task.get('args', {})
  if 'src_file' in a:
    return f"post {a['src_file'].rsplit('/', 1)[-1]}:{a.get('src_func', '')}"
  return task['name']

def excluded(name):
  return 'tracing' in name or 'perfetto' in name or 'Perfetto' in name

totals = collections.Counter()
labels = collections.defaultdict(collections.Counter)
for file in files:
  events = json.load(open(file))
  events = events['traceEvents'] if isinstance(events, dict) else events
  processes = {e['pid']: e['args']['name'] for e in events if e.get('ph') == 'M' and e['name'] == 'process_name'}
  threads = {(e['pid'], e['tid']): e['args']['name'] for e in events if e.get('ph') == 'M' and e['name'] == 'thread_name'}
  by_thread = collections.defaultdict(list)
  for e in events:
    if e.get('ph') == 'X' and 'tdur' in e:
      by_thread[(e['pid'], e['tid'])].append(e)
  for key, xs in by_thread.items():
    process = processes.get(key[0], '?')
    thread = threads.get(key, '?')
    if excluded(process) or excluded(thread):
      continue
    where = f'{process[:24]:24s} {thread[:22]:22s}'
    xs.sort(key=lambda e: (e['ts'], -e.get('dur', 0)))
    # Walk the nesting: a stack of open events, each with its children's thread time.
    stack = []
    def close(item):
      e, child_time, nested = item
      if self_mode:
        labels[where][e['name']] += max(0, e['tdur'] - child_time)
      if stack:
        stack[-1][1] += e['tdur']
        stack[-1][2].extend([e] + nested)
      elif not self_mode:
        name = label(e, nested)
        if not excluded(name):
          labels[where][name] += e['tdur']
          totals[where] += e['tdur']
      if self_mode and not excluded(e['name']):
        totals[where] += max(0, e['tdur'] - child_time)
    for e in xs:
      while stack and stack[-1][0]['ts'] + stack[-1][0].get('dur', 0) <= e['ts']:
        close(stack.pop())
      stack.append([e, 0, []])
    while stack:
      close(stack.pop())

grand = sum(totals.values())
print(f'{grand / 1000:8.1f} ms thread time in {len(files)} trace(s)')
for where, total in totals.most_common():
  if total < grand * 0.01:
    continue
  print(f'\n{total / 1000:8.1f} ms {100 * total / grand:5.1f}%  {where}')
  for name, value in labels[where].most_common(top):
    print(f'    {value / 1000:8.1f} ms {100 * value / total:5.1f}%  {name}')
