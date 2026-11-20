import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,cpSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {editorToWorkflow} from '../public/graph.mjs';
const root=new URL('../',import.meta.url);

test('HTTP session: frozen outputs, one active run, controls, pause/resume, persisted reuse and compact polling',{timeout:15000},async()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'vr-session-'));let child;
 try{
  for(const name of ['server.mjs','engine.mjs','artifacts.mjs','graph-engine.mjs','webhooks.mjs','library.mjs','grok-cli.mjs','public'])cpSync(new URL(name,root),path.join(dir,name),{recursive:true});
  writeFileSync(path.join(dir,'fixture.mjs'),`import {appendFileSync} from 'node:fs';
  globalThis.fetch=async(url,init)=>{const p=JSON.parse(init.body||'{}'),u=String(url);appendFileSync(${JSON.stringify(path.join(dir,'calls'))},JSON.stringify({url:u,params:p})+'\\n');
  if(u.endsWith('/pricing/estimate'))return Response.json({estimated_cost_usd:.01,assumptions:{}});
  if(u.endsWith('/images')){await new Promise(r=>setTimeout(r,350));return Response.json({data:[{url:'https://fixture.invalid/image.png'}],usage:{cost:.01}})}
  if(u.endsWith('/videos'))return Response.json({id:'test-video',status:'completed',data:[{url:'https://fixture.invalid/video.mp4'}],cost_usd:.1});throw Error('Unexpected transport')};`);
  child=spawn(process.execPath,['--import',path.join(dir,'fixture.mjs'),path.join(dir,'server.mjs')],{env:{...process.env,PORT:'18794',VIDEOROUTER_API_KEY:'fixture',VIDEOROUTER_MANAGEMENT_KEY:''},stdio:['ignore','pipe','pipe']});
  await Promise.race([once(child.stdout,'data'),once(child,'exit').then(()=>{throw Error('Fixture server exited')})]);
  async function local(p,body,ok=true){const response=await fetch('http://127.0.0.1:18794/local/'+p,{method:body===undefined?'GET':'POST',headers:{'X-Studio':'1','Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const data=await response.json();assert.equal(response.ok,ok,JSON.stringify(data));return data}
  const w=editorToWorkflow({id:'session-flow',name:'Session',steps:[{id:'image',op:'POST /v1/images',params:{model:'gpt-image-1',prompt:'Teapot'},action:'text-to-image'},{id:'video',op:'POST /v1/videos',action:'reference-to-video',params:{model:'fal/seedance-2.0',prompt:'Animate',duration_secs:5},media:{input_references:{mode:'list',items:[{mode:'previous',stepId:'image',port:'images',index:0}]}}}],groups:[{id:'first',nodeIds:['image']},{id:'second',nodeIds:['video']}]});
  await local('workflow',w);const prepared=await local('prepare',{workflow:w}),first=await local('run',prepared);
  await local('prepare',{workflow:w},false);
  let state=await local('run/'+first.id+'/control',{revision:0,stepId:'second',enabled:false});assert.equal(state.revision,1);
  await local('run/'+first.id+'/control',{revision:0,pauseAfterCurrent:true},false);
  await local('run/'+first.id+'/control',{revision:1,pauseAfterCurrent:true});
  for(let i=0;i<50;i++){state=await local('run/'+first.id);if(state.status!=='running')break;await new Promise(r=>setTimeout(r,20))}
  assert.equal(state.status,'paused');assert.equal(state.steps[0].status,'completed');
  const compact=await local('run/'+first.id+'?view=workflow');assert.equal(compact.steps[0].request,undefined);assert.equal(compact.steps[0].result,undefined);assert.equal(compact.workflowId,w.id);
  const resume=await local('prepare',{workflow:state.config.workflow,runId:first.id,revision:state.revision});await local('run/'+first.id+'/resume',resume);
  state=await local('run/'+first.id);assert.equal(state.status,'completed');assert.equal(state.steps[1].status,'skipped');
  w.steps[0].enabled=false;w.steps[1].enabled=true;await local('workflow',w);
  const candidates=await local('workflow/'+w.id+'/outputs');assert.equal(candidates.nodes.image[0].runId,first.id);
  const reuse=await local('prepare',{workflow:w});assert.deepEqual(reuse.preview.map(n=>n.status),['reused','waiting']);
  const second=await local('run',reuse);
  for(let i=0;i<50;i++){state=await local('run/'+second.id);if(state.status!=='running')break;await new Promise(r=>setTimeout(r,20))}
  assert.equal(state.status,'completed',state.error);assert.equal(state.steps[0].reusedFrom.runId,first.id);assert.equal(state.steps[0].cost,0);assert.equal(state.steps[1].request.params.input_references.length,1);
  const calls=readFileSync(path.join(dir,'calls'),'utf8').trim().split('\n').map(JSON.parse);assert.equal(calls.filter(c=>c.url.endsWith('/images')).length,1);assert.equal(calls.filter(c=>c.url.endsWith('/videos')).length,1);
 }finally{if(child&&child.exitCode===null){child.kill('SIGTERM');await once(child,'exit')}rmSync(dir,{recursive:true,force:true})}
});

test('review pause: edit and run one Step, failed retry preserves output, choose old/new, resume exact selected input and retain costs',{timeout:15000},async()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'vr-review-'));let child;
 try{
  for(const name of ['server.mjs','engine.mjs','artifacts.mjs','graph-engine.mjs','webhooks.mjs','library.mjs','grok-cli.mjs','public'])cpSync(new URL(name,root),path.join(dir,name),{recursive:true});
  writeFileSync(path.join(dir,'fixture.mjs'),`import {appendFileSync} from 'node:fs';let count=0;
  globalThis.fetch=async(url,init)=>{const p=JSON.parse(init.body||'{}'),u=String(url);appendFileSync(${JSON.stringify(path.join(dir,'calls'))},JSON.stringify({url:u,params:p})+'\\n');
  if(u.endsWith('/pricing/estimate'))return Response.json({estimated_cost_usd:.01,assumptions:{}});
  if(u.endsWith('/images')){const index=++count;await new Promise(r=>setTimeout(r,70));if(p.prompt==='fail')return Response.json({error:{message:'Fixture failure'}},{status:500});return Response.json({data:[{url:'https://fixture.invalid/image-'+index+'.png'}],usage:{cost:.01}})}
  throw Error('Unexpected API')};`);
  child=spawn(process.execPath,['--import',path.join(dir,'fixture.mjs'),path.join(dir,'server.mjs')],{env:{...process.env,PORT:'18794',VIDEOROUTER_API_KEY:'fixture',VIDEOROUTER_MANAGEMENT_KEY:''},stdio:['ignore','pipe','pipe']});
  await Promise.race([once(child.stdout,'data'),once(child,'exit').then(()=>{throw Error('Fixture exited')})]);
  async function local(p,body,ok=true){const response=await fetch('http://127.0.0.1:18794/local/'+p,{method:body===undefined?'GET':'POST',headers:{'X-Studio':'1','Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const data=await response.json();assert.equal(response.ok,ok,JSON.stringify(data));return data}
  async function settled(id,status){for(let i=0;i<100;i++){const r=await local('run/'+id);if(r.status!=='running'){assert.equal(r.status,status,r.error);return r}await new Promise(r=>setTimeout(r,20))}throw Error('Run did not settle')}
  const w=editorToWorkflow({id:'review-flow',name:'Review',steps:[{id:'first-image',op:'POST /v1/images',action:'text-to-image',params:{model:'gpt-image-1',prompt:'Original'}},{id:'second-image',op:'POST /v1/images',action:'image-edit',params:{model:'gpt-image-1',prompt:'Edit'},media:{input_references:{mode:'list',items:[{mode:'previous',stepId:'first-image',port:'images',index:0}]}}}],groups:[{id:'first',nodeIds:['first-image'],continueOnSuccess:false},{id:'second',nodeIds:['second-image']}]});
  await local('workflow',w);
  const parent=await local('run',await local('prepare',{workflow:w})),paused=await settled(parent.id,'paused'),original=paused.steps[0].artifacts[0];
  // A disabled Step can be explicitly generated; an unfinished future card does not block it.
  w.steps[0].enabled=false;w.steps[0].nodes[0].parameters.prompt='Better';w.steps[1].nodes[0].parameters.prompt='';
  const request={workflow:w,stepId:'first',parentRunId:parent.id,parentRevision:paused.revision};
  const prepared=await local('prepare',request);assert.equal(prepared.plan.length,1);
  const attempt=await local('run',prepared);
  await local('prepare',{...request,parentRevision:99},false);
  const generated=await settled(attempt.id,'completed'),newOutput=generated.steps[0].artifacts[0];assert.notEqual(newOutput.url,original.url);
  const view=await local('run/'+attempt.id+'?view=workflow');assert.equal(view.scopeStepId,'first');assert.equal(view.parentRunId,parent.id);
  assert.equal((await local('run/'+parent.id)).status,'paused');
  // A failed manual generation leaves both successful outputs available and the parent paused.
  w.steps[0].nodes[0].parameters.prompt='fail';
  const failed=await local('run',await local('prepare',request));await settled(failed.id,'failed');
  assert.equal((await local('workflow/'+w.id+'/outputs')).nodes['first-image'].length,2);
  w.steps[0].nodes[0].parameters.prompt='Better';w.steps[1].nodes[0].parameters.prompt='Use the selected image';
  w.steps[0].nodes[0].reuse={mode:'pinned',runId:parent.id};
  let resume=await local('prepare',{workflow:w,runId:parent.id,revision:paused.revision});assert.equal(resume.preview[0].status,'completed');
  w.steps[0].nodes[0].reuse={mode:'pinned',runId:attempt.id};
  resume=await local('prepare',{workflow:w,runId:parent.id,revision:paused.revision});assert.equal(resume.preview[0].reusedFrom.runId,attempt.id);
  await local('run/'+parent.id+'/resume',resume);const finished=await settled(parent.id,'completed');
  assert.equal(finished.steps[1].request.params.input_references[0].image_url.url,newOutput.url);
  assert.equal(finished.carriedCost,.01);assert.equal(finished.cost,.02);assert.equal(finished.steps[0].cost,0);
  assert.equal(finished.revisions[0].steps.find(n=>n.id==='first-image').request.params.prompt,'Original');
  const outputs=await local('workflow/'+w.id+'/outputs');assert.equal(outputs.nodes['first-image'].length,2);assert.equal(outputs.nodes['first-image'].find(n=>n.runId===parent.id).parameters.prompt,'Original');
  // Standalone Step 2 consumes a selected old output; Step 1 is never regenerated.
  w.steps[0].enabled=true;w.steps[0].nodes[0].reuse={mode:'pinned',runId:parent.id};
  const standalone=await local('run',await local('prepare',{workflow:w,stepId:'second'}));const done=await settled(standalone.id,'completed');
  assert.equal(done.steps[0].status,'reused');assert.equal(done.steps[1].request.params.input_references[0].image_url.url,original.url);
  const calls=readFileSync(path.join(dir,'calls'),'utf8').trim().split('\n').map(JSON.parse).filter(c=>c.url.endsWith('/images'));
  assert.deepEqual(calls.map(c=>c.params.prompt),['Original','Better','fail','Use the selected image','Use the selected image']);
 }finally{if(child&&child.exitCode===null){child.kill('SIGTERM');await once(child,'exit')}rmSync(dir,{recursive:true,force:true})}
});
