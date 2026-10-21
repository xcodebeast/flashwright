#!/usr/bin/env python3
# Summarizes V8 .cpuprofile files (node --cpu-prof).
#   python3 bench/cpuprofile.py self <profile> [N]            self time by file and by function
#   python3 bench/cpuprofile.py tree <profile> <match> [depth] inclusive time below the first frame
#                                                              whose label contains <match>
#   python3 bench/cpuprofile.py modules <profile> [N]          self time per bundled module initializer
import collections, json, sys

def load(path):
    p = json.load(open(path))
    nodes = {n['id']: n for n in p['nodes']}
    parent = {c: n['id'] for n in p['nodes'] for c in n.get('children', [])}
    self_ms = collections.Counter()
    for sample, delta in zip(p['samples'], p['timeDeltas']):
        self_ms[sample] += delta / 1000
    return p, nodes, parent, self_ms

def label(node):
    cf = node['callFrame']
    url = cf['url'].split('/packages/')[-1] if '/packages/' in cf['url'] else cf['url'].split('/')[-1]
    return f"{cf['functionName'] or '(anon)'} {url}:{cf['lineNumber']}"

def cmd_self(path, top=25):
    _, nodes, _, self_ms = load(path)
    by_file, by_fn = collections.Counter(), collections.Counter()
    for nid, ms in self_ms.items():
        cf = nodes[nid]['callFrame']
        by_file[cf['url'].split('/')[-1] or cf['functionName']] += ms
        by_fn[label(nodes[nid])] += ms
    idle = by_file.get('(idle)', 0)
    print(f'total {sum(self_ms.values()):.0f} ms, idle {idle:.0f} ms, busy {sum(self_ms.values()) - idle:.0f} ms')
    for k, v in by_file.most_common(int(top) // 2):
        print(f'  {v:7.1f}  {k}')
    print('  -- functions')
    for k, v in by_fn.most_common(int(top)):
        print(f'  {v:7.1f}  {k}')

def cmd_tree(path, match, depth=3):
    _, nodes, _, self_ms = load(path)
    sys.setrecursionlimit(100000)
    incl = {}
    def total(nid):
        if nid not in incl:
            incl[nid] = self_ms[nid] + sum(total(c) for c in nodes[nid].get('children', []))
        return incl[nid]
    def interesting(nid):
        url = nodes[nid]['callFrame']['url']
        return '/packages/' in url and 'node:' not in url
    def kids(nid):
        out = []
        for c in nodes[nid].get('children', []):
            out.extend([c] if interesting(c) else kids(c))
        return out
    def show(nid, level):
        if level > int(depth):
            return
        grouped = collections.defaultdict(list)
        for c in kids(nid):
            grouped[label(nodes[c])].append(c)
        for name, ids in sorted(grouped.items(), key=lambda kv: -sum(total(i) for i in kv[1]))[:12]:
            ms = sum(total(i) for i in ids)
            if ms >= 1:
                print(f"{'  ' * level}{ms:6.1f} {name}")
                show(ids[0], level + 1)
    for nid, node in nodes.items():
        if match in label(node):
            print(f'{total(nid):6.1f} {label(node)}')
            show(nid, 1)
            return

def cmd_modules(path, top=25):
    _, nodes, parent, self_ms = load(path)
    agg = collections.Counter()
    for nid, ms in self_ms.items():
        x = nid
        while x is not None:
            fn = nodes[x]['callFrame']['functionName']
            if fn.startswith('packages/') or fn.startswith('node_modules/'):
                agg[fn] += ms
                break
            x = parent.get(x)
    for k, v in agg.most_common(int(top)):
        print(f'{v:6.2f} {k}')

if __name__ == '__main__':
    {'self': cmd_self, 'tree': cmd_tree, 'modules': cmd_modules}[sys.argv[1]](*sys.argv[2:])
