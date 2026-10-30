import { reportSave, clearSave } from './shell/save-status';
import {PARITY_ORACLES,type ExtensionView,type ExtensionManifest,type ExtensionState,type ExtensionAction,type ExtensionIdentity} from '../extensions-api';
import type {DesktopBridge} from '../shared';
const origin='yizhi-extension://package';
const equal=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
/** Exact source + origin + request + instance + definition + generation at every response. */
class PackageFrame {
  readonly element=document.createElement('iframe');
  private pending=new Map<string,{resolve:(s:ExtensionState)=>void;reject:(e:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
  private loaded:Promise<void>;
  private dead=false;
  private observedFrame=observation.resource('experiment.extensionFrames');
  constructor(container:HTMLElement,sessionId:string,readonly manifest:ExtensionManifest,readonly identity:ExtensionIdentity,hidden=false){
    this.element.title=hidden?'新定义现场检查':'奇偶校验运行结果';
    this.element.sandbox.add('allow-scripts','allow-same-origin');
    this.element.referrerPolicy='no-referrer'; this.element.hidden=hidden;
    this.loaded=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('扩展资源打开超时')),3000);this.element.onload=()=>{clearTimeout(timer);resolve();};});
    addEventListener('message',this.message);
    this.element.src=`${origin}/${sessionId}/${manifest.packageVersion}/index.html`;
    container.append(this.element);
    this.observedFrame.set(1);
  }
  private message=(event:MessageEvent)=>{
    if(this.dead || event.source!==this.element.contentWindow || event.origin!==origin || !equal(event.data?.identity,this.identity)) return;
    if(event.data?.kind==='size'){const h=event.data.height;if(Number.isFinite(h))this.element.style.height=`${Math.max(105,Math.min(480,Math.ceil(h)))}px`;return;}
    const p=this.pending.get(event.data?.id);if(!p)return;
    clearTimeout(p.timer);this.pending.delete(event.data.id);
    event.data.error?p.reject(Error(event.data.error)):p.resolve(event.data.state);
  };
  async call(kind:string,payload:Record<string,unknown>={}):Promise<ExtensionState>{
    await this.loaded;if(this.dead)throw Error('扩展实例已销毁');
    const id=crypto.randomUUID();
    return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(Error('浏览器 Worker 未回应，暂停未完成'));this.dispose();},1800);
      this.pending.set(id,{resolve,reject,timer});this.element.contentWindow!.postMessage({...payload,kind,id,identity:this.identity},origin);});
  }
  dispose(){
    if(this.dead)return;this.dead=true;
    this.observedFrame.close();
    this.element.contentWindow?.postMessage({id:crypto.randomUUID(),kind:'dispose',identity:this.identity},origin);
    removeEventListener('message',this.message);this.element.remove();
    for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(Error('扩展实例已销毁'));}this.pending.clear();
  }
}
/** Lives only in the trusted application renderer. Generated code has no bridge to Core. */
export class ExtensionRuntime {
  view?:ExtensionView;error?:string;ready=false;
  private frame?:PackageFrame;private candidate?:PackageFrame;private working?:Promise<void>;
  private intents=new Set<Promise<unknown>>();private stopped=false;
  private listeners=new Set<()=>void>();private timer:ReturnType<typeof setInterval>;
  constructor(private bridge:DesktopBridge,readonly sessionId:string,private container:HTMLElement){
    this.timer=setInterval(()=>void this.tick(),220);void this.tick();
  }
  subscribe(fn:()=>void){this.listeners.add(fn);return()=>{this.listeners.delete(fn);};}
  private emit(){const v=this.view;reportSave(`extension:${this.sessionId}`,{label:'扩展现场',status:this.error||v?.phase==='pause-incomplete'?'error':!this.ready||this.pending||v?.phase==='pausing'||v&&JSON.stringify(v.inputs)!==JSON.stringify(v.state.inputs)?'pending':'saved',detail:this.error,retry:()=>this.recover()});for(const fn of this.listeners)fn();}
  private adopt(v:ExtensionView){if(!this.view||v.revision>=this.view.revision)this.view=v;this.emit();}
  async send(action:ExtensionAction){
    if(!this.view)return;
    const c={sessionId:this.sessionId,instanceId:this.view.instanceId,generation:this.view.generation,operationId:crypto.randomUUID(),action};
    const p=this.bridge.extensions.act(c);this.intents.add(p);this.emit();
    try{this.adopt(await p);}catch(error){if(!(action.kind==='upgrade'&&/现场已变化|操作结束|代际|实例/.test(String(error)))){this.error=String(error);this.emit();}throw error;}finally{this.intents.delete(p);this.emit();}
  }
  get pending(){return this.intents.size>0 || !this.ready;}
  private create(m:ExtensionManifest,v:ExtensionView,hidden=false){return new PackageFrame(this.container,this.sessionId,m,{instanceId:v.instanceId,generation:v.generation,definitionVersion:m.packageVersion},hidden);}
  private async check(frame:PackageFrame){
    const m=frame.manifest;
    let outputs='';
    for(let row=0;row<2**m.inputs.length;row++){
      const inputs=Object.fromEntries(m.inputs.map((n,i)=>[n,(row>>(m.inputs.length-i-1))&1]));
      const result=await frame.call('initialize',{state:{inputs,step:0,simulationTime:0,seed:1,output:0},inputs});outputs+=String(result.output);
    }
    if(outputs!==PARITY_ORACLES[m.packageVersion])throw Error('学习结果未通过有限真值表核对');
    const inputs=Object.fromEntries(m.inputs.map((n,i)=>[n,i===0?1:0]));
    const state=await frame.call('initialize',{state:{inputs,step:7,simulationTime:1750,seed:1,output:1},inputs});
    const pause=await frame.call('pause'),snapshot=await frame.call('snapshot'),resume=await frame.call('resume');
    const stepped=await frame.call('step');
    if(!equal(state,pause)||!equal(state,snapshot)||!equal(state,resume)||stepped.step!==8||stepped.simulationTime!==2000||stepped.seed!==1||!equal(stepped.inputs,inputs)||stepped.output!==1)throw Error('生命周期检查未通过');
    if(m.packageVersion==='1.1.0'){
      const migrated=await frame.call('migrate',{from:'parity-state-1',state:{inputs,step:7,simulationTime:1750,seed:1,output:1}});
      if(!equal(migrated,{inputs,step:7,simulationTime:1750,seed:1,output:1,ones:1}))throw Error('现场迁移检查未通过');
    }
    await this.send({kind:'validate',version:m.packageVersion,report:{outputs,lifecycle:true,migration:true}});
  }
  private async cycle(){
    if(this.stopped||this.intents.size||this.error)return;
    this.adopt(this.view?await this.bridge.extensions.read({sessionId:this.sessionId}):await this.bridge.extensions.open({sessionId:this.sessionId}));
    let v=this.view!;
    if(v.phase==='pause-incomplete'){this.ready=false;return;}
    if(!this.frame||this.frame.identity.instanceId!==v.instanceId){
      this.frame?.dispose();this.frame=this.create(v.definition,v);this.ready=false;
      await this.frame.call('initialize',{state:v.state,inputs:v.inputs});
      if(!v.checked.includes(v.definition.packageVersion))await this.check(this.frame);
      v=this.view!;
      await this.frame.call('initialize',{state:v.state,inputs:v.inputs});this.ready=true;this.error=undefined;this.emit();
    }
    if(this.intents.size)return;
    v=this.view!;
    if(!equal(v.inputs,v.state.inputs)){
      const state=await this.frame.call('initialize',{state:v.state,inputs:v.inputs});
      await this.confirm(v,'input',state);return;
    }
    if(v.pending&&!v.gesture&&!v.error){
      const target=v.pending;
      this.candidate?.dispose();this.candidate=this.create(target,v,true);
      try{
        await this.candidate.call('initialize',{state:target.packageVersion==='2.0.0'?{inputs:{A:0,B:0,C:0,D:0},step:0,simulationTime:0,seed:1,output:0}:v.state});
        if(!v.checked.includes(target.packageVersion))await this.check(this.candidate);
        v=this.view!;
        const state=await this.candidate.call('migrate',{from:v.definition.stateVersion,state:v.state});
        await this.send({kind:'upgrade',version:target.packageVersion,baseRevision:v.revision,state});
      }catch(error){
        // A concurrent input/gesture invalidates this exact copy; retry from the latest view.
        const latest=await this.bridge.extensions.read({sessionId:this.sessionId});this.adopt(latest);
        if(latest.revision===v.revision)await this.send({kind:'migrationFailed',error:String(error)});
      }finally{this.candidate?.dispose();this.candidate=undefined;}
      return;
    }
    if(v.phase==='running'&&!v.gesture){
      await this.frame.call('initialize',{state:v.state,inputs:v.inputs});
      const state=await this.frame.call('step');await this.confirm(v,'step',state);
    }else if(v.phase==='pausing'){
      await this.frame.call('initialize',{state:v.state,inputs:v.inputs});
      const paused=await this.frame.call('pause'),state=await this.frame.call('snapshot');
      if(!equal(paused,state))throw Error('暂停快照不完整');
      await this.confirm(v,'pause',state);
    }
  }
  private async confirm(v:ExtensionView,mode:'step'|'input'|'pause',state:ExtensionState){
    // Capture every identity before awaiting the browser, never relabel a late callback.
    const c={sessionId:this.sessionId,instanceId:v.instanceId,generation:v.generation,operationId:crypto.randomUUID(),action:{kind:'confirm' as const,mode,baseRevision:v.revision,definitionVersion:v.definition.packageVersion,state}};
    try{this.adopt(await this.bridge.extensions.act(c));}catch(error){
      if(/现场已变化|代际|实例|停止发步/.test(String(error)))return;
      throw error;
    }
  }
  private async tick(){
    if(this.working||this.stopped)return;
    this.working=this.cycle().catch(async error=>{if(this.stopped)return;this.error=String(error);this.ready=false;
      try{await this.send({kind:'fail',error:this.error});}catch{/* Real persistence failure retains the error and blocks close. */}this.emit();}).finally(()=>{this.working=undefined;});
    return this.working;
  }
  async pause(){
    await Promise.all([...this.intents]);
    if(this.view?.phase==='pause-incomplete'||this.error)return false;
    if(!this.view)return true;
    await this.send({kind:'run',running:false});await this.working;await this.tick();
    return this.view.phase==='paused'&&!this.error;
  }
  async recover(){this.frame?.dispose();this.frame=undefined;this.error=undefined;await this.send({kind:'recover'});await this.tick();}
  dispose(){this.stopped=true;clearInterval(this.timer);this.frame?.dispose();this.candidate?.dispose();}
}
import { observation } from '../acceptance-observation';
