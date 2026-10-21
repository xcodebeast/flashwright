import re, collections, sys
tot=collections.Counter(); cnt=collections.Counter()
lines=open(sys.argv[1]).read().splitlines()
for line in lines:
    m=re.match(r'\s+(\d+) \[(\S+)\] (\S+)', line)
    if not m: continue
    d,cat,name=int(m.group(1)),m.group(2),m.group(3)
    key=cat+':'+name.strip('"')
    tot[key]+=d; cnt[key]+=1
for k,v in tot.most_common(12): print(f'{k:40s} total {v:5d} ms  n={cnt[k]:3d}  mean {v/cnt[k]:.1f}')
print(lines[0]); print(lines[1]); print(lines[-1])
