import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createHmac} from 'node:crypto';
import {once} from 'node:events';
import {mkdtempSync,cpSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createWebhookBridge,createWebhookReceiver,applyWebhookCost,webhookURL} from '../webhooks.mjs';
import {createGraphRunner,graphRun,reviseRun,workflowForStep} from '../graph-engine.mjs';
import {editorToWorkflow} from '../public/graph.mjs';

const url='https://fixture.invalid/webhooks/videorouter',secret='whsec_offline_fixture_only';
const routes=new Map(JSON.parse(readFileSync(new URL('../public/catalog.json',import.meta.url))).routes.map(r=>[r.id,r]));
const video=(cost=.1,media='winner')=>({id:'video-one',status:'completed',data:[{url:'https://fixture.invalid/'+media+'.mp4'}],...(cost==null?{}:{cost_usd:cost})});
const waitFor=async predicate=>{for(let i=0;i<400;i++){if(predicate())return;await new Promise(r=>setTimeout(r,5))}throw Error('Condition timed out')};
function workflow(pause=false){return editorToWorkflow({id:'hook-flow',name:'Hooks',steps:[
 {id:'video',op:'POST /v1/videos',action:'text-to-video',params:{model:'fal/seedance-2.0',prompt:'Teapot',duration_secs:5}},
 {id:'image',op:'POST /v1/images',action:'text-to-image',params:{model:'gpt-image-1',prompt:'Next'}}
],groups:[{id:'first',nodeIds:['video'],continueOnSuccess:!pause},{id:'second',nodeIds:['image']}]})}
function fixture(options={}){
 const db=new DatabaseSync(':memory:'),calls=[],saved=new Map(),runs=new Map();let runner;
 const bridge=createWebhookBridge({db,settings:()=>({ready:true,url}),pollDelay:5,fetchStatus:options.costFetch,onCost:({runId,attemptId,cost})=>{
  const r=runner?.getActive(runId)||runs.get(runId);if(r&&applyWebhookCost(r,attemptId,cost))saved.set(r.id,structuredClone(r));
 }});
 const call=async(route,params)=>{
  calls.push({path:route.path,method:route.method,params});
  if(route.path==='/v1/pricing/estimate')return {data:{estimated_cost_usd:.1,assumptions:{}}};
  if(route.path==='/v1/videos')return options.create?options.create(params,bridge):{data:{id:'video-one',status:'queued'}};
  if(route.path==='/v1/videos/{id}')return options.get?options.get():{data:video(),cost:.1};
  if(route.path==='/v1/images')return {data:{data:[{url:'https://fixture.invalid/next.png'}]},cost:.02};
  throw Error('Unexpected request '+route.path);
 };
 runner=createGraphRunner({routes,call,webhooks:bridge,pollDelay:5,readAsset:()=>{},storeFile:()=>{},save:r=>saved.set(r.id,structuredClone(r))});
 const run=graphRun('Hooks',workflow(options.pause));runs.set(run.id,run);
 return {db,bridge,runner,run,runs,calls,saved,deliver:(data=video(),row=run.steps[0])=>bridge.accept(row.webhookAttempt,'video.'+data.status,data.id,JSON.stringify(data)),close:()=>{bridge.close();db.close()}};
}

test('webhook wins an in-flight poll: one next Step, immutable output, late GET supplies cost once',async()=>{
 let finishGET;const f=fixture({get:()=>new Promise(resolve=>finishGET=resolve)});
 try{
  const running=f.runner.start(f.run);await waitFor(()=>finishGET);
  assert.equal(f.deliver(video(null)),204);assert.equal(f.deliver(video(null)),204);
  await running;assert.equal(f.run.status,'completed');assert.equal(f.run.steps[0].artifacts[0].url,'https://fixture.invalid/winner.mp4');
  finishGET({data:video(.12,'poll-output'),cost:.12});await waitFor(()=>f.run.steps[0].cost===.12);
  assert.ok(Math.abs(f.run.cost-.14)<1e-9);assert.equal(f.run.steps[0].artifacts[0].url,'https://fixture.invalid/winner.mp4');
  assert.equal(f.calls.filter(c=>c.path==='/v1/images').length,1);assert.equal(f.calls.filter(c=>c.path==='/v1/videos').length,1);
  assert.equal(f.bridge.stats().received,1);assert.equal(f.run.status,'completed');
 }finally{f.close()}
});

test('polling still completes without webhook; a late conflicting notification never replaces output',async()=>{
 const f=fixture();try{
  await f.runner.start(f.run);assert.equal(f.run.status,'completed');
  const before=structuredClone(f.run);assert.equal(f.deliver(video(.9,'late')),204);
  assert.deepEqual(f.run,before);assert.equal(f.calls.filter(c=>c.path.endsWith('/{id}')).length,1);
 }finally{f.close()}
});

test('delivery before create response is persisted and consumed after job binding, with no extra POST',async()=>{
 const f=fixture({create:(params,bridge)=>{
  assert.equal(bridge.accept(params.webhook_url.split('/').pop(),'video.completed','video-one',JSON.stringify(video())),204);
  return {data:{id:'video-one',status:'queued'}};
 }});try{
  await f.runner.start(f.run);assert.equal(f.run.status,'completed');assert.equal(f.calls.filter(c=>c.path.endsWith('/{id}')).length,0);
  assert.equal(f.run.steps[0].request.params.webhook_url,url+'/'+f.run.steps[0].webhookAttempt);
 }finally{f.close()}
});

test('pause, manual Step rerun, archived price and disabled reuse survive duplicate/old deliveries',async()=>{
 const f=fixture({pause:true,create:(params,bridge)=>{
  bridge.accept(params.webhook_url.split('/').pop(),'video.completed','video-one',JSON.stringify(video(null)));
  return {data:{id:'video-one',status:'queued'}};
 }});try{
  await f.runner.start(f.run);assert.equal(f.run.status,'paused');assert.equal(f.calls.filter(c=>c.path==='/v1/images').length,0);
  const oldAttempt=f.run.steps[0].webhookAttempt;
  const separate=graphRun('One Step',workflowForStep(f.run.config.workflow,'first'));f.runs.set(separate.id,separate);
  await f.runner.start(separate);assert.equal(f.run.status,'paused');assert.notEqual(separate.steps[0].webhookAttempt,oldAttempt);
  const newOutput={...separate.steps[0].artifacts[0],url:'https://fixture.invalid/selected.mp4'};
  const changed=structuredClone(f.run.config.workflow);changed.steps[0].enabled=false;
  reviseRun(f.run,changed,{video:{runId:separate.id,artifacts:[newOutput],sourceCost:.1}});
  await f.runner.start(f.run);assert.equal(f.run.steps[0].status,'reused');assert.equal(f.run.steps[0].cost,0);
  f.bridge.claim({webhookAttempt:oldAttempt},{data:video(.15,'old'),cost:.15});
  assert.equal(f.run.steps[0].artifacts[0].url,newOutput.url);assert.equal(f.run.carriedCost,.15);assert.ok(Math.abs(f.run.cost-.17)<1e-9);
  assert.equal(f.run.status,'completed');assert.equal(f.calls.filter(c=>c.path==='/v1/videos').length,2);
  assert.equal(f.deliver(video(null),{webhookAttempt:oldAttempt}),204);assert.ok(Math.abs(f.run.cost-.17)<1e-9);
 }finally{f.close()}
});

test('signed failure stops the graph and never creates downstream requests',async()=>{
 const f=fixture({create:(params,bridge)=>{
  bridge.accept(params.webhook_url.split('/').pop(),'video.failed','video-one',JSON.stringify({id:'video-one',status:'failed',error:'provider failure',cost_usd:0}));
  return {data:{id:'video-one',status:'queued'}};
 }});try{await f.runner.start(f.run);assert.equal(f.run.status,'failed');assert.equal(f.run.steps[1].status,'blocked');assert.equal(f.run.cost,0);assert.equal(f.calls.filter(c=>c.path==='/v1/images').length,0)}finally{f.close()}
});

test('missing terminal cost is polled separately without repeating output or generation',async()=>{
 let polls=0;const f=fixture({costFetch:async()=>{polls++;return {data:video(.2,'different'),cost:.2}},create:(p,b)=>{
  b.accept(p.webhook_url.split('/').pop(),'video.completed','video-one',JSON.stringify(video(null)));return {data:{id:'video-one',status:'queued'}};
 }});try{
  await f.runner.start(f.run);await waitFor(()=>f.run.steps[0].cost===.2);
  assert.equal(polls,1);assert.equal(f.run.steps[0].artifacts[0].url,'https://fixture.invalid/winner.mp4');assert.ok(Math.abs(f.run.cost-.22)<1e-9);
  assert.equal(f.calls.filter(c=>c.path==='/v1/images').length,1);
 }finally{f.close()}
});

test('persistent inbox recovers an interrupted create with early delivery, without a new POST',async()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'vr-hook-recover-'));let db=new DatabaseSync(path.join(dir,'inbox.sqlite')),bridge;
 try{
  const run=graphRun('Recovery',workflow(true)),row=run.steps[0];
  bridge=createWebhookBridge({db,settings:()=>({ready:true,url})});
  bridge.prepare(run,row,routes.get(row.op),{});row.phase='submitting';row.status='running';run.status='interrupted';
  bridge.accept(row.webhookAttempt,'video.completed','video-one',JSON.stringify(video()));
  bridge.close();db.close();db=new DatabaseSync(path.join(dir,'inbox.sqlite'));
  bridge=createWebhookBridge({db,settings:()=>({ready:false})});bridge.restore();
  const runner=createGraphRunner({routes,webhooks:bridge,call:()=>{throw Error('Network forbidden during cached recovery')},save:()=>{},readAsset:()=>{},storeFile:()=>{}});
  await runner.recover(run);assert.equal(run.status,'paused');assert.equal(run.currentStage,1);assert.equal(row.remoteId,'video-one');assert.equal(row.status,'completed');
 }finally{bridge?.close();db.close();rmSync(dir,{recursive:true,force:true})}
});

test('receiver enforces raw HMAC, event/job matching, body limit and private UI isolation',async()=>{
 const f=fixture(),row=f.run.steps[0];let server;
 try{
  f.bridge.prepare(f.run,row,routes.get(row.op),{});row.remoteId='video-one';f.bridge.bind(row);
  server=createWebhookReceiver({bridge:f.bridge,secret:()=>secret});server.listen(0,'127.0.0.1');await once(server,'listening');
  const base='http://127.0.0.1:'+server.address().port,endpoint=base+'/webhooks/videorouter/'+row.webhookAttempt;
  const body=JSON.stringify(video()),signature=createHmac('sha256',secret).update(body).digest('hex');
  const send=(raw=body,headers={})=>fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json','X-VideoRouter-Signature':signature,'X-VideoRouter-Event':'video.completed','X-VideoRouter-Delivery':'video-one',...headers},body:raw});
  assert.equal((await send(body,{'X-VideoRouter-Signature':'0'.repeat(64)})).status,401);
  assert.equal((await send(body+' ')).status,401);assert.equal((await send(body,{'X-VideoRouter-Delivery':'wrong'})).status,400);
  assert.equal((await send()).status,204);assert.equal((await send()).status,204);assert.equal(f.bridge.stats().received,1);
  assert.equal((await fetch(base+'/local/state')).status,404);assert.equal((await fetch(base+'/')).status,404);assert.equal((await fetch(base+'/health')).status,200);
  const large=' '.repeat(2*1024*1024+1);assert.equal((await send(large)).status,413);
 }finally{if(server){server.closeAllConnections();await new Promise(r=>server.close(r))}f.close()}
});

test('only documented operations get callback URLs; explicit opt-out/custom callback preserved',()=>{
 const f=fixture();try{
  assert.throws(()=>webhookURL('http://127.0.0.1/webhooks/videorouter'));
  assert.throws(()=>webhookURL(url+'?secret=bad'));
  for(const p of ['/v1/images','/v1/audio/music','/v1/avatars/videos'])assert.deepEqual(f.bridge.prepare(f.run,{}, {method:'POST',path:p},{prompt:'x'}),{prompt:'x'});
  for(const custom of [null,'https://custom.invalid/hook'])assert.deepEqual(f.bridge.prepare(f.run,{},routes.get('POST /v1/videos'),{webhook_url:custom}),{webhook_url:custom});
 }finally{f.close()}
});

test('HTTP settings, signed completion, legacy API polling, secret privacy and restart recovery',{timeout:20000},async()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'vr-hook-http-')),root=new URL('../',import.meta.url);let child;
 const base='http://127.0.0.1:18804';
 async function launch(){
  child=spawn(process.execPath,['--import',path.join(dir,'fixture.mjs'),path.join(dir,'server.mjs')],{env:{...process.env,PORT:'18804',WEBHOOK_PORT:'0',VIDEOROUTER_API_KEY:'fixture',VIDEOROUTER_MANAGEMENT_KEY:'',VIDEOROUTER_WEBHOOK_ENABLED:'0',VIDEOROUTER_WEBHOOK_SECRET:'',VIDEOROUTER_WEBHOOK_URL:''},stdio:['ignore','pipe','pipe']});
  let errors='';child.stderr.on('data',d=>errors+=d);
  await Promise.race([once(child.stdout,'data'),once(child,'exit').then(()=>{throw Error('Server exited: '+errors)})]);
 }
 async function local(p,body){const r=await fetch(base+'/local/'+p,{method:body===undefined?'GET':'POST',headers:{'X-Studio':'1','Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const data=await r.json();assert.equal(r.ok,true,JSON.stringify(data));return data}
 async function stop(){const exited=once(child,'exit');child.kill();await exited;child=undefined}
 async function sendHook(port,callback,data){const body=JSON.stringify(data);return fetch('http://127.0.0.1:'+port+new URL(callback).pathname,{method:'POST',headers:{'X-VideoRouter-Signature':createHmac('sha256',secret).update(body).digest('hex'),'X-VideoRouter-Event':'video.completed','X-VideoRouter-Delivery':data.id},body})}
 try{
  for(const file of ['server.mjs','engine.mjs','graph-engine.mjs','webhooks.mjs','library.mjs','artifacts.mjs','public'])cpSync(new URL(file,root),path.join(dir,file),{recursive:true});
  writeFileSync(path.join(dir,'fixture.mjs'),`globalThis.fetch=async(url,init)=>{
   const u=String(url);if(u.endsWith('/pricing/estimate'))return Response.json({estimated_cost_usd:.1,assumptions:{}});
   if(u.endsWith('/videos'))return Response.json({id:'video-one',status:'queued'});
   if(u.endsWith('/videos/video-one'))return Response.json(${JSON.stringify(video())});
   if(u.endsWith('/images'))return Response.json({data:[{url:'https://fixture.invalid/image.png'}],usage:{cost:.02}});
   throw Error('Unexpected external transport '+u)};`);
  await launch();const state=await local('webhook',{enabled:true,url,secret});assert.equal(state.webhook.ready,true);assert.equal(JSON.stringify(state).includes(secret),false);
  const w=workflow(true),start=await local('run',await local('prepare',{workflow:w}));let r;
  for(let i=0;i<100;i++){r=await local('run/'+start.id);if(r.steps[0].remoteId)break;await new Promise(resolve=>setTimeout(resolve,5))}
  const callback=r.steps[0].request.params.webhook_url;
  assert.equal((await sendHook(state.webhook.port,callback,video())).status,204);
  for(let i=0;i<100;i++){r=await local('run/'+start.id);if(r.status==='paused')break;await new Promise(resolve=>setTimeout(resolve,5))}
  assert.equal(r.status,'paused');assert.equal(r.steps[0].status,'completed');assert.equal(r.steps[1].status,'waiting');
  // A new run interrupted before polling is recovered from an event delivered after restart.
  const w2=workflow(true);w2.id='restart-flow';const second=await local('run',await local('prepare',{workflow:w2}));let interrupted;
  for(let i=0;i<100;i++){interrupted=await local('run/'+second.id);if(interrupted.steps[0].remoteId)break;await new Promise(resolve=>setTimeout(resolve,5))}
  await stop();await launch();assert.equal((await local('run/'+start.id)).status,'paused');
  assert.equal((await local('run/'+second.id)).status,'interrupted');assert.equal((await local('state')).webhook.secretConfigured,false);
  const connected=await local('webhook',{enabled:true,url,secret});
  assert.equal((await sendHook(connected.webhook.port,interrupted.steps[0].request.params.webhook_url,video())).status,204);
  const recovered=await local('run/'+second.id+'/recover',{});assert.equal(recovered.status,'paused');assert.equal(recovered.steps[0].status,'completed');
  await local('webhook',{enabled:false,secret:''});
  const legacy=await local('run',await local('prepare',{steps:[{id:'api-video',op:'POST /v1/videos',params:{model:'fal/seedance-2.0',prompt:'Legacy'},wait:true}]}));
  for(let i=0;i<110;i++){r=await local('run/'+legacy.id);if(r.status!=='running')break;await new Promise(resolve=>setTimeout(resolve,50))}
  assert.equal(r.status,'completed');assert.equal(r.steps[0].request.params.webhook_url,undefined);assert.equal(r.cost,.1);
  await stop();assert.equal(readFileSync(path.join(dir,'data/studio.sqlite')).includes(Buffer.from(secret)),false);
 }finally{if(child)await stop();rmSync(dir,{recursive:true,force:true})}
});
