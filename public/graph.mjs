import {operationIdFor,operationFor,operations} from './operations.mjs';

const clone=v=>structuredClone(v);
const id=()=>globalThis.crypto.randomUUID?.()||Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)),b=>b.toString(16).padStart(2,'0')).join('');
export class BaseCard {
 constructor(definition){this.definition=clone(definition)}
 get id(){return this.definition.id}
 get operation(){return operationFor(this.definition)}
 get inputs(){return this.operation.inputs}
 get outputType(){return this.operation.kind}
 toJSON(){return clone(this.definition)}
}
export class ImageCard extends BaseCard {}
export class VideoCard extends BaseCard {}
export class AudioCard extends BaseCard {}
export class TextCard extends BaseCard {}
export class ApiCard extends BaseCard {}
export function cardFactory(def){const C={image:ImageCard,video:VideoCard,audio:AudioCard,text:TextCard,api:ApiCard}[def.kind];if(!C)throw Error('Неизвестный тип карточки');return new C(def)}
export function nodePort(kind){return {image:'images',video:'videos',audio:'audio',text:'text',api:'raw'}[kind]}
export function editorToWorkflow(flow){
 if(flow.version===2)return clone(flow);
 const rows=clone(flow.steps||[]);for(const s of rows)s.id||=id();
 const groups=flow.groups?.length?clone(flow.groups):rows.map(s=>({id:'step-'+s.id,name:'Step '+(rows.indexOf(s)+1),continueOnSuccess:true,nodeIds:[s.id]}));
 // New nodes inherit a selected group; unassigned legacy nodes get their own Step.
 for(const s of rows)if(!groups.some(g=>g.nodeIds.includes(s.id)))groups.push({id:'step-'+s.id,name:'Step '+(groups.length+1),continueOnSuccess:true,nodeIds:[s.id]});
 const origin=new Map(rows.map(s=>[s.id,groups.find(g=>g.nodeIds.includes(s.id))?.id]));
 const workflow={version:2,id:flow.id||id(),name:flow.name||'Workflow',steps:groups.map(g=>({id:g.id,name:g.name,continueOnSuccess:g.continueOnSuccess!==false,enabled:g.enabled!==false,view:g.view||'cards',nodes:[],edges:[]}))};
 const typedSource=src=>src.mode==='file'?{assetId:src.file,...(src.name?{name:src.name}:{}),...(src.width?{width:src.width,height:src.height}:{})}:src.mode==='url'?{url:src.url}:null;
 for(const s of rows){
  const group=workflow.steps.find(g=>g.id===origin.get(s.id)),operationId=operationIdFor(s),d=operations[operationId];
  const node={id:s.id,kind:d.kind,operationId,op:s.op,model:s.params.model,parameters:clone(s.params),inputs:{},advanced:!!s.advanced,wait:s.wait!==false,quoteFacts:clone(s.quoteFacts||{}),reuse:clone(s.reuse||{mode:'latest'}),editor:clone(s)};
  delete node.parameters.model;
  function source(src,key,slot){
   if(!src||src.mode==='none')return;
   if(src.mode==='file'&&!src.file||src.mode==='url'&&!src.url||src.mode==='previous'&&!src.stepId&&!src.ref){node.inputs[key][slot]={missing:true};return}
   if(src.mode==='previous'&&src.stepId){
    group.edges.push({id:'edge-'+node.id+'-'+key+'-'+slot,from:{stepId:origin.get(src.stepId),nodeId:src.stepId,port:src.port||'images',outputIndex:src.index??0},to:{nodeId:node.id,port:key,slot}});
   }else if(src.mode==='speech'){
    const speechId=node.id+'-speech-'+key+'-'+slot;
    group.nodes.push({id:speechId,kind:'audio',operationId:'speech',op:'POST /v1/audio/speech',model:'tts-1',parameters:{input:src.text,voice:src.voice||'alloy',response_format:'mp3'},inputs:{}});
    group.edges.push({id:'edge-'+speechId,from:{stepId:group.id,nodeId:speechId,port:'audio',outputIndex:0},to:{nodeId:node.id,port:key,slot}});
   }else if(src.ref)node.inputs[key][slot]={legacy:src.ref};
   else node.inputs[key][slot]=typedSource(src);
  }
  for(const [legacyKey,src] of Object.entries(s.media||{})){
   const key=legacyKey==='reference_image'?'input_references':legacyKey;
   delete node.parameters[key];delete node.parameters[legacyKey];node.inputs[key]=[];
   if(src.mode==='list')src.items.forEach((v,i)=>source(v,key,i));else source(src,key,0);
  }
  group.nodes.push(node);
 }
 // Convert positional references to stable node IDs, including arbitrary API JSON paths.
 function convert(v){
  if(typeof v==='string'){
   const m=/^\{\{(\d+)((?:\.[\w-]+)*)\}\}$/.exec(v);
   if(m){const s=rows[+m[1]-1];if(!s)throw Error('Ссылка на отсутствующую карточку');return {$node:{nodeId:s.id,path:m[2].slice(1)}}}
  }
  if(Array.isArray(v))return v.map(convert);
  if(v&&typeof v==='object'){
   if(v.legacy)return convert(v.legacy);
   if(v.$artifact){const r=v.$artifact;return {$media:{nodeId:r.stepId,port:r.port,index:r.index,type:r.type}}}
   return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,convert(x)]));
  }
  return v;
 }
 for(const g of workflow.steps)for(const n of g.nodes){n.parameters=convert(n.parameters);n.inputs=convert(n.inputs)}
 return workflow;
}
export function workflowToEditor(w){
 if(w.version!==2)return clone(w);
 const rows=[],groups=[];
 for(const g of w.steps){
  groups.push({id:g.id,name:g.name,continueOnSuccess:g.continueOnSuccess!==false,enabled:g.enabled!==false,view:g.view||'cards',nodeIds:g.nodes.map(n=>n.id)});
  for(const n of g.nodes){
   const row={...(n.editor||{}),id:n.id,op:n.op||operationFor(n).op,action:n.operationId,params:{...clone(n.parameters),...(n.model?{model:n.model}:{})},wait:n.wait!==false,media:{},quoteFacts:clone(n.quoteFacts||{}),reuse:clone(n.reuse||{mode:'latest'})};
   for(const [key,bindings] of Object.entries(n.inputs||{})){
    const list=(Array.isArray(bindings)?bindings:[bindings]).map(b=>b?.assetId?{mode:'file',file:b.assetId,name:b.name||'Локальный файл',...(b.width?{width:b.width,height:b.height}:{})}:b?.url?{mode:'url',url:b.url}:b?.$node?{mode:'previous',stable:b.$node}:{mode:'none'});
    row.media[key]=operationFor(n).inputs[key]?.multiple?{mode:'list',items:list}:list[0]||{mode:'none'};
   }
   for(const e of g.edges.filter(e=>e.to.nodeId===n.id)){
    const src={mode:'previous',stepId:e.from.nodeId,port:e.from.port,index:e.from.outputIndex};
    const key=e.to.port;
    if(operationFor(n).inputs[key]?.multiple){row.media[key]||={mode:'list',items:[]};row.media[key].items[e.to.slot||0]=src}else row.media[key]=src;
   }
   rows.push(row);
  }
 }
 const positions=new Map(rows.map((r,i)=>[r.id,i+1]));
 function legacy(v){if(Array.isArray(v))return v.map(legacy);if(v&&typeof v==='object'){if(v.$node)return '{{'+positions.get(v.$node.nodeId)+(v.$node.path?'.'+v.$node.path:'')+'}}';return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,legacy(x)]))}return v}
 for(const r of rows){r.params=legacy(r.params);for(const src of Object.values(r.media)){const list=src.mode==='list'?src.items:[src];for(const s of list)if(s?.stable){s.ref=legacy({$node:s.stable});delete s.stable}}}
 return {name:w.name,id:w.id,steps:rows,groups};
}
export function compileGraph(workflow,{allowEmpty=false}={}){
 const w=editorToWorkflow(workflow),nodes=new Map(),stages=new Map(),dependencies=new Map();
 if(!w.steps?.length&&!allowEmpty)throw Error('Добавьте Step');
 for(const [gi,g] of w.steps.entries()){
  if(!g.id||stages.has(g.id)||(!g.nodes?.length&&!allowEmpty))throw Error('Step должен иметь уникальный ID и хотя бы одну карточку');stages.set(g.id,gi);
  for(const n of g.nodes){if(!n.id||nodes.has(n.id))throw Error('ID карточек должны быть уникальными');if(n.kind!==operationFor(n).kind)throw Error('Тип карточки не соответствует выходу операции');cardFactory(n);nodes.set(n.id,{node:n,step:g});dependencies.set(n.id,new Set())}
 }
 if(nodes.size>100)throw Error('Максимум 100 карточек');
 function depend(target,source){
  if(!nodes.has(source))throw Error('Источник связи не найден');
  if(stages.get(nodes.get(source).step.id)>stages.get(nodes.get(target).step.id))throw Error('Связь из будущего Step запрещена');
  dependencies.get(target).add(source);
 }
 const slots=new Set();
 for(const g of w.steps){
  for(const e of g.edges||[]){
   const origin=nodes.get(e.from.nodeId),target=nodes.get(e.to.nodeId);
   if(!origin||!target||target.step.id!==g.id||origin.step.id!==e.from.stepId)throw Error('Неверные границы связи');
   const port=operationFor(target.node).inputs[e.to.port];
   if(!port||port.type!==origin.node.kind||e.from.port!==nodePort(origin.node.kind))throw Error('Несовместимые порты связи');
   if(!Number.isInteger(e.from.outputIndex)||e.from.outputIndex<0||e.from.outputIndex>=(origin.node.parameters.n??1))throw Error('Выберите доступный output');
   const slot=e.to.slot??0;if(!Number.isInteger(slot)||slot<0||!port.multiple&&slot!==0)throw Error('Неверный слот');
   const key=[g.id,e.to.nodeId,e.to.port,slot].join(':');if(slots.has(key)||target.node.inputs?.[e.to.port]?.[slot])throw Error('Вход имеет несколько источников');slots.add(key);depend(target.node.id,origin.node.id);
  }
  for(const n of g.nodes){
   const visit=v=>{if(v&&typeof v==='object'){if(v.$node)depend(n.id,v.$node.nodeId);if(v.$media)depend(n.id,v.$media.nodeId);Object.values(v).forEach(visit)}};
   visit(n.parameters);visit(n.inputs);
  }
 }
 const done=new Set(),plan=[];
 for(const g of w.steps){
  const pending=[...g.nodes],ordered=[];
  while(pending.length){const i=pending.findIndex(n=>[...dependencies.get(n.id)].every(x=>done.has(x)));if(i<0)throw Error('Цикл в графе или нарушенная зависимость');const [n]=pending.splice(i,1);done.add(n.id);ordered.push(n.id)}
  plan.push({stepId:g.id,nodeIds:ordered,continueOnSuccess:g.continueOnSuccess!==false,enabled:g.enabled!==false});
 }
 return {version:2,workflow:w,stages:plan};
}

// Edit the canonical graph so legacy positional references are remapped by the codec.
export function moveGraphStep(flow,stepId,offset){
 const w=editorToWorkflow(flow),index=w.steps.findIndex(s=>s.id===stepId),target=index+offset;
 if(index<0||target<0||target>=w.steps.length)return workflowToEditor(w);
 w.steps.splice(target,0,w.steps.splice(index,1)[0]);compileGraph(w,{allowEmpty:true});return workflowToEditor(w);
}
export function deleteGraphStep(flow,stepId){
 const w=editorToWorkflow(flow),removed=new Set(w.steps.find(s=>s.id===stepId)?.nodes.map(n=>n.id)||[]);
 w.steps=w.steps.filter(s=>s.id!==stepId);
 function clean(value){
  if(Array.isArray(value))return value.map(clean).filter(v=>v!==undefined);
  if(value&&typeof value==='object'){
   if(removed.has(value.$node?.nodeId)||removed.has(value.$media?.nodeId))return undefined;
   return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,clean(v)]).filter(([,v])=>v!==undefined));
  }return value;
 }
 for(const g of w.steps){
  g.edges=g.edges.filter(e=>!removed.has(e.from.nodeId));
  for(const n of g.nodes){n.parameters=clean(n.parameters);n.inputs=clean(n.inputs)}
 }
 return workflowToEditor(w);
}
export function layoutStep(group){
 const placed=new Map(),pending=[...group.nodes],positions=[];
 while(pending.length){
  const index=pending.findIndex(n=>group.edges.filter(e=>e.to.nodeId===n.id&&e.from.stepId===group.id).every(e=>placed.has(e.from.nodeId)));
  if(index<0)throw Error('Цикл в графе');
  const [node]=pending.splice(index,1),parents=group.edges.filter(e=>e.to.nodeId===node.id&&e.from.stepId===group.id);
  const column=Math.max(0,...parents.map(e=>placed.get(e.from.nodeId).column+1)),row=positions.filter(p=>p.column===column).length;
  const position={id:node.id,column,row,x:20+column*224,y:20+row*200};placed.set(node.id,position);positions.push(position);
 }
 return {positions,width:Math.max(216,...positions.map(p=>p.x+196)),height:Math.max(216,...positions.map(p=>p.y+196))};
}
