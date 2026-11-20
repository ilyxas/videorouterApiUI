import {reconnectDataCards} from './data-cards.mjs';
import {compileGraph,editorToWorkflow} from './graph.mjs';
import {operations,operationFor} from './operations.mjs';

const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
const validId=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,200}$/.test(value);
export const workflowJSONLimit=3*1024*1024;
function checkJSON(value,depth=0){
 if(depth>64)throw Error('JSON слишком глубоко вложен');
 if(value&&typeof value==='object')for(const [key,v] of Object.entries(value)){
  if(['__proto__','constructor','prototype'].includes(key))throw Error('Недопустимое поле JSON: '+key);
  checkJSON(v,depth+1);
 }
}
export function portableWorkflow(input,{routes,assetLookup}={}){
 if(!object(input)||!Array.isArray(input.steps)||input.steps.length>100)throw Error('Ожидается JSON workflow с массивом steps (до 100 Steps)');
 if(input.version!=null&&![1,2].includes(input.version))throw Error('Неподдерживаемая версия workflow');
 checkJSON(input);
 if(input.version!==2&&input.steps.some(s=>!object(s)||typeof s.op!=='string'||!object(s.params)))throw Error('Неверная схема legacy workflow');
 const raw=editorToWorkflow(input),warnings=[];
 const dataCards=raw.dataCards?reconnectDataCards(raw.dataCards,assetLookup,warnings):undefined;
 if(typeof raw.name!=='string'||!raw.name.trim()||raw.name.length>150)throw Error('Название workflow должно содержать от 1 до 150 символов');
 const missing=(name,location)=>{warnings.push('Выберите локальный файл: '+location);return {$missingAsset:{name:typeof name==='string'?name:'Локальный файл'}}};
 function parameters(value,location,key=''){
  if(Array.isArray(value))return value.map((v,i)=>parameters(v,location+'['+i+']'));
  if(object(value)){
   if(value.$missingAsset)return missing(value.$missingAsset.name,location);
   if(value.$node||value.$media)return structuredClone(value);
   if(value.assetId)return missing(value.name,location);
   return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,parameters(v,location+'.'+k,k)]));
  }
  if(typeof value==='string'&&((key==='file'&&value)||/^(data:|file:|blob:|\/asset\/)/i.test(value)))return missing(undefined,location);
  return value;
 }
 const workflow={version:2,name:raw.name,...(dataCards?{dataCards}:{}),...(raw.view?{view:raw.view}:{}),steps:raw.steps.map((g,stepIndex)=>{
  if(!object(g)||!validId(g.id)||g.name!=null&&typeof g.name!=='string'||!Array.isArray(g.nodes)||!Array.isArray(g.edges))throw Error('Неверная схема Step');
  for(const key of ['enabled','continueOnSuccess'])if(g[key]!=null&&typeof g[key]!=='boolean')throw Error('Флаг '+key+' должен быть boolean');
  if(g.view!=null&&!['cards','flow'].includes(g.view))throw Error('Неизвестный вид Step');
  return {id:g.id,name:g.name||'Step '+(stepIndex+1),enabled:g.enabled!==false,continueOnSuccess:g.continueOnSuccess!==false,view:g.view||'cards',nodes:g.nodes.map(n=>{
   if(!object(n)||!validId(n.id)||!Object.hasOwn(operations,n.operationId)||!object(n.parameters)||!object(n.inputs))throw Error('Неверная схема карточки');
   const d=operationFor(n),op=n.op||d.op;
   if(n.kind!==d.kind||d.kind!=='api'&&op!==d.op||routes&&!routes.has(op))throw Error('Неизвестная или несовместимая API-операция: '+op);
   const inputs={};
   for(const [key,bindings] of Object.entries(n.inputs)){
    if(!Array.isArray(bindings))throw Error('Вход '+key+' должен быть массивом');
    inputs[key]=Array.from(bindings,(b,i)=>{
     if(b==null)return null;if(!object(b))throw Error('Неверный источник входа '+key);
     if(b.dataCardId)return {dataCardId:b.dataCardId,assetId:b.assetId};
     if(b.assetId||b.file||b.missing||b.$missingAsset||typeof b.url==='string'&&/^(data:|file:|blob:|\/asset\/)/i.test(b.url)){
      warnings.push('Выберите локальный файл: '+n.id+'.'+key+'['+i+']');return {missing:true,name:b.name||b.$missingAsset?.name||'Локальный файл'};
     }
     return structuredClone(b);
    });
   }
   if(n.reuse?.mode==='pinned')warnings.push('Закреплённый output '+n.id+' не переносится; история запусков не входит в JSON');
   return {id:n.id,kind:n.kind,operationId:n.operationId,op,...(n.model?{model:n.model}:{}),parameters:parameters(n.parameters,n.id+'.parameters'),inputs,advanced:!!n.advanced,wait:n.wait!==false,quoteFacts:structuredClone(n.quoteFacts||{}),reuse:{mode:'latest'}};
  }),edges:g.edges.map(e=>{
   if(!object(e)||!validId(e.id)||!object(e.from)||!object(e.to))throw Error('Неверная схема связи');
   return {id:e.id,from:structuredClone(e.from),to:structuredClone(e.to)};
  })};
 })};
 compileGraph(workflow,{allowEmpty:true});
 return {workflow,warnings:[...new Set(warnings)]};
}

export function parseWorkflowJSON(text,options){
 if(typeof text!=='string'||new TextEncoder().encode(text).length>workflowJSONLimit)throw Error('JSON workflow должен быть не больше 3 MiB');
 let input;try{input=JSON.parse(text)}catch{throw Error('Не удалось прочитать JSON: проверьте синтаксис файла')}
 return portableWorkflow(input,options);
}
