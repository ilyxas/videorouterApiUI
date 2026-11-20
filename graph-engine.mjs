import {resolveCharacterAsset} from './public/data-cards.mjs';
import {randomUUID} from 'node:crypto';
import {setTimeout as sleep} from 'node:timers/promises';
import {compileGraph,nodePort} from './public/graph.mjs';
import {operationFor,validateOperation} from './public/operations.mjs';
import {normalizeRequest,publicMediaURL,assertQuoteMatches} from './public/workflow-core.mjs';
import {imageArtifacts} from './artifacts.mjs';
import {asyncPaths} from './engine.mjs';
import {settledStates,SkipNode,reusedRow,resolveNodeInputs,executionPreview} from './public/workflow-state.mjs';

const terminal=new Set(['completed','succeeded','success']);
const failed=new Set(['failed','cancelled','canceled','expired','error']);
const idempotent=new Set(['/v1/images','/v1/videos','/v1/lipsync','/v1/face-swap','/v1/avatars/videos','/v1/meshes']);
export function graphRun(name,workflow,reusable={}){
 const plan=compileGraph(workflow);
 return {id:randomUUID(),version:2,name:name||workflow.name,created:new Date().toISOString(),status:'running',revision:0,currentStage:0,cost:null,reusable:structuredClone(reusable),controls:[],
  config:{version:2,workflow:plan.workflow,plan},revisions:[],stages:plan.stages.map(g=>({...g,status:'waiting'})),
  steps:plan.stages.flatMap(g=>g.nodeIds.map(nodeId=>{const n=plan.workflow.steps.find(s=>s.id===g.stepId).nodes.find(n=>n.id===nodeId);return {id:nodeId,sourceStepId:g.stepId,nodeId,op:n.op||operationFor(n).op,status:'waiting',artifacts:[],technical:[]}}))};
}
export function workflowForStep(workflow,stepId){
 const w=structuredClone(workflow),index=w.steps.findIndex(s=>s.id===stepId);
 if(index<0||!w.steps[index].nodes.length)throw Error('Выберите непустой Step');
 w.steps=w.steps.slice(0,index+1).filter(s=>s.nodes.length).map(s=>({...s,enabled:s.id===stepId,continueOnSuccess:true}));
 return w;
}
export const completedStepIds=run=>new Set(run.stages.filter(s=>settledStates.has(s.status)).map(s=>s.stepId));
const missingAsset=value=>value&&typeof value==='object'&&(value.$missingAsset||Object.values(value).some(missingAsset));
export function validateGraphRequests(w,routes,{skipSteps=new Set(),readAsset}={}){
 const plan=compileGraph(w);
 for(const g of plan.workflow.steps)for(const n of g.nodes){
  if(g.enabled===false||skipSteps.has(g.id))continue;
  const op=n.op||operationFor(n).op,route=routes.get(op);
  if(!route||route.method==='WS')throw Error('Операция недоступна: '+op);
  for(const [key,bindings] of Object.entries(n.inputs||{}))for(const binding of bindings)if(binding?.dataCardId)resolveCharacterAsset(plan.workflow.dataCards,binding,operationFor(n).inputs[key]?.type,{readAsset});
  const p={...n.parameters,...(n.model?{model:n.model}:{})},d=operationFor(n);
  if(missingAsset(p))throw Error('Карточка '+n.id+': выберите локальный файл после импорта');
  for(const [key,bindings] of Object.entries(n.inputs||{})){
   if(bindings.some(b=>b?.missing))throw Error('Карточка '+n.id+': выберите источник для '+key);
   const entries=[...(bindings||[])];
   for(const e of g.edges.filter(e=>e.to.nodeId===n.id&&e.to.port===key))entries[e.to.slot||0]={pending:true};
   p[key]=d.inputs[key]?.multiple?entries.filter(Boolean).map(()=>({type:d.inputs[key].type+'_url',[d.inputs[key].type+'_url']:{url:{pending:true}}})):entries.some(Boolean)?{pending:true}:undefined;
  }
  for(const e of g.edges.filter(e=>e.to.nodeId===n.id))if(p[e.to.port]==null){const port=d.inputs[e.to.port];p[e.to.port]=port.multiple?[{type:port.type+'_url',[port.type+'_url']:{url:{pending:true}}}]:{pending:true}}
  validateOperation(n,p,{complete:true});
 }
 return plan;
}
export function reviseRun(run,workflow,reusable){
 if(run.status!=='paused')throw Error('Изменения разрешены только на паузе');
 if(workflow.id!==run.config.workflow.id)throw Error('Workflow запуска изменился');
 const plan=compileGraph(workflow),old=run.config.workflow;
 const completed=completedStepIds(run),kept=new Set();
 const definition=row=>row.outputDefinition||old.steps.flatMap(s=>s.nodes).find(n=>n.id===row.id);
 reusable??=Object.fromEntries(run.steps.filter(r=>settledStates.has(r.status)&&r.status!=='skipped').map(row=>[row.id,{...definition(row),runId:row.reusedFrom?.runId||run.id,created:row.finishedAt||run.created,artifacts:row.artifacts,result:row.result,sourceCost:row.reusedFrom?.sourceCost??row.cost}]));
 const replacement=graphRun(run.name,plan.workflow,reusable);
 for(const stage of replacement.stages)if(completed.has(stage.stepId)){
  for(const node of plan.workflow.steps.find(s=>s.id===stage.stepId).nodes){
   const index=replacement.steps.findIndex(r=>r.id===node.id),prior=run.steps.find(r=>r.id===node.id),source=reusable[node.id];
   if(prior&&settledStates.has(prior.status)&&source?.runId===(prior.reusedFrom?.runId||run.id)&&JSON.stringify(source.artifacts)===JSON.stringify(prior.artifacts)){
    const d=definition(prior);prior.outputDefinition||={kind:d.kind,model:d.model,parameters:structuredClone(d.parameters)};
    replacement.steps[index]=prior;kept.add(prior);
   }else Object.assign(replacement.steps[index],reusedRow(node,source));
  }
  stage.status=stage.nodeIds.every(id=>replacement.steps.find(r=>r.id===id).status==='skipped')?'skipped':'reused';
 }
 const archived=run.steps.filter(row=>!kept.has(row));
 run.revisions.push({revision:run.revision,config:run.config,steps:structuredClone(archived),stages:structuredClone(run.stages)});
 run.carriedCost=(run.carriedCost||0)+archived.reduce((sum,row)=>sum+(Number.isFinite(row.cost)?row.cost:0),0);
 run.config=replacement.config;run.reusable=replacement.reusable;run.revision++;
 run.steps=replacement.steps;run.stages=replacement.stages;run.currentStage=0;
 run.status='running';delete run.error;
}
export function createGraphRunner({routes,call,save,readAsset,storeFile,privateOutput=()=>false,readResult=(run,row)=>row?.result,pollDelay=4000,webhooks}){
 const active=new Map();
 const persist=run=>{const costs=[run.carriedCost,...run.steps.map(n=>n.cost)].filter(Number.isFinite);run.cost=costs.length?costs.reduce((a,b)=>a+b,0):null;save(run)};
 function artifact(run,nodeId,port,index){
  const a=run.steps.find(s=>s.id===nodeId)?.artifacts?.find(a=>a.port===port&&a.index===index);
  if(!a)throw Error('Выбранный output не получен: '+nodeId);
  if(a.expiresAt!=null&&(!Number.isFinite(a.expiresAt)||a.expiresAt<=Date.now()))throw Error('Срок доступности результата истёк');
  return a;
 }
 async function materialize(run,row,value,port,bytes){
  if(value==null)return undefined;
  if(value.$missingAsset)throw Error('Выберите локальный файл после импорта');
  if(value.$node){
   let result=readResult(run,run.steps.find(s=>s.id===value.$node.nodeId));
   for(const key of value.$node.path.split('.').filter(Boolean)){if(['__proto__','constructor','prototype'].includes(key))throw Error('Недопустимый путь');result=result&&Object.hasOwn(result,key)?result[key]:undefined}
   if(result==null)throw Error('Результат источника не найден');return port?materialize(run,row,result,port,bytes):result;
  }
  if(value.$media){const r=value.$media;return materialize(run,row,artifact(run,r.nodeId,r.port,r.index),port,bytes)}
  if(value.assetId||value.file){
   const fileId=value.assetId||value.file,f=readAsset(fileId);
   const type=f.type||value.mime;
   if(port?.type&&port.type!=='*'&&!type.startsWith(port.type+'/'))throw Error('Тип локального файла не соответствует входу '+port.type);
   if(port?.multipart)return fileId;
   if(!port) return value;
   const encoded=4*Math.ceil(f.bytes.length/3)+type.length+32;
   if(!port.urlOnly&&bytes.used+encoded<=8*1024*1024){bytes.used+=encoded;return 'data:'+type+';base64,'+f.bytes.toString('base64')}
   const tech={op:'POST /v1/uploads',status:'running',assetId:fileId};row.technical.push(tech);persist(run);
   const res=await call(routes.get(tech.op),{file:fileId});
   tech.status='completed';tech.result=res.data;persist(run);return publicMediaURL(res.data.url);
  }
  if(value.url)return publicMediaURL(value.url);
  if(typeof value==='string'&&port){
   if(value.startsWith('https:'))return publicMediaURL(value);
   if(value.startsWith('data:')){
    const m=/^data:([\w.+-]+\/[\w.+-]+);base64,([A-Za-z0-9+/]+=*)$/.exec(value);if(!m||!m[1].startsWith(port.type+'/'))throw Error('Неверный data URI');
    if(!port.urlOnly&&bytes.used+value.length<=8*1024*1024){bytes.used+=value.length;return value}
    return materialize(run,row,storeFile(Buffer.from(m[2],'base64'),'reference',m[1]),{...port,urlOnly:true},bytes);
   }
   return materialize(run,row,{assetId:value},port,bytes);
  }
  if(Array.isArray(value))return Promise.all(value.map(v=>materialize(run,row,v,null,bytes)));
  if(value&&typeof value==='object'){const out={};for(const [k,v] of Object.entries(value))out[k]=await materialize(run,row,v,null,bytes);return out}
  return value;
 }
 async function parameters(run,node,group,row){
  const d=operationFor(node),bytes={used:Buffer.byteLength(JSON.stringify(node.parameters))+1024};
  const resolved=resolveNodeInputs(node,group,run.steps.map(r=>({...r,result:readResult(run,r)})),{dataCards:run.config.workflow.dataCards});
  row.omitted=resolved.omitted;
  const p=await materialize(run,row,resolved.parameters,null,bytes);
  for(const [key,bindings] of Object.entries(resolved.inputs)){
   const port=d.inputs[key]||{type:'*'},actual={...port,urlOnly:d.urlOnly,multipart:d.multipart&&key==='file'};
   const values=[];for(const v of bindings)values.push(await materialize(run,row,v,actual,bytes));
   if(values.length)p[key]=port.multiple?values.map(url=>({type:port.type+'_url',[port.type+'_url']:{url}})):values[0];else delete p[key];
  }
  if(node.operationId==='chat-image')p.modalities=['image','text'];
  if(node.operationId==='chat-audio')p.modalities=['audio','text'];
  return normalizeRequest(row.op,p);
 }
 function outputs(run,node,result){
  const kind=node.kind,base={runId:run.id,stepId:node.id,nodeId:node.id,port:nodePort(kind),type:kind};
  if(kind==='image'){
   if(node.operationId==='chat-image'){
    const items=(result.choices?.[0]?.message?.images||[]).map(v=>{const url=v.image_url?.url;return url?.startsWith('data:')?{b64_json:url.split(',')[1]}:{url}});
    return imageArtifacts({data:items},run.id,node.id,storeFile);
   }
   return imageArtifacts(result,run.id,node.id,storeFile);
  }
  if(kind==='video'){
   if(!Array.isArray(result?.data)||!result.data.length)throw Error('Ответ не содержит видео');
   return result.data.map((v,index)=>({...base,id:run.id+':'+node.id+':'+index,index,url:publicMediaURL(v.url),...(result.output_expires_at?{expiresAt:result.output_expires_at*1000}:{})}));
  }
  if(kind==='audio'){
   let value=result;
   if(node.operationId==='chat-audio'){const a=result.choices?.[0]?.message?.audio;if(!a?.data)throw Error('Ответ не содержит аудио');const format=node.parameters.audio?.format||'wav';value=storeFile(Buffer.from(a.data,'base64'),'audio.'+format,format==='mp3'?'audio/mpeg':'audio/'+format)}
   if(!value?.file)throw Error('Ответ не содержит аудиофайл');
   const output=[{...value,...base,mime:value.type,id:run.id+':'+node.id+':0',index:0}];
   const transcript=result.choices?.[0]?.message?.audio?.transcript;if(transcript)output.push({...base,type:'text',port:'text',index:0,text:transcript,id:run.id+':'+node.id+':text'});
   return output;
  }
  if(kind==='text')return [{...base,id:run.id+':'+node.id+':0',index:0,text:result.text??result.choices?.[0]?.message?.content??JSON.stringify(result)}];
  return [];
 }
 async function poll(run,row,route,res){
  const until=Date.now()+(['/v1/batches','/v1/jobs'].includes(route.path)?25:1)*3600000;
  res=webhooks?.claim(row,res)||res;
  while(!terminal.has(res.data?.status)){
   if(Number.isFinite(res.cost))row.cost=res.cost;
   row.remoteStatus=res.data?.status;persist(run);
   if(failed.has(row.remoteStatus))throw Error(JSON.stringify(res.data.error||row.remoteStatus));
   if(Date.now()>until)throw Error('Истекло ожидание; job ID сохранён');
   const request=()=>call(routes.get('GET '+route.path+'/{id}'),{id:row.remoteId});
   if(webhooks)res=await webhooks.next(row,pollDelay,request);
   else{await sleep(pollDelay);res=await request()}
   if(Number.isFinite(res.cost))row.cost=res.cost;
  }
  row.remoteStatus=res.data?.status;
  return res;
 }
 async function start(run){
  if(active.has(run.id))throw Error('Запуск уже исполняется');active.set(run.id,run);
  try{
   for(let i=run.currentStage;i<run.stages.length;i++){
    const stage=run.stages[i],group=run.config.workflow.steps[i];
    if(settledStates.has(stage.status)){run.currentStage=i+1;continue}
    stage.status='running';persist(run);
    if(group.enabled===false){
     for(const node of group.nodes){
      let source=run.reusable?.[node.id];
      if(source?.artifacts?.length){const valid=source.artifacts.filter(a=>{
       if(a.expiresAt!=null&&a.expiresAt<=Date.now())return false;
       if(a.file){try{readAsset(a.file)}catch{return false}}return true;
      });source=valid.length?{...source,artifacts:valid}:{reason:'Сохранённый результат недоступен'};}
      Object.assign(run.steps.find(r=>r.id===node.id),reusedRow(node,source));
     }
     stage.status=stage.nodeIds.some(id=>run.steps.find(r=>r.id===id).status==='reused')?'reused':'skipped';
     run.currentStage=i+1;persist(run);continue;
    }
    for(const nodeId of stage.nodeIds){
     const row=run.steps.find(s=>s.id===nodeId),node=group.nodes.find(n=>n.id===nodeId);if(settledStates.has(row.status))continue;
     row.status='running';persist(run);
     const route=routes.get(row.op);let p;
     try{p=await parameters(run,node,group,row);validateOperation(node,p,{complete:true})}
     catch(e){if(!(e instanceof SkipNode))throw e;row.status='skipped';row.reason=e.message;row.cost=0;persist(run);continue}
     if(['image','video'].includes(node.kind)){
      const request={...p,endpoint:route.path};
      for(const [key,value] of Object.entries(node.quoteFacts||{}))if(Number.isFinite(value))request[({audio:'audio_secs',video:'video_secs'})[key]||key]=value;
      const quote=await call(routes.get('POST /v1/pricing/estimate'),request);row.estimate={request,response:quote.data};persist(run);assertQuoteMatches(p,quote.data);
     }
     p=webhooks?.prepare(run,row,route,p)||p;
     row.request={op:row.op,params:structuredClone(p),wait:node.wait!==false};row.idempotencyKey||=randomUUID();row.phase='submitting';persist(run);
     const sent=idempotent.has(route.path)?{...p,$headers:{...p.$headers,'Idempotency-Key':row.idempotencyKey}}:p;
     let res=await call(route,sent);if(Number.isFinite(res.cost))row.cost=res.cost;
     if(typeof res.data?.id==='string')row.remoteId=res.data.id;
     row.phase='submitted';persist(run);
     webhooks?.bind(row);
     if(route.method==='POST'&&asyncPaths.has(route.path)&&(node.kind==='video'||node.wait!==false)){
      if(!row.remoteId)throw Error('API не вернул job ID');res=await poll(run,row,route,res);
     }
     row.artifacts=outputs(run,node,res.data);row.privateResult=privateOutput(run,row,route,res.data);row.result=row.privateResult?{message:'Ответ доступен в памяти текущего сервера.'}:res.data;row.status='completed';row.phase='completed';row.finishedAt=new Date().toISOString();if(Number.isFinite(res.cost))row.cost=res.cost;persist(run);
    }
    stage.status=stage.nodeIds.every(id=>run.steps.find(r=>r.id===id).status==='skipped')?'skipped':'completed';run.currentStage=i+1;persist(run);
    if(stage.status!=='skipped'&&!stage.continueOnSuccess&&i<run.stages.length-1){run.status='paused';persist(run);return}
   }
   run.status='completed';
  }catch(e){
   run.status='failed';run.error=e.message;
   for(const row of run.steps)if(row.status==='running'){row.status='failed';row.error=e.message}else if(row.status==='waiting'){row.status='blocked';row.error='Запуск остановлен: '+e.message}
   const stage=run.stages.find(s=>s.status==='running');if(stage)stage.status='failed';
  }finally{active.delete(run.id);persist(run)}
 }
 async function recover(run){
  if(active.has(run.id))throw Error('Запуск ещё выполняется');
  if(!['interrupted','failed'].includes(run.status))throw Error('Восстановление не требуется');
  for(const row of run.steps)if(row.status!=='completed')webhooks?.recover(row);
  for(const row of run.steps.filter(s=>s.status!=='completed'&&s.remoteId)){
   const route=routes.get(row.op),statusRoute=routes.get('GET '+route.path+'/{id}');if(!statusRoute)continue;
   webhooks?.bind(row);
   const request=()=>call(statusRoute,{id:row.remoteId});
   const res=webhooks?await webhooks.poll(row,request):await request();row.remoteStatus=res.data.status;
   if(terminal.has(res.data.status)){const n=run.config.workflow.steps.flatMap(s=>s.nodes).find(n=>n.id===row.id);row.artifacts=outputs(run,n,res.data);row.result=res.data;row.status='completed';row.phase='completed';row.finishedAt=new Date().toISOString();if(Number.isFinite(res.cost))row.cost=res.cost}
   else{persist(run);return run}
  }
  if(run.steps.some(s=>s.phase==='submitting'&&s.status!=='completed'))throw Error('Результат отправки неизвестен; автоматический повтор запрещён');
  // Resume only at a complete Step boundary; failed creates require a new explicit run.
  const boundary=run.stages.findIndex(g=>!g.nodeIds.every(id=>settledStates.has(run.steps.find(s=>s.id===id)?.status)));
  if(boundary<0){run.currentStage=run.stages.length;run.status='completed'}
  else if(run.stages[boundary].nodeIds.some(id=>settledStates.has(run.steps.find(s=>s.id===id)?.status)||run.steps.find(s=>s.id===id)?.phase))throw Error('Step выполнен частично. Результаты сохранены; создайте новый workflow для оставшихся действий.');
  else{run.currentStage=boundary;run.status='paused';for(const s of run.steps)if(s.status==='blocked')s.status='waiting'}
  for(let i=0;i<run.currentStage;i++)run.stages[i].status='completed';persist(run);return run;
 }
 function control(id,change){
  const run=active.get(id);if(!run||run.status!=='running')throw Error('Запуск уже не выполняется');
  if(change.revision!==run.revision)throw Error('Ревизия запуска изменилась; обновите состояние');
  const stepId=change.pauseAfterCurrent?run.stages[run.currentStage]?.stepId:change.stepId;
  const index=run.stages.findIndex(s=>s.stepId===stepId),stage=run.stages[index],group=run.config.workflow.steps[index];
  if(!stage||index<run.currentStage||settledStates.has(stage.status))throw Error('Этот Step уже завершён');
  if(change.enabled!==undefined){
   if(typeof change.enabled!=='boolean'||stage.status!=='waiting')throw Error('Начавшийся Step нельзя включить или отключить');
   const updated=structuredClone(run.config.workflow);updated.steps[index].enabled=change.enabled;
   validateGraphRequests(updated,routes,{skipSteps:completedStepIds(run),readAsset});executionPreview(updated,compileGraph(updated),run.reusable||{},run.steps.filter(r=>settledStates.has(r.status)));
   group.enabled=stage.enabled=change.enabled;
  }
  if(change.continueOnSuccess!==undefined||change.pauseAfterCurrent){
   const value=change.pauseAfterCurrent?false:change.continueOnSuccess;
   if(typeof value!=='boolean')throw Error('Неверное значение Continue');group.continueOnSuccess=stage.continueOnSuccess=value;
  }
  run.controls||=[];run.controls.push({revision:run.revision,stepId,enabled:change.enabled,continueOnSuccess:group.continueOnSuccess,date:new Date().toISOString()});run.revision++;persist(run);return run;
 }
 return {start,recover,control,isActive:id=>active.has(id),getActive:id=>active.get(id)};
}
