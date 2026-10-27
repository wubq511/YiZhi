#!/usr/bin/env python3
"""One 4-second diagnostic per host. No resource collection or focus retries."""
import json,plistlib,shutil,subprocess,tempfile,threading,time
from pathlib import Path
from http.server import ThreadingHTTPServer
from run import HERE,Handler,command,sha,processes,usage

temp=Path(tempfile.mkdtemp(prefix='desktop-focus-'))
data={'scope':'One diagnostic, 4 seconds per host, one activation each; not another resource round',
      'startWall':time.time(),'failures':[],'runs':[]}
http=None;observer=None
try:
    results=json.loads((HERE/'results.json').read_text());electron=Path(results['runtime']['appPath'])
    app=temp/'FocusWK.app';macos=app/'Contents/MacOS';macos.mkdir(parents=True)
    (app/'Contents/Info.plist').write_bytes(plistlib.dumps({'CFBundleIdentifier':'local.robert.desktop-focus-diagnostic','CFBundleExecutable':'FocusWK','CFBundleName':'FocusWK','CFBundlePackageType':'APPL'}))
    data['compile']=command(['swiftc','-module-cache-path',str(temp/'swift-cache'),str(HERE/'focus.swift'),'-o',str(macos/'FocusWK')],80)
    if data['compile']['code']:raise RuntimeError('Diagnostic compile failed')
    http=ThreadingHTTPServer(('127.0.0.1',0),Handler);threading.Thread(target=http.serve_forever,daemon=True).start()
    url=f'http://127.0.0.1:{http.server_port}/?count=500&mode=managed&dynamic=1'
    observer=subprocess.Popen([str(macos/'FocusWK'),'observe'],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
    for host in ['electron','wk']:
        outfile=temp/(host+'.json')
        args=[str(HERE/'focus-electron.cjs'),url,str(temp),str(outfile)] if host=='electron' else [url,str(outfile)]
        launch=command(['/usr/bin/open','-n','-W','-a',str(electron if host=='electron' else app),'--args',*args],15)
        raw=json.loads(outfile.read_text()) if outfile.exists() else {'failure':'No output'}
        data['runs'].append({'host':host,'launch':launch,'data':raw})
    # Observer is passive and never activates any application.
    observer.terminate();stdout,stderr=observer.communicate(timeout=3)
    data['foregroundTimeline']=[json.loads(x) for x in stdout.splitlines() if x.strip()]
    data['observerStderr']=stderr
    for run in data['runs']:
        for row in run['data'].get('samples',[]):
            timeline=data['foregroundTimeline'];row['foreground']=min(timeline,key=lambda x:abs(x['wallTime']-row['wallTime'])) if timeline else None
        rows=run['data'].get('samples',[])
        run['summary']={'samples':len(rows),'nativeKeyTrue':sum(r['nativeKey'] for r in rows),
          'documentFocusTrue':sum(r.get('document',{}).get('focus',False) for r in rows),
          'foregroundBundles':sorted({r['bundle'] for r in rows}) if run['host']=='wk' else sorted({r['foreground']['bundle'] for r in rows if r.get('foreground')}),
          'stableFocusedAllSamples':len(rows)==20 and all(r['nativeKey'] and r.get('document',{}).get('focus') for r in rows)}
except Exception as e:data['failures'].append(repr(e))
finally:
    if observer and observer.poll() is None:observer.terminate();observer.communicate(timeout=3)
    if http:http.shutdown();http.server_close()
    shutil.rmtree(temp)
    data['endWall']=time.time();data['cleanup']={'httpStopped':True,'diagnosticTemporaryDirectoryRemoved':True}
    data['hashes']={n:sha(HERE/n) for n in ['focus.py','focus.swift','focus-electron.cjs']}
    (HERE/'focus-diagnostic.json').write_text(json.dumps(data,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps({'runs':[{k:r[k] for k in ['host','summary'] if k in r} for r in data['runs']],'failures':data['failures'],'cleanup':data['cleanup']},ensure_ascii=False,indent=2),flush=True)
