import { useEffect, useState } from 'react';
import type { ArtifactRef } from '../parsing-api';
import type { SourceVersion } from '../sources-api';

export interface GenerationSourceChoice { sourceVersionId:string; artifactId:string; pdfPageIndex:number }

/** The selected version and confirmed page are fixed in the submitted task. */
export function GenerationSource({sessionId,value,sourceIdFilter,onChange}:{sessionId:string;value:GenerationSourceChoice|null;sourceIdFilter?:string;onChange(value:GenerationSourceChoice|null):void}) {
  const [versions,setVersions]=useState<SourceVersion[]>([]),[versionId,setVersionId]=useState(value?.sourceVersionId??'');
  const [refs,setRefs]=useState<ArtifactRef[]>([]),[loading,setLoading]=useState(false),[error,setError]=useState(''),[reload,setReload]=useState(0);
  useEffect(()=>{
    let active=true;setLoading(true);setError('');
    void window.yizhi.sources.list({sessionId}).then(list=>{
      if(!active)return;
      const latest=new Map<string,SourceVersion>();
      for(const version of list.versions)if(version.mediaType==='application/pdf'&&(!sourceIdFilter||version.sourceId===sourceIdFilter))latest.set(version.sourceId,version);
      const available=[...latest.values()];setVersions(available);
      if(versionId&&!available.some(version=>version.versionId===versionId)){setVersionId('');setRefs([]);onChange(null);}
    }).catch(failure=>{if(active)setError((failure as Error).message);}).finally(()=>{if(active)setLoading(false);});
    return()=>{active=false;};
  },[sessionId,sourceIdFilter,reload]);
  useEffect(()=>{
    if(!versionId){setRefs([]);return;}
    let active=true;setLoading(true);setError('');
    void window.yizhi.parsing.artifacts({sessionId,versionId}).then(found=>{
      if(!active)return;
      const latest=new Map<number,ArtifactRef>();for(const ref of found)latest.set(ref.pdfPageIndex,ref);
      const available=[...latest.values()].sort((a,b)=>a.pdfPageIndex-b.pdfPageIndex);
      setRefs(available);
      if(value?.artifactId&&!available.some(ref=>ref.artifactId===value.artifactId))onChange(null);
    }).catch(failure=>{if(active)setError((failure as Error).message);}).finally(()=>{if(active)setLoading(false);});
    return()=>{active=false;};
  },[sessionId,versionId,reload]);
  return <fieldset className="agent-generation-source"><legend>新增来源范围</legend>
    <p>{sourceIdFilter?'保留当前小主题和单元身份，按同一来源的已解析版本更新完整讲解与练习。':'目前支持已解析 PDF 中的低有效四选一单通道。选择原件及已确认的表格页，生成完整小主题和练习。'}</p>
    <label>PDF 原件<select aria-label="生成来源 PDF" value={versionId} disabled={loading} onChange={event=>{setVersionId(event.target.value);setRefs([]);onChange(null);}}>
      <option value="">选择来源</option>{versions.map(version=><option key={version.versionId} value={version.versionId}>{version.title===version.originalName?version.title:`${version.title} · ${version.originalName}`}</option>)}
    </select></label>
    <label>已解析的表格页<select aria-label="生成来源页" value={value?.artifactId??''} disabled={loading||!versionId||!refs.length} onChange={event=>{
      const ref=refs.find(item=>item.artifactId===event.target.value);
      onChange(ref?{sourceVersionId:versionId,artifactId:ref.artifactId,pdfPageIndex:ref.pdfPageIndex}:null);
    }}><option value="">选择已确认页面</option>{refs.map(ref=><option key={ref.artifactId} value={ref.artifactId}>PDF 第 {ref.pdfPageIndex+1} 页 · 已确认解析</option>)}</select></label>
    <div className="agent-generation-source-footer"><span role="status">{loading?'正在读取来源…':!versions.length&&sourceIdFilter?'当前主题暂无可选来源版本。':versionId&&!refs.length?'该来源尚无已确认解析页，请先在原文资料中解析。':''}</span><button type="button" onClick={()=>setReload(n=>n+1)} disabled={loading}>刷新来源</button></div>
    {error&&<p role="alert">来源读取失败：{error}</p>}
  </fieldset>;
}
