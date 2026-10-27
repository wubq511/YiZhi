#!/usr/bin/env python3
"""Post-measurement integrity/cleanup audit only; never launches or kills a host."""
import argparse,hashlib,json,socket,time
from pathlib import Path
from urllib.parse import urlsplit
from run import usage,manifest,sha
HERE=Path(__file__).resolve().parent
parser=argparse.ArgumentParser();parser.add_argument('--input',type=Path,default=HERE/'results.json');args=parser.parse_args()
data=json.loads(args.input.read_text())
runtime=Path(data['cleanup']['runtimeRetained'])
payload=[f for f in runtime.rglob('*') if f.is_file() and not f.is_symlink() and f.name!='electron.zip']
seen={p['pid']:p['startAbstime'] for s in data['samples'] for p in s['processes'] if 'startAbstime'in p}
alive=[pid for pid,start in seen.items() if usage(pid).get('startAbstime')==start]
url=urlsplit(data['origin']);sock=socket.socket();sock.settimeout(.5)
port_open=sock.connect_ex((url.hostname,url.port))==0;sock.close()
names=['run-v2.py','renderer-v2.js','electron-v2.cjs','wk-v2.swift'] if data.get('trial','').startswith('v2:') else ['run.py','renderer.js','electron.cjs','wk.swift']
collection={n:sha(HERE/n) for n in names}
post={'at':time.time(),'collectionSourceHashes':collection,
  'collectionSourcesMatchRecordedHashes':all(data['hashes']['experiment'][n]==h for n,h in collection.items()),
  'postProcessingSourceHashes':{n:sha(HERE/n) for n in ['analyze.py','audit.py']},
  'protectedTreesStillUnchanged':all(manifest(Path(p))==hashes for p,hashes in data['hashes']['protectedBefore'].items()),
  'measuredPidsStillAlive':alive,'dedicatedPortOpen':port_open,
  'temporaryParentEntries':[p.name for p in runtime.parent.iterdir()],
  'runtimeRetainedForCorePlacement':str(runtime),'sourceCacheSha256':sha(data['runtime']['cacheSource']),
  'expandedReleaseExcludingDownload':{'logicalBytes':sum(f.stat().st_size for f in payload),
    'allocatedRegularFileBytes':sum(f.stat().st_blocks*512 for f in payload),'regularFiles':len(payload),
    'topLevelFiles':{f.name:{'logicalBytes':f.stat().st_size,'sha256':sha(f)} for f in runtime.iterdir() if f.is_file() and f.name!='electron.zip'}}}
data['postMeasurement']=post
args.input.write_text(json.dumps(data,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({k:v for k,v in post.items() if k not in ('collectionSourceHashes','postProcessingSourceHashes','sourceCacheSha256','expandedReleaseExcludingDownload')},ensure_ascii=False,indent=2))
print(json.dumps(post['expandedReleaseExcludingDownload'],indent=2))
