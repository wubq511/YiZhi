import * as lib from '@excalidraw/excalidraw';
import React from 'react';
import {createRoot} from 'react-dom/client';
(async()=>{

const status=document.getElementById('status'),preview=document.getElementById('preview'),editor=document.getElementById('editor');
let data=JSON.parse(document.getElementById('diagram-data').textContent),api=null,root=null,editing=false,fitted=false;
const download=(blob,name)=>{const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(a.href),2000);};
try{

 data.elements=lib.restoreElements(data.elements,null,{refreshDimensions:true});
 const current=()=>editing&&api?{...data,elements:api.getSceneElements(),appState:{...data.appState,viewBackgroundColor:'#ffffff'},files:api.getFiles()}:data;
 async function renderPreview(){const scene=current();const svg=await lib.exportToSvg({elements:scene.elements,appState:{...scene.appState,exportBackground:true,exportWithDarkMode:false},files:scene.files,exportPadding:30});preview.replaceChildren(svg);status.textContent=`已载入 ${scene.elements.length} 个原生图形元素 · 预览与源文件使用同一份数据`;}
 await renderPreview();
 for(const id of ['edit','save','png','svg'])document.getElementById(id).disabled=false;
 document.getElementById('edit').addEventListener('click',async()=>{
  
  preview.hidden=true;editor.hidden=false;editing=true;document.getElementById('read').hidden=false;document.getElementById('edit').hidden=true;
  if(!root){root=createRoot(editor);root.render(React.createElement(lib.Excalidraw,{initialData:{...data,scrollToContent:false},langCode:'zh-CN',theme:'light',excalidrawAPI:(a)=>{api=a;},onChange:(elements)=>{if(api&&!fitted&&elements.length){fitted=true;requestAnimationFrame(()=>api.scrollToContent(elements,{fitToViewport:true,viewportZoomFactor:0.70,animate:false}));}status.textContent=`可编辑画布 · ${elements.filter(e=>!e.isDeleted).length} 个元素 · 修改后下载保存`;},UIOptions:{canvasActions:{loadScene:true,saveToActiveFile:false,export:false}}}));}
 });
 document.getElementById('read').addEventListener('click',async()=>{data=current();await renderPreview();editing=false;editor.hidden=true;preview.hidden=false;document.getElementById('read').hidden=true;document.getElementById('edit').hidden=false;});
 document.getElementById('save').addEventListener('click',()=>download(new Blob([JSON.stringify(current(),null,2)],{type:'application/json'}),'excalidraw-mux.excalidraw'));
 document.getElementById('svg').addEventListener('click',async()=>{const scene=current();const svg=await lib.exportToSvg({elements:scene.elements,appState:{...scene.appState,exportBackground:true,exportWithDarkMode:false},files:scene.files,exportPadding:30});download(new Blob([svg.outerHTML],{type:'image/svg+xml'}),'excalidraw-mux.svg');});
 document.getElementById('png').addEventListener('click',async()=>{const scene=current();const blob=await lib.exportToBlob({elements:scene.elements,appState:{...scene.appState,exportBackground:true,exportWithDarkMode:false},files:scene.files,exportPadding:30,mimeType:'image/png',getDimensions:(width,height)=>({width:width*2,height:height*2,scale:2})});download(blob,'excalidraw-mux.png');});
}catch(error){status.textContent='渲染失败：'+error.message;status.setAttribute('role','alert');}

})();
