import {resolveCharacterAsset} from './data-cards.mjs';
import {operationFor,validateOperation} from './operations.mjs';

export const settledStates=new Set(['completed','reused','skipped']);
export class SkipNode extends Error {}
const clone=v=>structuredClone(v);

// Reused rows never become new candidates: source cost and provenance stay original.
export function outputCandidates(runs,workflowId,nodeId){
 return runs.filter(r=>r.version===2&&r.config?.workflow?.id===workflowId)
  .flatMap(r=>[r,...(r.revisions||[]).slice().reverse()].flatMap(version=>(version.steps||[]).filter(n=>n.id===nodeId&&n.status==='completed'&&!n.privateResult&&(n.artifacts?.length||n.result))
   .map(row=>{const node=row.outputDefinition||version.config.workflow.steps.flatMap(s=>s.nodes).find(n=>n.id===nodeId);return {runId:r.id,workflowId,created:row.finishedAt||r.created,nodeId,kind:node?.kind,model:node?.model,parameters:node?.parameters,artifacts:clone(row.artifacts||[]),result:clone(row.result),sourceCost:row.cost}})).slice(0,1))
  .sort((a,b)=>b.created.localeCompare(a.created));
}
export function selectReusable(workflow,runs,readAsset){
 const reusable={};
 for(const node of workflow.steps.flatMap(s=>s.nodes)){
  const choice=node.reuse||{mode:'latest'},candidates=outputCandidates(runs,choice.workflowId||workflow.id,node.id);
  const source=choice.mode==='pinned'?candidates.find(r=>r.runId===choice.runId):candidates.find(r=>r.kind===node.kind);
  if(!source){reusable[node.id]={reason:'Сохранённого результата нет'};continue}
  if(source.kind!==node.kind){reusable[node.id]={reason:'Тип сохранённого результата изменился'};continue}
  const artifacts=source.artifacts.filter(a=>{
   if(a.expiresAt!=null&&(!Number.isFinite(a.expiresAt)||a.expiresAt<=Date.now()))return false;
   if(a.file){try{readAsset(a.file)}catch{return false}}
   return true;
  });
  if(source.artifacts.length&&!artifacts.length){reusable[node.id]={reason:'Результат недоступен или срок ссылки истёк'};continue}
  reusable[node.id]={...source,artifacts};
 }
 return reusable;
}
export function reusedRow(node,source){
 return source?.runId?{status:'reused',artifacts:clone(source.artifacts),result:clone(source.result),reusedFrom:{runId:source.runId,nodeId:node.id,created:source.created,model:source.model,parameters:source.parameters,sourceCost:source.sourceCost},cost:0}
 :{status:'skipped',artifacts:[],cost:0,reason:source?.reason||'Step отключён; сохранённого результата нет'};
}

// Resolve dependencies before any pricing, upload or generation can occur.
export function resolveNodeInputs(node,group,rows,{preview=false,dataCards=[]}={}){
 const d=operationFor(node),inputs=clone(node.inputs||{}),omitted=[];
 const rowFor=id=>rows.find(r=>r.id===id);
 function fromArtifact(ref){
  const row=rowFor(ref.nodeId);
  if(preview&&row?.status==='waiting')return {pending:true};
  const a=row?.artifacts?.find(a=>a.port===ref.port&&a.index===(ref.outputIndex??ref.index??0));
  if(!a||a.expiresAt!=null&&(!Number.isFinite(a.expiresAt)||a.expiresAt<=Date.now())){omitted.push(ref.nodeId);return undefined}
  return clone(a);
 }
 function resolve(value){
  if(Array.isArray(value))return value.map(resolve).filter(v=>v!==undefined);
  if(value&&typeof value==='object'){
   if(value.dataCardId)return resolveCharacterAsset(dataCards,value);
   if(value.$media)return fromArtifact(value.$media);
   if(value.$node){
    const row=rowFor(value.$node.nodeId);if(preview&&row?.status==='waiting')return {pending:true};
    let result=row?.result;
    for(const key of value.$node.path.split('.').filter(Boolean)){if(['__proto__','constructor','prototype'].includes(key))throw Error('Недопустимый путь');result=result&&Object.hasOwn(result,key)?result[key]:undefined}
    if(result==null){omitted.push(value.$node.nodeId);return undefined}return clone(result);
   }
   return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,resolve(v)]).filter(([,v])=>v!==undefined));
  }return value;
 }
 const parameters=resolve({...node.parameters,...(node.model?{model:node.model}:{})});
 if(omitted.length)throw new SkipNode('Нет результата для ссылки в параметрах: '+[...new Set(omitted)].join(', '));
 for(const edge of group.edges.filter(e=>e.to.nodeId===node.id)){
  inputs[edge.to.port]||=[];inputs[edge.to.port][edge.to.slot||0]=fromArtifact(edge.from);
 }
 for(const [key,bindings] of Object.entries(inputs)){
  const original=bindings.map(resolve),mapping=new Map(),values=[];
  for(const [index,value] of original.entries()){
   if(value?.missing)throw Error('Выберите источник для '+key);
   if(value==null)continue;mapping.set(index+1,values.length+1);values.push(value);
  }
  const label={input_references:'Image',input_video_references:'Video',input_audio_references:'Audio'}[key];
  if(label&&values.length<original.length&&typeof parameters.prompt==='string'){
   parameters.prompt=parameters.prompt.replace(new RegExp('@'+label+'(\\d+)','g'),(token,index)=>{
    const newIndex=mapping.get(+index);if(!newIndex)throw new SkipNode('Описание использует отсутствующий reference '+token);return '@'+label+newIndex;
   });
  }
  inputs[key]=values;
 }
 const validation={...parameters};
 for(const [key,values] of Object.entries(inputs)){
  const port=d.inputs[key]||{};
  if(!values.length){delete validation[key];continue}
  validation[key]=port.multiple?values.map(()=>({type:port.type+'_url',[port.type+'_url']:{url:{pending:true}}})):{pending:true};
 }
 try{validateOperation(node,validation,{complete:true})}catch(e){if(omitted.length)throw new SkipNode('Недостаточно входов после пропуска источника: '+e.message);throw e}
 return {parameters,inputs,omitted:[...new Set(omitted)]};
}
export function executionPreview(workflow,plan,reusable,existing=[]){
 const rows=[];
 for(const stage of plan.stages){
  const group=workflow.steps.find(g=>g.id===stage.stepId);
  for(const nodeId of stage.nodeIds){
   const node=group.nodes.find(n=>n.id===nodeId),prior=existing.find(r=>r.id===nodeId);
   if(prior&&settledStates.has(prior.status)){rows.push(clone(prior));continue}
   if(group.enabled===false){rows.push({id:nodeId,...reusedRow(node,reusable[nodeId])});continue}
   try{const resolved=resolveNodeInputs(node,group,rows,{preview:true,dataCards:workflow.dataCards});rows.push({id:nodeId,status:'waiting',omitted:resolved.omitted})}
   catch(e){if(!(e instanceof SkipNode))throw e;rows.push({id:nodeId,status:'skipped',reason:e.message,artifacts:[],cost:0})}
  }
 }
 return rows;
}
