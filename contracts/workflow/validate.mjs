import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {parseWorkflowJSON} from '../../public/workflow-json.mjs';
import {operations} from '../../public/operations.mjs';
import {validateGraphRequests} from '../../graph-engine.mjs';

const schema=JSON.parse(readFileSync(new URL('workflow.schema.json',import.meta.url)));
const catalog=JSON.parse(readFileSync(new URL('../../public/catalog.json',import.meta.url)));
const routes=new Map(catalog.routes.map(r=>[r.id,r]));
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const fail=(path,message)=>{throw Error(path+': '+message)};

// Only the JSON Schema keywords used by this bundled schema; not a general-purpose engine.
function shape(value,s,path='$'){
 if(s.$ref)return shape(value,schema.$defs[s.$ref.replace('#/$defs/','')],path);
 if(s.anyOf){if(!s.anyOf.some(option=>{try{shape(value,option,path);return true}catch{return false}}))fail(path,'does not match an allowed shape');return}
 if(s.const!==undefined&&!isDeepStrictEqual(value,s.const))fail(path,'expected '+JSON.stringify(s.const));
 if(s.enum&&!s.enum.includes(value))fail(path,'unsupported value');
 if(s.type){const valid={object:object(value),array:Array.isArray(value),string:typeof value==='string',boolean:typeof value==='boolean',integer:Number.isInteger(value),number:typeof value==='number'&&Number.isFinite(value),null:value===null}[s.type];if(!valid)fail(path,'expected '+s.type)}
 if(typeof value==='string'){
  if(s.minLength!=null&&value.length<s.minLength||s.maxLength!=null&&value.length>s.maxLength||s.pattern&&!new RegExp(s.pattern).test(value))fail(path,'invalid string');
 }
 if(typeof value==='number'&&(s.minimum!=null&&value<s.minimum||s.maximum!=null&&value>s.maximum))fail(path,'out of range');
 if(Array.isArray(value)){
  if(s.minItems!=null&&value.length<s.minItems||s.maxItems!=null&&value.length>s.maxItems)fail(path,'invalid array length');
  if(s.items)value.forEach((v,i)=>shape(v,s.items,path+'['+i+']'));
 }
 if(object(value)){
  for(const key of s.required||[])if(!Object.hasOwn(value,key))fail(path,'missing '+key);
  for(const [key,v] of Object.entries(value)){
   if(s.properties&&Object.hasOwn(s.properties,key))shape(v,s.properties[key],path+'.'+key);
   else if(s.additionalProperties===false)fail(path,'unexpected '+key);
   else if(object(s.additionalProperties))shape(v,s.additionalProperties,path+'.'+key);
  }
 }
}

export function validateWorkflowContract(text,{assetContext}={}){
 const assets=assetContext?new Map((assetContext.files||[]).map(f=>[f.id,f])):null;
 const assetLookup=assets?id=>assets.get(id):undefined;
 // Importer first enforces byte/depth limits and prototype-key rejection before our traversal.
 const imported=parseWorkflowJSON(text,{routes,assetLookup}),raw=JSON.parse(text);shape(raw,schema);
 const edgeIds=new Set();
 for(const [gi,g] of raw.steps.entries()){
  for(const e of g.edges){if(edgeIds.has(e.id))fail('edges','duplicate edge ID '+e.id);edgeIds.add(e.id)}
  for(const [ni,n] of g.nodes.entries()){
   const loc='steps['+gi+'].nodes['+ni+']',d=operations[n.operationId];
   if(routes.get(n.op)?.method==='WS')fail(loc,'WebSocket is not a workflow HTTP card');
   if(Object.hasOwn(n.parameters,'model'))fail(loc+'.parameters','model belongs on the node');
   if(!isDeepStrictEqual(n.parameters,imported.workflow.steps[gi].nodes[ni].parameters))fail(loc+'.parameters','import would replace local/embedded assets; declare reattachment explicitly');
   function expressions(v){
    if(!v||typeof v!=='object')return;
    if(v.$media)fail(loc,'use typed edges for media');
    if(v.$node){
     const r=v.$node;if(Object.keys(v).length!==1||!object(r)||Object.keys(r).some(k=>!['nodeId','path'].includes(k))||typeof r.nodeId!=='string'||typeof r.path!=='string'||!/^([\w-]+(?:\.[\w-]+)*)?$/.test(r.path)||r.path.split('.').some(k=>['constructor','prototype','__proto__'].includes(k)))fail(loc,'invalid $node expression');
    }
    Object.values(v).forEach(expressions);
   }
   expressions(n.parameters);
   for(const key of Object.keys(d.inputs))if(Object.hasOwn(n.parameters,key))fail(loc+'.parameters','put '+key+' in inputs/edges');
   for(const [key,bindings] of Object.entries(n.inputs)){
    if(!Object.hasOwn(d.inputs,key))fail(loc+'.inputs','unknown port '+key);
    for(const b of bindings)if(b?.url){let u;try{u=new URL(b.url)}catch{fail(loc,'invalid asset URL')}if(u.protocol!=='https:'||!u.hostname)fail(loc,'asset URL must be HTTPS')}
   }
   for(const [key,port] of Object.entries(d.inputs)){
    const direct=n.inputs[key]||[],slots=new Set(direct.flatMap((b,i)=>b==null?[]:[i]));
    for(const e of g.edges.filter(e=>e.to.nodeId===n.id&&e.to.port===key))slots.add(e.to.slot);
    if(!port.multiple&&(direct.length>1||[...slots].some(i=>i!==0)))fail(loc,'single input '+key+' only accepts slot 0');
    if(slots.size&&Math.max(...slots)!==slots.size-1)fail(loc,'non-consecutive slots for '+key);
    if(direct.length&&direct.at(-1)===null&&!slots.has(direct.length-1))fail(loc,'unbound trailing slot for '+key);
   }
  }
 }
 let executionPreflight;
 try{
  const usesDataCards=raw.steps.some(g=>g.enabled!==false&&g.nodes.some(n=>Object.values(n.inputs).flat().some(b=>b?.dataCardId)));
  if(usesDataCards&&!assets)throw Error('DataCard asset availability requires --asset-context FILE');
  validateGraphRequests(imported.workflow,routes,{readAsset:assets?id=>{const file=assets.get(id);if(!file)throw Error('DataCard asset is unavailable in the supplied context');return file}:undefined});executionPreflight={valid:true};
 }catch(error){executionPreflight={valid:false,error:error.message}}
 return {contractVersion:3,importValid:true,steps:raw.steps.length,cards:raw.steps.reduce((n,s)=>n+s.nodes.length,0),dataCards:raw.dataCards?.length||0,warnings:imported.warnings,executionPreflight};
}

if(process.argv[1]===fileURLToPath(import.meta.url)){
 try{
  const args=process.argv.slice(2);let file,contextFile,ready=false;
  for(let i=0;i<args.length;i++){
   if(args[i]==='--ready')ready=true;
   else if(args[i]==='--asset-context'){contextFile=args[++i];if(!contextFile)throw Error('Missing asset context file')}
   else if(!args[i].startsWith('--')&&!file)file=args[i];else throw Error('Usage: node contracts/workflow/validate.mjs FILE [--ready] [--asset-context FILE]');
  }
  if(!file)throw Error('A workflow JSON file is required');
  const assetContext=contextFile?JSON.parse(readFileSync(contextFile,'utf8')):undefined;
  const result=validateWorkflowContract(readFileSync(file,'utf8'),{assetContext});console.log(JSON.stringify(result,null,2));if(ready&&!result.executionPreflight.valid)process.exitCode=1;
 }catch(error){console.error(JSON.stringify({importValid:false,error:error.message}));process.exitCode=1}
}
