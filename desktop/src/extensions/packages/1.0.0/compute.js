'use strict';
// Authored finite generated package: at most four inputs and one complete 250ms step.
// Deliberately independent of the host's literal minterm oracle.
let current, version;
function evaluate(state, inputs) {
  const names = version === '2.0.0' ? ['A','B','C','D'] : ['A','B','C'];
  if (!inputs || Object.keys(inputs).length !== names.length || names.some(n => inputs[n] !== 0 && inputs[n] !== 1)) throw Error('输入不在声明范围');
  let ones = 0;
  for (const name of names) ones += inputs[name];
  const result = {inputs: {...inputs}, step:state.step, simulationTime:state.simulationTime, seed:state.seed, output:ones % 2};
  if (version !== '1.0.0') result.ones = ones;
  return result;
}
onmessage = ({data:q}) => {
  try {
    if (q.kind === 'initialize') {version=q.version; current=evaluate(q.state,q.inputs ?? q.state.inputs);}
    else if (q.kind === 'step') {current=evaluate({...current,step:current.step+1,simulationTime:current.simulationTime+250},current.inputs);}
    else if (q.kind === 'migrate') {if(version!=='1.1.0' || q.from!=='parity-state-1') throw Error('输入或现场版本不兼容'); current=evaluate(q.state,q.state.inputs);}
    else if (!['pause','resume','snapshot'].includes(q.kind)) throw Error('未知生命周期命令');
    postMessage({id:q.id,state:current});
  } catch(error) {postMessage({id:q.id,error:String(error)});}
};
