import {normalizeRequest,estimateRequest,supportsImageInput,assertContract,assertQuoteMatches,configureModelCatalog,configureOperations,compileGraph,operationFor} from './public/workflow-core.mjs';
import {graphRun,validateGraphRequests,reviseRun,createGraphRunner,workflowForStep,completedStepIds} from './graph-engine.mjs';
import {imageArtifacts,resolveArtifacts} from './artifacts.mjs';
import {outputCandidates,selectReusable,executionPreview} from './public/workflow-state.mjs';
import http from 'node:http';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {asyncPaths,buildRequest,execute,resolveFields,checkSteps,freshRun} from './engine.mjs';
import {createWebhookBridge,createWebhookReceiver,webhookURL,applyWebhookCost} from './webhooks.mjs';

const root=fileURLToPath(new URL('.',import.meta.url));
const port=Number(process.env.PORT||8791);
const dir=path.join(root,'data');
process.umask(0o077);
mkdirSync(path.join(dir,'files'),{recursive:true});
const db=new DatabaseSync(path.join(dir,'studio.sqlite'));
db.exec(`PRAGMA journal_mode=WAL;
 CREATE TABLE IF NOT EXISTS records(kind TEXT,id TEXT,body TEXT NOT NULL,PRIMARY KEY(kind,id));
 CREATE TABLE IF NOT EXISTS assets(id TEXT PRIMARY KEY,name TEXT,type TEXT);`);
const upsert=db.prepare('INSERT OR REPLACE INTO records VALUES(?,?,?)');
const list=db.prepare('SELECT body FROM records WHERE kind=? ORDER BY rowid DESC');
const one=db.prepare('SELECT body FROM records WHERE kind=? AND id=?');
const save=(kind,obj)=>upsert.run(kind,obj.id,JSON.stringify(obj));
const all=kind=>list.all(kind).map(row=>JSON.parse(row.body));
const get=(kind,id)=>JSON.parse(one.get(kind,id)?.body||'null');
const catalog=JSON.parse(readFileSync(path.join(root,'public/catalog.json')));
configureModelCatalog(catalog.models,get('account','models')?.models||[]);
configureOperations([...catalog.models,...(get('account','models')?.models||[])]);
const routes=new Map(catalog.routes.map(r=>[r.id,r]));
const keys={api:process.env.VIDEOROUTER_API_KEY||'',management:process.env.VIDEOROUTER_MANAGEMENT_KEY||''};
const webhookSaved=get('settings','webhook')||{};
let webhookSecret=process.env.VIDEOROUTER_WEBHOOK_SECRET||'';
let webhookConfig={enabled:process.env.VIDEOROUTER_WEBHOOK_ENABLED==='0'?false:process.env.VIDEOROUTER_WEBHOOK_ENABLED==='1'||webhookSaved.enabled||!!(process.env.VIDEOROUTER_WEBHOOK_URL&&webhookSecret),url:process.env.VIDEOROUTER_WEBHOOK_URL||webhookSaved.url||''};
const webhookPort=Number(process.env.WEBHOOK_PORT??port+1);
let webhookServer,webhookError='',webhookChanging=false;
const legacyActive=new Map();
const keyType=r=>/^\/v1\/(keys|usage)(\/|$)/.test(r.path)?'management':'api';
const privateResult=r=>r.path==='/v1/keys'&&r.method==='POST'||r.path==='/v1/live-video/tokens'||r.path==='/v1/live-video/sessions'&&r.method==='POST';
const transient=new Map(), sockets=new Map();
const confirmed=new Map();
for(const run of all('run')) if(run.status==='running'){
 run.status='interrupted';run.error='Сервер был остановлен. Проверьте сохранённый job ID перед новым запуском.';save('run',run);
}

function storeFile(bytes,name,type) {
 const id=randomUUID(); writeFileSync(path.join(dir,'files',id),bytes,{flag:'wx'});
 db.prepare('INSERT INTO assets VALUES(?,?,?)').run(id,path.basename(name),type);
 return {file:id,name:path.basename(name),type,bytes:bytes.length,local_url:'/asset/'+id};
}
function readAsset(id) {
 const asset=db.prepare('SELECT * FROM assets WHERE id=?').get(String(id));
 if(!asset) throw Error('Локальный файл не найден');
 return {...asset,bytes:readFileSync(path.join(dir,'files',asset.id))};
}
function credential(route) {
 const key=keys[keyType(route)]; if(!key) throw Error('Подключите '+(keyType(route)==='api'?'API':'management')+' ключ в настройках');
 return key;
}
async function call(route,params,onEvent) {
 return execute({route,params,key:credential(route),readFile:readAsset,storeFile,onEvent});
}
function workflowRunView(run){
 return {id:run.id,name:run.name,status:run.status,revision:run.revision,currentStage:run.currentStage,cost:run.cost,error:run.error,created:run.created,stages:run.stages,workflowId:run.config?.workflow?.id,scopeStepId:run.scopeStepId,parentRunId:run.parentRunId,
  steps:run.steps.map(({id,sourceStepId,status,artifacts,reusedFrom,cost,reason,error,omitted,remoteStatus})=>({id,sourceStepId,status,artifacts,reusedFrom,cost,reason,error,omitted,remoteStatus}))};
}
function workflowOutputs(id){
 const runs=all('run').filter(r=>r.version===2&&r.config?.workflow?.id===id).sort((a,b)=>b.created.localeCompare(a.created));
 const workflow=get('flow',id)||runs[0]?.config.workflow;
 const nodeIds=new Set([...(workflow?.steps.flatMap(s=>s.nodes)||[]),...runs.flatMap(r=>r.config.workflow.steps.flatMap(s=>s.nodes))].map(n=>n.id));
 const nodes={};for(const nodeId of nodeIds)nodes[nodeId]=outputCandidates(runs,id,nodeId).map(({result,...candidate})=>candidate);
 return {workflowId:id,nodes,activeRunId:(runs.find(r=>r.status==='running')||runs.find(r=>r.status==='paused'))?.id,lastRunId:runs[0]?.id,lastStepRunId:runs.find(r=>r.scopeStepId)?.id};
}
function requireIdleWorkflow(id){if(all('run').some(r=>r.status==='running'&&r.config?.workflow?.id===id))throw Error('У этого workflow уже есть активный запуск')}
function stepParent(config){
 if(!config.parentRunId)return;
 const parent=get('run',config.parentRunId);
 if(!config.stepId||!parent||parent.status!=='paused'||parent.revision!==config.parentRevision||parent.config?.workflow?.id!==config.workflow.id)throw Error('Состояние паузы изменилось; обновите workflow');
 return parent;
}
const webhooks=createWebhookBridge({db,settings:()=>({url:webhookConfig.url,ready:webhookConfig.enabled&&!!webhookSecret&&!!webhookServer?.listening}),fetchStatus:(p,id)=>call(routes.get('GET '+p+'/{id}'),{id}),onCost:({runId,attemptId,cost})=>{
 const run=graphRunner.getActive(runId)||legacyActive.get(runId)||get('run',runId);
 if(run&&applyWebhookCost(run,attemptId,cost))save('run',run);
}});
const graphRunner=createGraphRunner({routes,call,webhooks,save:run=>save('run',run),readAsset,storeFile,readResult:(run,row)=>transient.get(run.id+':'+run.steps.indexOf(row))??row?.result,privateOutput:(run,row,route,data)=>{
 if(!privateResult(route))return false;transient.set(run.id+':'+run.steps.indexOf(row),data);return true;
}});
function progress(run,step,charge) {
 if(typeof charge==='number'&&Number.isFinite(charge)) step.cost=charge;
 const prices=run.steps.map(s=>s.cost).filter(v=>typeof v==='number');
 run.cost=prices.length?prices.reduce((a,b)=>a+b,0):null;
 save('run',run);
}
async function work(run,steps) {
 legacyActive.set(run.id,run);
 const outputs=[],artifacts=new Map();
 try {
  for (const [index,input] of steps.entries()) {
   const step=run.steps[index], route=routes.get(input.op);
   step.status='running';save('run',run);
   let params=normalizeRequest(input.op,resolveArtifacts(resolveFields(input.params,outputs),artifacts,readAsset));
   if(input.contractMode)assertContract({...input,action:input.contractMode},params,{complete:true,facts:input.quoteFacts});
   if(input.quoteBeforeRun){
    const request=estimateRequest(input.op,params,input.quoteFacts);
    const quote=await call(routes.get('POST /v1/pricing/estimate'),request);
    step.estimate={request,response:quote.data};save('run',run);
    assertQuoteMatches(params,quote.data);
   }
   params=webhooks.prepare(run,step,route,params);
   step.request={op:input.op,params:structuredClone(params),wait:!!input.wait};save('run',run);
   let res=await call(route,params,chunk=>{step.lastEvent=chunk;save('run',run)});
   if (typeof res.data?.id==='string') step.remoteId=res.data.id;
   progress(run,step,res.cost);
   webhooks.bind(step);
   if(input.wait && route.method==='POST' && asyncPaths.has(route.path)) {
    if(!step.remoteId) throw Error('Сервис не вернул job ID');
    const until=Date.now()+(route.path==='/v1/batches'||route.path==='/v1/jobs'?25:1)*3600000;
    res=webhooks.claim(step,res);
    while (!['completed','succeeded','success'].includes(res.data?.status)) {
     progress(run,step,res.cost);
     step.remoteStatus=res.data?.status;save('run',run);
     if(['failed','cancelled','canceled','expired','error'].includes(step.remoteStatus)) throw Error(JSON.stringify(res.data.error||step.remoteStatus));
     if(Date.now()>until) throw Error('Истекло время ожидания. ID сохранён для запроса статуса.');
     res=await webhooks.next(step,route.path==='/v1/batches'?15000:4000,()=>call(routes.get('GET '+route.path+'/{id}'),{id:step.remoteId}));
     progress(run,step,res.cost);
    }
   }
   if(input.op==='POST /v1/images'){
    step.artifacts=imageArtifacts(res.data,run.id,input.sourceStepId||input.id,storeFile);
    artifacts.set(input.sourceStepId||input.id,step.artifacts);
   }
   outputs.push(res.data);
   if(privateResult(route)){
    transient.set(run.id+':'+index,res.data);step.result={message:'Ответ доступен в памяти текущего сервера.'};
   }else step.result=res.data;
   step.status='completed';progress(run,step,res.cost);
  }
  run.status='completed';
 }catch(e){
  run.status='failed';run.error=e.message;
  const step=run.steps.find(s=>s.status==='running');if(step){step.status='failed';step.error=e.message}
  for(const pending of run.steps.filter(s=>s.status==='waiting')){pending.status='blocked';pending.error='Предыдущий шаг завершился ошибкой. Повторная генерация автоматически не выполняется.'}
 }finally{legacyActive.delete(run.id);save('run',run)}
}
function brief(r) {
 return {id:r.id,name:r.name,created:r.created,status:r.status,cost:r.cost,steps:r.steps.map(({op,status,remoteId})=>({op,status,remoteId}))};
}
const meta=()=>({keys:{api:!!keys.api,management:!!keys.management},webhook:{...webhookConfig,secretConfigured:!!webhookSecret,ready:webhookConfig.enabled&&!!webhookSecret&&!!webhookServer?.listening,port:webhookServer?.address()?.port??webhookPort,error:webhookError,...webhooks.stats()},flows:all('flow'),runs:all('run').map(brief),account:get('account','wallet'),modelCache:get('account','models')?.date});
async function ensureWebhookReceiver(){
 if(webhookServer?.listening)return;
 const candidate=createWebhookReceiver({bridge:webhooks,secret:()=>webhookConfig.enabled?webhookSecret:''});
 await new Promise((resolve,reject)=>{
  const fail=error=>{webhookError=error.message;reject(error)};
  candidate.once('error',fail);candidate.listen(webhookPort,'127.0.0.1',()=>{candidate.off('error',fail);candidate.on('error',error=>{webhookError=error.message});resolve()});
 });
 webhookServer=candidate;webhookError='';
}
async function configureWebhook(body){
 if(webhookChanging)throw Error('Настройка webhook уже выполняется');webhookChanging=true;
 try{
  const enabled=body.enabled===true,url=enabled?webhookURL(body.url):webhookConfig.url;
  const secret=typeof body.secret==='string'?body.secret.trim():webhookSecret;
  if(enabled&&!secret)throw Error('Введите webhook secret из VideoRouter → Org admin → Webhooks');
  if(enabled)await ensureWebhookReceiver();
  webhookConfig={enabled,url};webhookSecret=secret;
  save('settings',{id:'webhook',...webhookConfig});
  if(!enabled&&webhookServer){webhookServer.close();webhookServer=undefined}
 }finally{webhookChanging=false}
}
async function buffer(req,max=3*1024*1024) {
 const chunks=[];let n=0;
 for await (const c of req){n+=c.length;if(n>max)throw Error('Превышен размер запроса');chunks.push(c)}
 return Buffer.concat(chunks);
}
function send(res,obj,code=200){res.writeHead(code,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(obj))}
function startSocket(params){
 const route=routes.get('WS /v1/realtime');
 const {url,init}=buildRequest(route,params,credential(route),readAsset);url.protocol='wss:';url.pathname='/v1/realtime';
 const ws=new WebSocket(url,{headers:init.headers}),id=randomUUID();
 const s={ws,status:'connecting',events:[],seq:0,lastSeen:Date.now()};
 const idle=setInterval(()=>{if(Date.now()-s.lastSeen>45000)ws.close()},10000);idle.unref();sockets.set(id,s);
 const log=(type,data)=>{s.events.push({seq:++s.seq,type,data});if(s.events.length>100)s.events.shift()};
 ws.onopen=()=>{s.status='open';log('open','')};
 ws.onmessage=e=>log('message',typeof e.data==='string'?e.data.slice(0,16000):'[binary]');
 ws.onerror=()=>log('error','Ошибка соединения с VideoRouter');
 ws.onclose=e=>{clearInterval(idle);s.status='closed';log('close',e.code+' '+e.reason);setTimeout(()=>sockets.delete(id),300000).unref()};
 return {id};
}
const staticFiles={'/':'index.html','/app.js':'app.js','/workflow-core.mjs':'workflow-core.mjs','/contracts.mjs':'contracts.mjs','/graph.mjs':'graph.mjs','/workflow-state.mjs':'workflow-state.mjs','/operations.mjs':'operations.mjs','/style.css':'style.css','/catalog.json':'catalog.json'};
const server=http.createServer(async(req,res)=>{
 try{
  const host=req.headers.host;
  if(!['127.0.0.1:'+port,'localhost:'+port].includes(host))return send(res,{error:'Local host required'},403);
  const base='http://'+host,url=new URL(req.url,base),p=url.pathname;
  res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Cache-Control','no-store');
  res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: https:; media-src 'self' https:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
  if(req.method==='GET'&&staticFiles[p]){
   const f=staticFiles[p];res.setHeader('Content-Type',({'html':'text/html; charset=utf-8','js':'application/javascript','mjs':'application/javascript','css':'text/css','json':'application/json'})[f.split('.').pop()]);return res.end(readFileSync(path.join(root,'public',f)));
  }
  if(req.method==='GET' && p.startsWith('/asset/')){
   const f=readAsset(p.slice(7));res.setHeader('Content-Type',/^(audio|video|image)\/[a-z0-9.+-]+$/i.test(f.type)&&f.type!=='image/svg+xml'?f.type:'application/octet-stream');res.setHeader('Content-Disposition',"attachment; filename*=UTF-8''"+encodeURIComponent(f.name));return res.end(f.bytes);
  }
  if(req.headers['x-studio']!=='1'||(req.headers.origin&&req.headers.origin!==base))return send(res,{error:'Local UI required'},403);
  if(req.method==='GET'){
   if(p==='/local/state')return send(res,meta());
   if(p==='/local/models')return send(res,get('account','models')?.models||[]);
   const outputPath=/^\/local\/workflow\/([^/]+)\/outputs$/.exec(p);if(outputPath)return send(res,workflowOutputs(outputPath[1]));
   if(p.startsWith('/local/run/')){
    const r=get('run',p.split('/').pop());if(!r)return send(res,{error:'Запуск не найден'},404);
    if(url.searchParams.get('view')==='workflow')return send(res,workflowRunView(r));
    r.steps.forEach((s,i)=>{s.result=transient.get(r.id+':'+i)??s.result});return send(res,r);
   }
   if(p.startsWith('/local/socket/')){const s=sockets.get(p.split('/').pop());if(!s)throw Error('Сессия закрыта');s.lastSeen=Date.now();return send(res,{status:s.status,events:s.events})}
  }
  if(req.method!=='POST')return send(res,{error:'Not found'},404);
  if(p==='/local/file'){
   const name=url.searchParams.get('name')||'file';const bytes=await buffer(req,200*1024*1024);
   return send(res,storeFile(bytes,name,req.headers['content-type']||'application/octet-stream'));
  }
  const body=JSON.parse((await buffer(req)).toString()||'{}');
  if(p==='/local/keys'){
   for(const k of ['api','management'])if(typeof body[k]==='string')keys[k]=body[k].trim();return send(res,meta());
  }
  if(p==='/local/webhook'){await configureWebhook(body);return send(res,meta())}
  if(p==='/local/account'||p==='/local/sync-models'){
   const wallet=p==='/local/account', r=await call(routes.get(wallet?'GET /v1/balance':'GET /v1/models'),{});
   const date=new Date().toISOString();
   if(wallet)save('account',{id:'wallet',date,...r.data});
   else{if(!Array.isArray(r.data?.data))throw Error('Неизвестный формат каталога');save('account',{id:'models',date,models:r.data.data});configureModelCatalog(catalog.models,r.data.data);configureOperations([...catalog.models,...r.data.data])}
   return send(res,meta());
  }
  if(p==='/local/workflow'){
   if(body.version===2){const f=compileGraph(body,{allowEmpty:true}).workflow;const existing=get('flow',f.id);if(existing&&existing.version!==2)f.id=randomUUID();save('flow',f);return send(res,f)}
   checkSteps(body.steps,routes);const f={id:body.id||randomUUID(),name:String(body.name||'Workflow').slice(0,150),steps:body.steps};save('flow',f);return send(res,f);
  }
  if(p==='/local/prepare'){
   if(body.workflow?.version===2){
    if(body.stepId&&body.runId)throw Error('Запуск Step и продолжение workflow — разные действия');
    const run=body.runId?get('run',body.runId):null;
    if(body.runId&&(!run||run.revision!==body.revision))throw Error('Ревизия запуска изменилась');
    stepParent(body);requireIdleWorkflow(body.workflow.id);
    const plan=validateGraphRequests(body.stepId?workflowForStep(body.workflow,body.stepId):body.workflow,routes,{skipSteps:run?completedStepIds(run):new Set()}),reusable=selectReusable(plan.workflow,all('run'),readAsset);
    let existing=[];
    if(run){const revised=structuredClone(run);reviseRun(revised,plan.workflow,reusable);existing=revised.steps}
    const preview=executionPreview(plan.workflow,plan,reusable,existing);
    for(const g of plan.workflow.steps)for(const n of g.nodes)if(preview.find(r=>r.id===n.id)?.status==='waiting')credential(routes.get(n.op||operationFor(n).op));
    const ticket=randomUUID();confirmed.set(ticket,{...body,workflow:plan.workflow,reusable});setTimeout(()=>confirmed.delete(ticket),120000).unref();return send(res,{ticket,plan:plan.stages,preview:preview.map(({id,status,reason,reusedFrom,omitted})=>({id,status,reason,reusedFrom,omitted}))});
   }
   if(body.ws){credential(routes.get('WS /v1/realtime'))}
   else{checkSteps(body.steps,routes);for(const s of body.steps){
    credential(routes.get(s.op));
    if(s.contractMode)assertContract({...s,action:s.contractMode},s.params,{complete:true,facts:s.quoteFacts});
    if(s.params.start_image_url?.$artifact&&!supportsImageInput(s.params.model,[...(get('account','models')?.models||[]),...catalog.models]))throw Error('Поддержка стартового изображения моделью не подтверждена');
   }}
   const ticket=randomUUID();confirmed.set(ticket,body);setTimeout(()=>confirmed.delete(ticket),120000).unref();return send(res,{ticket});
  }
  if(p==='/local/run'){
   const config=confirmed.get(body.ticket);if(!config)throw Error('Подтвердите актуальную конфигурацию запуска');confirmed.delete(body.ticket);
   if(config.ws)return send(res,startSocket(config.params));
   if(config.workflow?.version===2){if(config.runId)throw Error('Используйте продолжение запуска');requireIdleWorkflow(config.workflow.id);stepParent(config);const r=graphRun(config.name,config.workflow,config.reusable);if(config.stepId){r.scopeStepId=config.stepId;r.parentRunId=config.parentRunId}save('run',r);void graphRunner.start(r);return send(res,brief(r),202)}
   const r=freshRun(config.name||config.steps[0].op,config.steps,config.workflow);save('run',r);void work(r,config.steps);return send(res,brief(r),202);
  }
  const graphAction=/^\/local\/run\/([^/]+)\/(resume|recover|control)$/.exec(p);
  if(graphAction){
   const r=get('run',graphAction[1]);if(!r||r.version!==2)throw Error('Запуск графа не найден');
   if(graphAction[2]==='control')return send(res,workflowRunView(graphRunner.control(r.id,body)));
   if(graphAction[2]==='recover'){const updated=await graphRunner.recover(r);return send(res,updated)}
   const config=confirmed.get(body.ticket);if(!config||config.runId!==r.id||config.revision!==r.revision)throw Error('Подтвердите актуальное продолжение');
   if(graphRunner.isActive(r.id))throw Error('Запуск уже выполняется');confirmed.delete(body.ticket);requireIdleWorkflow(config.workflow.id);reviseRun(r,config.workflow,config.reusable);save('run',r);void graphRunner.start(r);return send(res,brief(r),202);
  }
  if(p==='/local/socket'){
   const s=sockets.get(body.id);if(!s)throw Error('Сессия не найдена');
   if(body.close)s.ws.close();else{if(s.status!=='open')throw Error('Соединение ещё не открыто');JSON.parse(body.event);s.ws.send(body.event)}
   return send(res,{ok:true});
  }
  send(res,{error:'Not found'},404);
 }catch(e){send(res,{error:e.message},400)}
});
webhooks.restore();
if(webhookConfig.enabled&&webhookSecret){try{webhookConfig.url=webhookURL(webhookConfig.url);await ensureWebhookReceiver()}catch(error){webhookError=error.message}}
server.listen(port,'127.0.0.1',()=>console.log('VideoRouter API UI    http://127.0.0.1:'+port));
