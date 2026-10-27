#!/usr/bin/env python3
"""Three predeclared pairs. No npm, rebuild of fixture, personal DB, or agent calls."""
import argparse, ctypes, hashlib, json, os, platform, plistlib, shutil, statistics
import subprocess, tempfile, threading, time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit

HERE=Path(__file__).resolve().parent
ARCH=HERE.parent/'architecture-spike'
PROJECT=HERE.parents[1]
APP=PROJECT/'legacy/review-board'
COURSE=PROJECT/'courses/digital-logic'
CACHE=Path.home()/'Library/Caches/electron/e2ab7f5c7b75e539aecedcad672559729d23bea062f0b954d4ba249cabac1162/electron-v40.10.6-darwin-arm64.zip'
EXPECTED='24e3b1a13ff7243f6b9036ebb743b6f62b19e4a925242d27eaa2be90de90a691'
ORDER=[['electron','wk'],['wk','electron'],['electron','wk']]
def sha(p): return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def manifest(p): return {str(f.relative_to(p)):sha(f) for f in sorted(p.rglob('*')) if f.is_file()}
def command(args, timeout=30):
    p=subprocess.run(args,capture_output=True,text=True,timeout=timeout)
    return {'args':list(map(str,args)),'code':p.returncode,'stdout':p.stdout,'stderr':p.stderr}
def disk(p):
    files={str(f):f.stat().st_size for f in p.rglob('*') if f.is_file() and not f.is_symlink()}
    return {'logicalBytes':sum(files.values()),'files':len(files),'du':command(['/usr/bin/du','-sk',str(p)])}

class Usage(ctypes.Structure):
    _fields_=[('uuid',ctypes.c_uint8*16)]+[(n,ctypes.c_uint64) for n in
      ['user','system','idle','interrupt','pageins','wired','resident','footprint','start','exit',
       'childUser','childSystem','childIdle','childInterrupt','childPageins','childElapsed','read','written']]
class Timebase(ctypes.Structure):
    _fields_=[('numer',ctypes.c_uint32),('denom',ctypes.c_uint32)]
lib=ctypes.CDLL('/usr/lib/libSystem.B.dylib',use_errno=True)
lib.responsibility_get_pid_responsible_for_pid.argtypes=[ctypes.c_int]
lib.responsibility_get_pid_responsible_for_pid.restype=ctypes.c_int
tb=Timebase();lib.mach_timebase_info(ctypes.byref(tb))
def usage(pid):
    r=Usage();ctypes.set_errno(0);rc=lib.proc_pid_rusage(pid,2,ctypes.byref(r))
    return {'returnCode':rc,'errno':ctypes.get_errno()} if rc else {
      'physFootprintBytes':r.footprint,'residentBytes':r.resident,'userTicks':r.user,'systemTicks':r.system,
      'cpuSeconds':(r.user+r.system)*tb.numer/tb.denom/1e9,'startAbstime':r.start}
def processes():
    p=subprocess.run(['/bin/ps','-axo','pid=,ppid=,rss=,time=,command='],capture_output=True,text=True,check=True)
    out={}
    for line in p.stdout.splitlines():
        x=line.strip().split(None,4)
        if len(x)==5:
            pid,ppid,rss,cpu,cmd=x
            out[int(pid)]={'pid':int(pid),'ppid':int(ppid),'psRssKiB':int(rss),'psCpuTime':cpu,'command':cmd}
    return out

class Sampler:
    def __init__(self):
        self.lock=threading.RLock();self.current=None;self.phase='setup';self.samples=[];self.events=[];self.stop=False
        self.baseline=processes();self.served={};self.known={}
    def take(self,trigger='periodic'):
        with self.lock:
            start=time.monotonic();allp=processes();selected=set();candidates=[]
            root=self.current['pid'] if self.current else None
            if root in allp:selected.add(root)
            while True:
                more={pid for pid,p in allp.items() if p['ppid'] in selected}-selected
                if not more:break
                selected |= more
            for pid,p in allp.items():
                if '/WebKit.framework/' in p['command']:
                    responsible=lib.responsibility_get_pid_responsible_for_pid(pid)
                    p['responsiblePid']=responsible
                    belongs=root is not None and (responsible==root or responsible in selected)
                    candidates.append({**p,'included':belongs,'preexisting':pid in self.baseline})
                    if belongs:selected.add(pid)
            rows=[]
            for pid in sorted(selected):
                row={**allp[pid],**usage(pid)};rows.append(row)
                if 'startAbstime' in row:self.known[pid]=row['startAbstime']
            s={'atMonotonic':start,'collectionEndMonotonic':time.monotonic(),'wallTime':time.time(),
              'run':self.current['run'] if self.current else None,'phase':self.phase,'trigger':trigger,
              'processes':rows,'webkitCandidates':candidates}
            s['physFootprintSumBytes']=sum(r['physFootprintBytes'] for r in rows) if rows and all('physFootprintBytes'in r for r in rows) else None
            s['rssSumBytes']=sum(r['psRssKiB']*1024 for r in rows)
            self.samples.append(s);return len(self.samples)-1
    def event(self,data):
        with self.lock:
            if data['kind']=='register':self.current=data;self.known={}
            if data['kind']=='begin':self.phase=data['phase']
            data['atMonotonic']=time.monotonic();data['sampleIndex']=self.take(data['kind'])
            self.events.append(data)
            if data['kind']=='end':self.phase='between'
    def loop(self):
        while not self.stop:
            if self.current:self.take()
            time.sleep(.5)

S=Sampler()
class Handler(SimpleHTTPRequestHandler):
    def do_GET(self):
        if urlsplit(self.path).path=='/empty':
            body=b'<!doctype html><meta charset="utf-8"><title>Empty resource window</title>'
            self.send_response(200);self.end_headers();self.wfile.write(body);return
        super().do_GET()
    def do_POST(self):
        if self.path!='/mark':self.send_error(404);return
        data=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        S.event(data);self.send_response(200);self.end_headers();self.wfile.write(b'{}')
    def end_headers(self):
        self.send_header('Cache-Control','no-cache');self.send_header('Access-Control-Allow-Origin','*');super().end_headers()
    def translate_path(self,url):
        path=unquote(urlsplit(url).path)
        routes={'/vendor/':HERE.parent/'style-math-prototype/vendor','/web/content/':APP/'web/content','/course-assets/':COURSE/'期中/资源'}
        for prefix,base in routes.items():
            if path.startswith(prefix):relative=path[len(prefix):];break
        else:base,relative=ARCH,path.lstrip('/') or 'index.html'
        target=(base/relative).resolve()
        if not target.is_relative_to(base.resolve()) or 'node_modules'in target.parts:return str(HERE/'not-found')
        if target.is_file():S.served[str(target.relative_to(PROJECT))]=sha(target)
        return str(target)
    def log_message(self,fmt,*args):
        if len(args)>1 and str(args[1]) not in ('200','304'):super().log_message(fmt,*args)

def summarize(run):
    events=[e for e in S.events if e['run']==run];phases={}
    for phase in ['blank','reading','load','closed']:
        begin=next((e for e in events if e['phase']==phase and e['kind']=='begin'),None)
        end=next((e for e in events if e['phase']==phase and e['kind']=='end'),None)
        if not begin or not end:phases[phase]={'valid':False,'reason':'Missing phase endpoint'};continue
        samples=[s for s in S.samples[begin['sampleIndex']:end['sampleIndex']+1] if s['run']==run and s['phase']==phase]
        a=S.samples[begin['sampleIndex']];b=S.samples[end['sampleIndex']]
        pids={p['pid'] for s in samples for p in s['processes']}
        aa={p['pid']:p for p in a['processes']};bb={p['pid']:p for p in b['processes']}
        stable=all({p['pid'] for p in s['processes']}==pids for s in samples)
        api=all(s['physFootprintSumBytes'] is not None for s in samples)
        elapsed=b['atMonotonic']-a['atMonotonic']
        cpu=sum(bb[p]['cpuSeconds']-aa[p]['cpuSeconds'] for p in pids) if stable and api else None
        renderer=end.get('renderer');frames=renderer.get('frames',[]) if renderer else []
        condition=all(f['width']==1000 and f['height']==700 and f['dpr']==2 and f['visible']=='visible' and f['focus'] for f in frames) if renderer else None
        footprint=[s['physFootprintSumBytes'] for s in samples if s['physFootprintSumBytes'] is not None]
        dt=sorted(f['dt'] for f in frames if f['dt'] is not None)
        phases[phase]={'valid':api,'samples':len(samples),'pids':sorted(pids),'stableProcessSet':stable,
          'elapsedSeconds':elapsed,'cpuSeconds':cpu,'cpuPercentOneCore':cpu/elapsed*100 if cpu is not None else None,
          'physFootprintMedianMiB':statistics.median(footprint)/2**20 if footprint else None,
          'physFootprintPeakMiB':max(footprint)/2**20 if footprint else None,
          'rssMedianMiB':statistics.median(s['rssSumBytes'] for s in samples)/2**20,
          'frameConditionsAllMatch':condition,'frames':len(frames),'frameMedianMs':statistics.median(dt) if dt else None,
          'frameP95Ms':dt[min(len(dt)-1,int(len(dt)*.95))] if dt else None,
          'allUpdatesApplied':all(x['applied'] for x in renderer['updates']) if renderer and phase=='load' else None}
    return phases

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--cache',type=Path,default=CACHE)
    parser.add_argument('--runtime-app',type=Path,required=True);args=parser.parse_args()
    temp=Path(tempfile.mkdtemp(prefix='desktop-resource-v2-'));runtime=args.runtime_app.resolve().parent
    protected={str(p):manifest(p) for p in [ARCH,HERE.parent/'desktop-host-spike']}
    result={'trial':'v2: authorized focus repair; final three pairs, no further retries','firstTrialSha256':sha(HERE/'results.json'),'startedAt':time.time(),'order':ORDER,'viewport':{'width':1000,'height':700,'dpr':2},
      'environment':{'swVers':command(['sw_vers']),'cpu':command(['sysctl','-n','machdep.cpu.brand_string','hw.memsize','hw.logicalcpu']),
        'python':platform.python_version(),'swift':command(['swift','--version'])},
      'api':{'memory':'libproc proc_pid_rusage(RUSAGE_INFO_V2).ri_phys_footprint, bytes; ps RSS secondary only',
        'cpu':'delta(ri_user_time+ri_system_time) * mach_timebase numer/denom / 1e9; total across attributed PIDs; 100% = one core',
        'machTimebase':{'numer':tb.numer,'denom':tb.denom},'samplingSeconds':.5,
        'wkAttribution':'recursive children OR WebKit XPC responsibility_get_pid_responsible_for_pid matches host; all WebKit candidates retained'},
      'preflight':{'footprintCli':command(['/usr/bin/footprint','-p',str(os.getpid()),'--noCategories','-f','bytes']),
        'baselineWebkit':[p for p in S.baseline.values() if '/WebKit.framework/'in p['command']]},
      'runs':[],'failures':[],'hashes':{'protectedBefore':protected},'cleanup':{}}
    # CPU unit calibration prevents treating Mach absolute ticks as nanoseconds on arm64.
    a=usage(os.getpid());c=time.process_time();limit=time.monotonic()+.2
    while time.monotonic()<limit:pass
    b=usage(os.getpid());result['api']['cpuCalibration']={'processTimeDelta':time.process_time()-c,'convertedRusageDelta':b['cpuSeconds']-a['cpuSeconds']}
    http=None;thread=None;active=None
    try:
        first=json.loads((HERE/'results.json').read_text())
        electron=args.runtime_app.resolve();binary=electron/'Contents/MacOS/Electron'
        if sha(binary)!=first['runtime']['binarySha256']:raise RuntimeError('Shared runtime binary integrity mismatch')
        if sha(args.cache)!=EXPECTED:raise RuntimeError('Source cache integrity mismatch')
        result['runtime']={**first['runtime'],'appPath':str(electron),'binaryPath':str(binary),
          'sharedReadOnlyRuntime':True,'expanded':disk(electron),'noNewExtraction':True}
        print(json.dumps({'trial':'v2','runtime':str(electron),'sharedReadOnly':True}),flush=True)
        wkapp=temp/'ResourceWK.app';macos=wkapp/'Contents/MacOS';macos.mkdir(parents=True)
        plist={'CFBundleIdentifier':'local.robert.desktop-resource-spike','CFBundleExecutable':'ResourceWK','CFBundleName':'ResourceWK','CFBundlePackageType':'APPL','NSPrincipalClass':'NSApplication'}
        (wkapp/'Contents/Info.plist').write_bytes(plistlib.dumps(plist))
        result['compile']=command(['swiftc','-module-cache-path',str(temp/'swift-cache'),str(HERE/'wk-v2.swift'),'-o',str(macos/'ResourceWK')],80)
        if result['compile']['code']:raise RuntimeError('Swift compile failed')
        result['nativeHost']={'notTauri':True,'app':disk(wkapp),'binarySha256':sha(macos/'ResourceWK'),
          'systemWebKitFramework':disk(Path('/System/Library/Frameworks/WebKit.framework')),
          'systemRuntimeAttributableBytes':None,'reason':'WebKit uses OS shared libraries/dyld shared cache; visible framework bytes are not a complete standalone runtime or Tauri package.'}
        http=ThreadingHTTPServer(('127.0.0.1',0),Handler);thread=threading.Thread(target=http.serve_forever,daemon=True);thread.start()
        sampler=threading.Thread(target=S.loop,daemon=True);sampler.start()
        origin='http://127.0.0.1:'+str(http.server_port);result['origin']=origin
        for round_index,pair in enumerate(ORDER,1):
            for host in pair:
                run=f'r{round_index}-{host}';item={'id':run,'round':round_index,'host':host,'startWall':time.time()};result['runs'].append(item)
                S.current=None;S.phase='setup'
                app=electron if host=='electron' else wkapp
                extra=[str(HERE/'electron-v2.cjs'),origin,run,str(temp)] if host=='electron' else [origin,run,str(HERE/'renderer-v2.js')]
                launch=['/usr/bin/open','-n','-W','-a',str(app),'--args',*extra]
                active=subprocess.Popen(launch,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
                try:stdout,stderr=active.communicate(timeout=75);item['launch']={'args':launch,'code':active.returncode,'stdout':stdout,'stderr':stderr}
                except subprocess.TimeoutExpired:
                    item['launch']={'args':launch,'failure':'75s timeout'};result['failures'].append(run+' timeout');active.terminate();active.communicate(timeout=5)
                item['phases']=summarize(run);item['endWall']=time.time()
                # Never overlap measured hosts; only touch PIDs positively attributed to this run.
                owned=dict(S.known);root=S.current['pid'] if S.current else None
                S.current=None
                deadline=time.monotonic()+5
                while time.monotonic()<deadline and any(p in processes() for p in owned):time.sleep(.25)
                remaining=[];allp=processes()
                for pid,start in owned.items():
                    if pid not in allp:continue
                    now=usage(pid)
                    if now.get('startAbstime')==start:
                        remaining.append({'pid':pid,'command':allp[pid]['command'],'responsiblePid':lib.responsibility_get_pid_responsible_for_pid(pid)})
                        if pid==root or lib.responsibility_get_pid_responsible_for_pid(pid)==root:
                            os.kill(pid,15)
                item['remainingAfterExit']=remaining
                if remaining:
                    result['failures'].append(run+' attributed processes remained after exit; cleanup requested')
                    time.sleep(1)
                if any(p in processes() and usage(p).get('startAbstime')==start for p,start in owned.items()):
                    raise RuntimeError('Attributed process still alive: stop to prevent overlap')
                print(json.dumps({'run':run,'phases':item['phases'],'remaining':remaining}),flush=True)
                time.sleep(2)
    except Exception as e:
        result['failures'].append(repr(e))
    finally:
        S.stop=True
        if active and active.poll() is None:active.terminate()
        # If a host failed early, explicitly terminate only positively identified own processes.
        if S.current:
            root=S.current['pid']
            for pid,start in S.known.items():
                if usage(pid).get('startAbstime')==start and (pid==root or lib.responsibility_get_pid_responsible_for_pid(pid)==root):
                    try:os.kill(pid,15)
                    except ProcessLookupError:pass
        if http:http.shutdown();http.server_close()
        result['events']=S.events;result['samples']=S.samples;result['hashes']['servedFiles']=S.served
        result['hashes']['protectedAfter']={p:manifest(Path(p)) for p in protected}
        result['hashes']['protectedUnchanged']=result['hashes']['protectedBefore']==result['hashes']['protectedAfter']
        result['hashes']['experiment']={f.name:sha(f) for f in sorted(HERE.iterdir()) if f.suffix in ('.py','.js','.cjs','.swift')}
        shutil.rmtree(temp)
        result['cleanup'].update({'runtimeRetained':str(runtime),'owner':'desktop-resource-spike; shared with core-placement after measurement release',
          'runtimeCleanupPending':True,'temporaryDirectoryRemoved':True,'userDataAndCompilationRemoved':True})
        result['cleanup']['httpStopped']=http is None or http.fileno()==-1
        result['cleanup']['sourceCacheUnchanged']=sha(args.cache)==EXPECTED
        result['completedAt']=time.time()
        (HERE/'results-v2.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
        print(json.dumps({'failures':result['failures'],'cleanup':result['cleanup'],'unchanged':result['hashes']['protectedUnchanged']}),flush=True)
    return bool(result['failures'])

if __name__=='__main__':raise SystemExit(main())
