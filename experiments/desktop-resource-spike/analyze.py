#!/usr/bin/env python3
"""Read-only analysis of saved raw samples; never launches either host."""
import argparse,hashlib,json,math,statistics
from pathlib import Path
HERE=Path(__file__).resolve().parent

def analyze(result):
    cal=result.get('api',{}).get('cpuCalibration',{})
    a=cal.get('processTimeDelta',0);b=cal.get('convertedRusageDelta',0)
    calibrated=a>0 and b>0 and abs(a-b)/a<.02
    output={'runs':{},'pairs':[],'limitations':[
      'phys_footprint is kernel per-task accounting summed over attributed processes, not exclusive incremental system RAM; shared WindowServer/OS services are not apportioned.',
      'RSS includes shared pages repeatedly and is not physical memory demand.',
      'Three pairs on one live macOS desktop; no statistical significance, cold-cache, launch-time, energy or input-latency claim.',
      'rAF callback intervals are not presentation FPS or physical input latency.',
      'WK host is minimal AppKit/WKWebView, not a full Tauri product; disk sizes are not complete product sizes.',
      'responsibility_get_pid_responsible_for_pid is a macOS private attribution diagnostic; all observed candidates are retained for audit.',
      'The existing fixture has a continuous rAF sampler and a one-second DOM count timer even during reading. This is the current prototype, not an optimized idle app.',
      'CPU totals are omitted when the process set changes inside the phase; dead-process CPU between polls cannot be reconstructed exactly.',
      'getAppMetrics snapshots are ancillary Electron evidence only, not a cross-engine metric; private/shared memory fields do not equal macOS phys_footprint.'
    ],'cpuCalibration':{**cal,'convertedToProcessTimeRatio':b/a if a else None,'validWithinTwoPercent':calibrated}}
    for run in result['runs']:
        name=run['id'];events=[e for e in result['events'] if e['run']==name]
        reg=next((e for e in events if e['kind']=='register'),{})
        fixture=next((e.get('fixture') for e in events if e['kind']=='fixture'),{})
        failed=[e for e in events if e['kind']=='failure']
        evidence={'pid':reg.get('pid'),'failures':failed,'fixture':fixture,'phases':{}}
        output['runs'][name]=evidence
        for phase,summary in run['phases'].items():
            end=next((e for e in events if e['phase']==phase and e['kind']=='end'),{})
            renderer=end.get('renderer',{})
            intervals=[f['dt'] for f in renderer.get('frames',[]) if f.get('dt') is not None]
            sorted_intervals=sorted(intervals)
            samples=[s for s in result['samples'] if s['run']==name and s['phase']==phase]
            excluded={p['pid']:p for s in samples for p in s['webkitCandidates'] if not p['included']}
            # Every new WebKit process with unknown/missing responsibility is a real attribution gap.
            unknown=[p for p in excluded.values() if not p['preexisting'] and p['responsiblePid']<=0]
            roles={role:sorted({p['pid'] for s in samples for p in s['processes'] if '/WebKit.framework/' in p['command'] and role+'.xpc/' in p['command']})
              for role in ['WebContent','GPU','Networking']}
            wk_roles=run['host']!='wk' or phase=='closed' or all(roles.values())
            states=[renderer.get('before',{}),renderer.get('after',{})]+renderer.get('frames',[])
            fair_view=bool(renderer.get('frames')) and all(s.get('width')==1000 and s.get('height')==700 and s.get('dpr')==2 and s.get('focus') is True and s.get('visible')=='visible' for s in states)
            focus_events=[e for e in renderer.get('events',[]) if e['event'] in ('blur','visibilitychange','resize')]
            fixture_valid=fixture.get('articles')==500 and fixture.get('snapshot',{}).get('mode')=='managed' and fixture.get('snapshot',{}).get('dynamic') is True and fixture.get('bodyChars',0)>500 and fixture.get('assetErrors')==[]
            load_valid=phase!='load' or (len(renderer.get('updates',[]))==16 and all(u['applied'] for u in renderer['updates']) and renderer.get('sameBody') is True)
            reason=[]
            if not summary.get('valid'):reason.append('Incomplete memory API samples')
            if phase!='closed' and (not fair_view or focus_events):reason.append('Foreground condition failed: inspect raw frame states and per-host scheduling configuration')
            if phase in ('reading','load') and not fixture_valid:reason.append('Fixture invariant failed')
            if not load_valid:reason.append('Workload did not complete equally')
            if not wk_roles:reason.append('WK content/GPU/network ownership not completely confirmed')
            if unknown:reason.append('New WebKit processes with unknown responsibility')
            if failed:reason.append('Host failure')
            evidence['phases'][phase]={**summary,'comparable':not reason,'reasons':reason,
              'cpuComparable':not reason and calibrated and summary.get('stableProcessSet',False),
              'maxRafIntervalMs':max(intervals) if intervals else None,
              'rafP99Ms':sorted_intervals[math.ceil(len(sorted_intervals)*.99)-1] if sorted_intervals else None,
              'rafIntervalsOver33_4ms':sum(round(x,6)>33.4 for x in intervals),'rafIntervalsOver50ms':sum(round(x,6)>50 for x in intervals),
              'rafIntervalsOver33ms':sum(x>33.34 for x in intervals),'rafIntervalsOver100ms':sum(x>100 for x in intervals),
              'wkRoles':roles,'excludedWebKit':list(excluded.values()),'unknownWebKit':unknown,
              'fixtureParagraphSha256':hashlib.sha256(fixture.get('paragraph','').encode()).hexdigest()}
    for i in range(1,4):
        pair={'round':i,'phases':{}}
        for phase in ['blank','reading','load','closed']:
            a=output['runs'].get(f'r{i}-electron',{}).get('phases',{}).get(phase,{})
            b=output['runs'].get(f'r{i}-wk',{}).get('phases',{}).get(phase,{})
            fair=a.get('comparable') and b.get('comparable') and (phase not in ('reading','load') or a.get('fixtureParagraphSha256')==b.get('fixtureParagraphSha256'))
            pair['phases'][phase]={'comparable':bool(fair)}
            if fair:
                pair['phases'][phase].update({'electronMinusWkMiB':a['physFootprintMedianMiB']-b['physFootprintMedianMiB'],
                  'electronToWkFootprintRatio':a['physFootprintMedianMiB']/b['physFootprintMedianMiB'],
                  'electronMinusWkCpuPercentagePoints':a['cpuPercentOneCore']-b['cpuPercentOneCore'] if a.get('cpuComparable') and b.get('cpuComparable') and a['cpuPercentOneCore'] is not None and b['cpuPercentOneCore'] is not None else None})
        output['pairs'].append(pair)
    return output

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--save',action='store_true')
    parser.add_argument('--input',type=Path,default=HERE/'results.json')
    parser.add_argument('--frame-output',type=Path);args=parser.parse_args()
    data=json.loads(args.input.read_text())
    analysis=analyze(data)
    if args.save:
        raw={k:v for k,v in data.items() if k not in ('analysis','analysisMetadata')}
        data['analysisMetadata']={'rawEvidenceCanonicalSha256':hashlib.sha256(json.dumps(raw,ensure_ascii=False,sort_keys=True).encode()).hexdigest(),
          'analyzerSha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),'rawCollectionFieldsUnchanged':True}
        data['analysis']=analysis
        args.input.write_text(json.dumps(data,ensure_ascii=False,indent=2)+'\n')
    if args.frame_output:
        keys=['comparable','frames','frameMedianMs','frameP95Ms','rafP99Ms','maxRafIntervalMs','rafIntervalsOver33_4ms','rafIntervalsOver50ms']
        output={'inputSha256':hashlib.sha256(args.input.read_bytes()).hexdigest(),
          'analyzerSha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
          'method':'Raw rAF intervals, first null interval excluded; P99 nearest-rank ceil(n*0.99); strict > thresholds after rounding milliseconds to six decimals to remove binary error at exact boundary; not presentation FPS',
          'runs':{name:{p:{k:v[k] for k in keys} for p,v in r['phases'].items()} for name,r in analysis['runs'].items()}}
        args.frame_output.write_text(json.dumps(output,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps({'cpuCalibration':analysis['cpuCalibration'],'pairs':analysis['pairs'],
      'collectedRuns':len(data['runs']),'collectionFailures':data['failures'],
      'foregroundAcceptedRuns':sum(all(v['comparable'] for p,v in r['phases'].items() if p in ('reading','load')) for r in analysis['runs'].values())},ensure_ascii=False,indent=2))
