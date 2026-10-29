import { useEffect,useState } from 'react';
import type { FormatCapabilities } from '../format-api';
import { understoodText } from '../format-api';
import type { CourseUnit } from '../shared';
import './readonly-course.css';
export function ReadonlyCourse({report}:{report:FormatCapabilities}){
 const [unitId,setUnitId]=useState(report.readableUnits[0]??''),[unit,setUnit]=useState<CourseUnit>(),[error,setError]=useState(''),[result,setResult]=useState('');
 useEffect(()=>{let active=true;setUnit(undefined);setError('');if(unitId)void window.yizhi.courseFormat.readUnit({unitId}).then(v=>{if(active)setUnit(v);}).catch(e=>{if(active)setError(e.message);});return()=>{active=false;};},[unitId]);
 return <section className="readonly-course" aria-label="兼容范围只读"><h2>此课程的部分版本暂不受支持</h2><p>已拒绝写入，原课程数据未改动。只有已支持的单元可查看文本与公式；图片、实验现场及其他个人记录不在此视图范围。</p>
  {report.readableUnits.length?<><label>可读取单元 <select aria-label="可读取单元" value={unitId} onChange={e=>{setUnitId(e.target.value);setResult('');}}>{report.readableUnits.map(id=><option key={id} value={id}>{report.unitNames?.[id]??id}</option>)}</select></label>
   <button disabled={!unit} onClick={()=>{setError('');void window.yizhi.courseFormat.exportText({unitId}).then(done=>{if(done)setResult('文本与公式已导出；原课程没有改动。');}).catch(e=>setError(e.message));}}>导出此单元文本与公式</button>
   <section aria-label="只读文本与公式">{unit?<><h3>{unit.name}</h3><pre>{understoodText(unit,false)}</pre></>:<p>正在读取支持范围…</p>}</section>
  </>:<p>目前没有可完整解释的单元范围。请使用支持此课程版本的应用打开完整目录。</p>}
  {error&&<p role="alert">{error}</p>}<p role="status">{result}</p>
 </section>;
}
